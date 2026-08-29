"""
The Proxy Action Layer — v6 §4.5.

Echo has no infrastructure access. It has access to a PROXY that speaks the
vocabulary of infrastructure and writes tickets.

    READ      query_incident_state, lookup_runbook      execute freely
    ADVISORY  create_jira_ticket, post_slack_update     idempotent, no gate
    CRITICAL  page_oncall_team, execute_runbook_script  Authorization Gate

────────────────────────────────────────────────────────────────────────────
THE LOAD-BEARING DETAIL

**Even an APPROVED critical action does not execute infrastructure.**

`execute_runbook_script("failover-redis")` becomes a Jira ticket in
PENDING_APPROVAL and a Slack message to the on-call channel. A human still
performs the failover. Echo's authority ends at *filing the request with a
complete evidence trail attached* — which is both what the problem statement
asks for and what makes the blast radius genuinely zero rather than merely
small.

There is no code path from here to production. Not a guarded one — an absent
one. `_execute` files records; it does not act.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from .authorization import AuthorizationGate

log = logging.getLogger("echo.proxy")

Tier = Literal["READ", "ADVISORY", "CRITICAL"]

# The classification is a property of the ACTION, never of how it was
# requested. §14.4: a prompt injection that talks Echo into calling
# execute_runbook_script still lands in the CRITICAL row.
TIERS: dict[str, Tier] = {
    "query_incident_state": "READ",
    "lookup_runbook": "READ",
    "create_jira_ticket": "ADVISORY",
    "post_slack_update": "ADVISORY",
    "page_oncall_team": "CRITICAL",
    "execute_runbook_script": "CRITICAL",
}

# Only this role may approve. An allow-list, so adding a participant type can
# never accidentally grant authority.
AUTHORIZED_ROLE = "DevOps Lead"


def idempotency_key(channel: str, task: str, action: str) -> str:
    """
    sha256(channel ‖ task ‖ action) — v6 R3.

    Tool calls are retried: by the model, by a flaky network, by an operator
    clicking twice. Without this, a retried injection files DUPLICATE Jira
    tickets, and during an incident duplicate tickets are actively harmful —
    two people work the same item and nobody works the next one.
    """
    return hashlib.sha256(f"{channel}‖{task}‖{action}".encode()).hexdigest()


@dataclass
class ActionResult:
    status: Literal["EXECUTED", "PENDING_APPROVAL", "DEDUPED", "DENIED", "REJECTED"]
    action: str
    tier: Tier
    detail: str = ""
    ref: str | None = None
    approval: dict[str, Any] | None = None


@dataclass
class ProxyActionLayer:
    channel: str
    gate: AuthorizationGate = field(default_factory=AuthorizationGate)

    # idempotency key -> the result we already produced
    _seen: dict[str, ActionResult] = field(default_factory=dict)
    _filed: list[dict[str, Any]] = field(default_factory=list)

    def classify(self, action: str) -> Tier:
        """
        Unknown actions are CRITICAL, not READ.

        Failing closed on an unrecognised name means a tool added later without
        a tier entry gets gated rather than silently executed — the safe
        direction for a mistake to point.
        """
        return TIERS.get(action, "CRITICAL")

    def invoke(
        self,
        action: str,
        args: dict[str, Any],
        *,
        task: str = "",
        evidence: list[str] | None = None,
        now: float | None = None,
    ) -> ActionResult:
        tier = self.classify(action)
        t = now if now is not None else time.time()

        if tier == "READ":
            return ActionResult("EXECUTED", action, tier, "read-only")

        key = idempotency_key(self.channel, task or action, action)
        if key in self._seen:
            prior = self._seen[key]
            log.info("proxy: deduped %s", action)
            return ActionResult("DEDUPED", action, tier, "identical call already handled", prior.ref)

        if tier == "ADVISORY":
            result = self._file(action, args, tier, evidence)
            self._seen[key] = result
            return result

        # CRITICAL — mint an approval and stop. Nothing is filed yet.
        approval = self.gate.mint(
            action=action, args=args, required_role=AUTHORIZED_ROLE, now=t,
        )
        return ActionResult(
            "PENDING_APPROVAL", action, tier,
            "requires dashboard approval; voice cannot authorize this",
            approval=approval.to_wire(),
        )

    def redeem(
        self,
        nonce: str,
        uid: int,
        role: str,
        *,
        authorized: bool,
        args: dict[str, Any] | None = None,
        evidence: list[str] | None = None,
        now: float | None = None,
    ) -> ActionResult:
        """A human clicked Approve in the dashboard."""
        approval = self.gate.pending.get(nonce)
        ok, outcome = self.gate.redeem(
            nonce, uid, role, authorized=authorized, args=args, now=now,
        )
        if not ok or approval is None:
            return ActionResult(
                "REJECTED", approval.action if approval else "unknown",
                "CRITICAL", f"approval rejected: {outcome}",
            )

        # APPROVED — and STILL only files a request. This is the line the whole
        # security story rests on.
        result = self._file(approval.action, approval.args, "CRITICAL", evidence)
        key = idempotency_key(self.channel, approval.action_id, approval.action)
        self._seen[key] = result
        return result

    def deny(self, nonce: str, uid: int, *, now: float | None = None) -> ActionResult:
        approval = self.gate.pending.get(nonce)
        self.gate.deny(nonce, uid, now=now)
        return ActionResult(
            "DENIED", approval.action if approval else "unknown", "CRITICAL",
            "human declined; Echo acknowledges once and does not re-ask",
        )

    # -- the only "execution" that exists ---------------------------------

    def _file(
        self,
        action: str,
        args: dict[str, Any],
        tier: Tier,
        evidence: list[str] | None,
    ) -> ActionResult:
        """
        File a record. Notice what this function cannot do.

        There is no HTTP client here, no subprocess, no infrastructure SDK. A
        CRITICAL action that has been fully approved by an authorized human
        produces a TICKET, and a human performs the change. That is why the
        blast radius of a totally compromised Echo is "filed a Jira ticket with
        a misleading description".
        """
        ref = f"INC-{len(self._filed) + 1:04d}"
        record = {
            "ref": ref,
            "action": action,
            "args": args,
            "tier": tier,
            "evidence": evidence or [],
            "status": "PENDING_APPROVAL" if tier == "CRITICAL" else "FILED",
            "at": int(time.time() * 1000),
        }
        self._filed.append(record)
        log.info("proxy: filed %s as %s (%s)", action, ref, record["status"])
        return ActionResult(
            "EXECUTED" if tier == "ADVISORY" else "PENDING_APPROVAL",
            action, tier,
            "ticket filed; no infrastructure was changed", ref,
        )

    @property
    def filed(self) -> list[dict[str, Any]]:
        return list(self._filed)

    @property
    def audit(self) -> list[dict[str, Any]]:
        return [e.to_wire() for e in self.gate.audit]
