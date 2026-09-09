"""
The Authorization Gate — v6 §10.2, closing G7.

────────────────────────────────────────────────────────────────────────────
WHY VOICE CANNOT BE AN AUTHORIZATION

v5's gate was: "AI must receive verbal 'Yes, approved' from designated UID."

The channel carries audio, and audio can be produced by anything — a laptop
playing a recording, another participant imitating a phrase, a TTS clip in a
shared screen. There is no binding between "the words 'yes, approved' appeared
on UID 1001's stream" and "the human who owns UID 1001 intended to authorize
THIS SPECIFIC ACTION".

So voice is demoted to an INTENT SIGNAL. It is logged, and it authorizes
nothing. The authorization itself is a nonce-bound, TTL-limited token redeemed
by a UI click from an authorized role. Two independent channels must agree.

Five properties make it hold:

  1. NONCE          single use; a replayed approval fails
  2. TTL            120s; a stale approval cannot be banked for later
  3. argsHash       binds approval to THESE EXACT arguments, so an approval
                    for a read cannot be redeemed for a failover
  4. ROLE BINDING   the redeeming session's uid must carry authorized:true
  5. TWO CHANNELS   spoofing requires compromising the audio channel AND an
                    authenticated dashboard session

Recorded audio saying "yes, approved" now accomplishes exactly nothing.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Literal

log = logging.getLogger("echo.authz")

APPROVAL_TTL_SECONDS = 120.0

Outcome = Literal["APPROVED", "DENIED", "EXPIRED", "REPLAYED", "WRONG_ROLE", "ARGS_MISMATCH", "UNKNOWN"]


def args_hash(args: dict[str, Any]) -> str:
    """
    Stable hash of the arguments an approval is bound to.

    `sort_keys` matters: without it {"a":1,"b":2} and {"b":2,"a":1} hash
    differently, and an approval would spuriously fail to redeem against
    arguments that are in fact identical.
    """
    canonical = json.dumps(args, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()


@dataclass
class Approval:
    nonce: str
    action_id: str
    action: str
    args: dict[str, Any]
    args_hash: str
    required_role: str
    issued_at: float
    ttl: float = APPROVAL_TTL_SECONDS

    redeemed: bool = False
    redeemed_by: int | None = None
    outcome: Outcome | None = None

    def expired(self, now: float) -> bool:
        return (now - self.issued_at) > self.ttl

    def to_wire(self) -> dict[str, Any]:
        """
        What the dashboard modal shows.

        The nonce IS included — the browser must send it back to redeem. It is
        not a secret in the credential sense: it is single-use, expires in two
        minutes, and is worthless without an authenticated session belonging to
        an authorized role.
        """
        return {
            "nonce": self.nonce,
            "actionId": self.action_id,
            "action": self.action,
            "args": self.args,
            "requiredRole": self.required_role,
            "issuedAt": int(self.issued_at * 1000),
            "expiresAt": int((self.issued_at + self.ttl) * 1000),
        }


@dataclass
class AuditEntry:
    at: float
    actor: int | None
    action: str
    outcome: Outcome
    detail: str = ""

    def to_wire(self) -> dict[str, Any]:
        return {
            "at": int(self.at * 1000),
            "actor": self.actor,
            "action": self.action,
            "outcome": self.outcome,
            "detail": self.detail,
        }


@dataclass
class AuthorizationGate:
    """
    Mints and redeems approvals, and keeps the audit trail.

    The audit log is deliberately append-only and records DENIALS and failed
    redemptions as loudly as successes — §10.3 wants it usable as governance
    evidence, and a log that only contains successes is evidence of nothing.
    """

    pending: dict[str, Approval] = field(default_factory=dict)
    audit: list[AuditEntry] = field(default_factory=list)

    # -- minting -----------------------------------------------------------

    def mint(
        self,
        *,
        action: str,
        args: dict[str, Any],
        required_role: str,
        action_id: str | None = None,
        now: float | None = None,
    ) -> Approval:
        t = now if now is not None else time.time()
        approval = Approval(
            # token_urlsafe, not a counter or a uuid4 hex: this is a security
            # token and must not be guessable from a previous one.
            nonce=secrets.token_urlsafe(24),
            action_id=action_id or f"act-{int(t * 1000)}",
            action=action,
            args=args,
            args_hash=args_hash(args),
            required_role=required_role,
            issued_at=t,
        )
        self.pending[approval.nonce] = approval
        self._log(t, None, action, "UNKNOWN", "approval minted, awaiting redemption")
        log.info("authz: minted approval for %s (role %s)", action, required_role)
        return approval

    # -- voice is not authorization ---------------------------------------

    def record_verbal_intent(self, uid: int, phrase: str, *, now: float | None = None) -> None:
        """
        Log a spoken "yes, approved" and do NOTHING else.

        This method exists to make the architecture's central security claim
        legible in code: there is no path from here to a redemption. Someone
        reading this file looking for the voice-approval shortcut will find
        only a log line.
        """
        t = now if now is not None else time.time()
        self._log(t, uid, "verbal-intent", "UNKNOWN", f"heard {phrase!r} — logged as intent, not authorization")
        log.info("authz: verbal intent from uid %s — authorizes nothing", uid)

    # -- redemption --------------------------------------------------------

    def redeem(
        self,
        nonce: str,
        uid: int,
        role: str,
        *,
        authorized: bool,
        args: dict[str, Any] | None = None,
        now: float | None = None,
    ) -> tuple[bool, Outcome]:
        """
        Redeem an approval from an authenticated dashboard session.

        Every rejection path is distinct and audited, because "it did not work"
        is useless during an incident and useless in a post-mortem.
        """
        t = now if now is not None else time.time()
        approval = self.pending.get(nonce)

        if approval is None:
            self._log(t, uid, "unknown", "UNKNOWN", "no such approval")
            return False, "UNKNOWN"

        if approval.redeemed:
            # Property 1. A replayed approval fails — this is the one that makes
            # a captured nonce worthless.
            approval.outcome = "REPLAYED"
            self._log(t, uid, approval.action, "REPLAYED", "nonce already used")
            return False, "REPLAYED"

        if approval.expired(t):
            approval.outcome = "EXPIRED"
            self._log(t, uid, approval.action, "EXPIRED", f"older than {approval.ttl:.0f}s")
            return False, "EXPIRED"

        if not authorized or role != approval.required_role:
            # Property 4. Being on the bridge is not the same as being allowed
            # to approve.
            approval.outcome = "WRONG_ROLE"
            self._log(t, uid, approval.action, "WRONG_ROLE",
                      f"{role!r} cannot approve; needs {approval.required_role!r}")
            return False, "WRONG_ROLE"

        if args is not None:
            # Property 3. compare_digest, not ==, so the check cannot be probed
            # by timing.
            if not hmac.compare_digest(args_hash(args), approval.args_hash):
                approval.outcome = "ARGS_MISMATCH"
                self._log(t, uid, approval.action, "ARGS_MISMATCH",
                          "arguments differ from those approved")
                return False, "ARGS_MISMATCH"

        approval.redeemed = True
        approval.redeemed_by = uid
        approval.outcome = "APPROVED"
        self._log(t, uid, approval.action, "APPROVED", "two-channel authorization complete")
        log.info("authz: %s APPROVED by uid %s", approval.action, uid)
        return True, "APPROVED"

    def deny(self, nonce: str, uid: int, *, now: float | None = None) -> bool:
        """
        An explicit human "no".

        §W5: Echo acknowledges and does NOT retry. Marking the approval
        redeemed is what makes that structural rather than a prompt instruction
        — there is no token left to redeem.
        """
        t = now if now is not None else time.time()
        approval = self.pending.get(nonce)
        if approval is None or approval.redeemed:
            return False

        approval.redeemed = True
        approval.redeemed_by = uid
        approval.outcome = "DENIED"
        self._log(t, uid, approval.action, "DENIED", "human declined")
        return True

    def expire_stale(self, *, now: float | None = None) -> int:
        t = now if now is not None else time.time()
        stale = [n for n, a in self.pending.items() if not a.redeemed and a.expired(t)]
        for nonce in stale:
            self.pending[nonce].outcome = "EXPIRED"
            self._log(t, None, self.pending[nonce].action, "EXPIRED", "expired unredeemed")
        return len(stale)

    def _log(self, at: float, actor: int | None, action: str, outcome: Outcome, detail: str) -> None:
        self.audit.append(AuditEntry(at=at, actor=actor, action=action, outcome=outcome, detail=detail))
