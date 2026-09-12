"""
Hypothesis Elimination Matrix — Domain Service.

Organizes, evaluates, and settles engineering theories verbalized during
an incident bridge without violating Rule 1: Echo never determines root cause.

── WHY THIS DOES NOT BREAK RULE 1 ────────────────────────────────────────────
Echo refutes or corroborates a SPECIFIC STATEMENT against EMPIRICAL DATA.
It never declares the overall incident root cause.

Example:
  Hypothesis: "Maybe Redis is out of memory and evicting keys."
  Telemetry: Datadog APM reports Redis memory is 34.2% and 0 evictions.
  Outcome: REFUTED ❌
  Echo prose: "The hypothesis that Redis is out of memory was refuted by
               Datadog APM: utilization is 34.2% and eviction count is 0."

This kills false rabbit holes in 3 seconds instead of 30 minutes.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from app.domain.models import Claim, now_ms
from app.domain.services.telemetry import telemetry_service, _CAUSAL_FORBIDDEN

log = logging.getLogger("echo.elimination")

HypothesisStatus = Literal["OPEN", "REFUTED", "CORROBORATED"]


@dataclass
class HypothesisEvaluation:
    """Evaluation of an unverified theory against empirical observations or tool results."""

    hypothesis_id: str
    hypothesis_text: str
    speaker_role: str
    target_entity: str
    status: HypothesisStatus
    evidence_claim_id: str | None = None
    evidence_text: str | None = None
    evidence_provider: str | None = None
    reason: str = ""
    suggested_probe: dict[str, Any] | None = None
    evaluated_at: int = field(default_factory=now_ms)

    def to_wire(self) -> dict[str, Any]:
        out = {
            "hypothesisId": self.hypothesis_id,
            "hypothesisText": self.hypothesis_text,
            "speakerRole": self.speaker_role,
            "targetEntity": self.target_entity,
            "status": self.status,
            "reason": self.reason,
            "evaluatedAt": self.evaluated_at,
        }
        if self.evidence_claim_id:
            out["evidenceClaimId"] = self.evidence_claim_id
        if self.evidence_text:
            out["evidenceText"] = self.evidence_text
        if self.evidence_provider:
            out["evidenceProvider"] = self.evidence_provider
        if self.suggested_probe:
            out["suggestedProbe"] = self.suggested_probe
        return out


class HypothesisMatrixService:
    """Service that cross-references hypotheses with empirical measurements."""

    def __init__(self) -> None:
        # Keywords indicating failure or saturation assumptions
        self._failure_terms = {
            "down", "dead", "oom", "out of memory", "evict", "eviction",
            "full", "saturated", "exhausted", "timeout", "spike", "drop",
            "dropping", "failing", "crash", "hung", "maxed", "lag",
        }

    def _extract_entity(self, text: str) -> str:
        """Infer which entity a hypothesis is discussing."""
        lower = text.lower()
        if "redis" in lower or "cache" in lower:
            return "redis"
        if "replica" in lower:
            return "postgres-replica"
        if "postgres" in lower or "database" in lower or "db" in lower:
            return "postgres"
        if "checkout" in lower or "cart" in lower:
            return "checkout"
        if "stripe" in lower or "payment" in lower:
            return "stripe"
        if "network" in lower or "netpath" in lower or "packet" in lower or "vpc" in lower or "transit" in lower:
            return "network"
        if "auth" in lower or "jwt" in lower or "token" in lower:
            return "auth"
        if "ingress" in lower or "gateway" in lower or "proxy" in lower:
            return "ingress"
        return "system"

    def evaluate_claims(self, claims: list[Claim]) -> list[HypothesisEvaluation]:
        """
        Evaluate all HYPOTHESIS claims in the provided collection.
        Cross-references with TOOL_RESULT and OBSERVED claims.
        """
        hypotheses = [c for c in claims if c.epistemic_status == "HYPOTHESIS"]
        established = [
            c for c in claims
            if c.epistemic_status in ("TOOL_RESULT", "OBSERVED")
        ]

        # Index established claims by entity
        by_entity: dict[str, list[Claim]] = {}
        for c in established:
            ent = c.entity or self._extract_entity(c.text)
            by_entity.setdefault(ent, []).append(c)

        evaluations: list[HypothesisEvaluation] = []
        catalog = telemetry_service.catalog()

        for hyp in hypotheses:
            target_entity = hyp.entity or self._extract_entity(hyp.text)
            candidates = by_entity.get(target_entity, [])

            # Also consider claims that directly supersede or contradict this hypothesis
            superseding_claim: Claim | None = None
            for c in established:
                if c.supersedes == hyp.id or hyp.id in c.contradicts:
                    superseding_claim = c
                    break

            # If the hypothesis has already been explicitly marked REFUTED
            if hyp.lifecycle == "REFUTED":
                eval_item = HypothesisEvaluation(
                    hypothesis_id=hyp.id,
                    hypothesis_text=hyp.text,
                    speaker_role=hyp.speaker_role,
                    target_entity=target_entity,
                    status="REFUTED",
                    reason="Theory marked refuted on the evidence ledger.",
                    evaluated_at=hyp.at,
                )
                evaluations.append(eval_item)
                continue

            status: HypothesisStatus = "OPEN"
            evidence_claim: Claim | None = superseding_claim
            reason = ""

            if evidence_claim:
                status = "REFUTED"
                reason = f"Settled on the ledger by {evidence_claim.speaker_role}: {evidence_claim.text}"
            elif candidates:
                # Find most recent probe or observation
                candidates_sorted = sorted(candidates, key=lambda c: c.at, reverse=True)
                evidence_claim = candidates_sorted[0]
                text_lower = evidence_claim.text.lower()

                # Determine if the evidence refutes or corroborates.
                #
                # ── WHY THIS ISN'T A BARE SUBSTRING CHECK ON "ok" ──────────
                # It used to include "ok" as one of the `is_ok` tokens, checked
                # with a plain `in`. "ok" is a substring of ordinary incident
                # vocabulary — "broken", "looks", "invoke", "revoke", "smoke",
                # "cooked" — so an OBSERVED claim stating something is broken
                # ("the connection pool looks broken") matched `is_ok=True`
                # and got reported REFUTED with "telemetry confirms normal
                # operational thresholds": backwards from what was said.
                #
                # `synthesize_claim()` (telemetry.py) always emits a bracketed
                # `[OK]`/`[CRITICAL]`/`[WARNING]` tag, so that's checked first
                # and is safe as a substring — brackets make it structurally
                # unambiguous, no real English word contains "[ok]" literally.
                # A free-text human OBSERVED claim carries no such tag, so it
                # falls back to whole-word matching (`\b`), never a bare
                # substring, and "ok" is dropped from that fallback entirely —
                # two letters are too short to ever safely word-match against
                # conversational English either.
                #
                # The literal catalog numbers ("34.2%", "92.4%", ...) that
                # used to sit alongside these tokens are gone too: they were
                # redundant with the bracket tag for TOOL_RESULT claims, and
                # would silently stop matching the moment the demo catalog's
                # numbers changed — see `telemetry.py`'s `_catalog`.
                has_ok_tag = "[ok]" in text_lower
                has_critical_tag = "[critical]" in text_lower or "[warning]" in text_lower
                is_ok = has_ok_tag or (
                    not has_critical_tag
                    and bool(re.search(r"\b(baseline|normal|healthy)\b", text_lower))
                )
                is_critical = has_critical_tag or bool(
                    re.search(r"\b(critical|warning)\b", text_lower) or "drop rate" in text_lower
                )

                if is_ok and not is_critical:
                    status = "REFUTED"
                    reason = f"Refuted by {evidence_claim.speaker_role}: telemetry confirms normal operational thresholds."
                elif is_critical:
                    status = "CORROBORATED"
                    reason = f"Corroborated by {evidence_claim.speaker_role}: observed telemetry aligns with reported symptom."
                else:
                    status = "OPEN"
                    reason = f"Observation on {target_entity} recorded but inconclusive for this specific hypothesis."

            # Ensure reason strictly respects Rule 1 (never assert root cause)
            if _CAUSAL_FORBIDDEN.search(reason):
                log.warning("anti-causal tripwire caught forbidden phrase in reasoning: %s", reason)
                reason = "Telemetry measurement observed on target entity."

            # Build suggested probe if OPEN
            suggested_probe: dict[str, Any] | None = None
            if status == "OPEN":
                if target_entity in catalog:
                    entry = catalog[target_entity]
                    suggested_probe = {
                        "entity": target_entity,
                        "metric": entry.get("defaultMetric"),
                        "label": entry.get("label", target_entity.title()),
                        "provider": entry.get("provider", "Datadog APM"),
                    }
                else:
                    suggested_probe = {
                        "entity": target_entity,
                        "label": target_entity.title(),
                        "provider": "Datadog APM",
                    }

            evaluations.append(
                HypothesisEvaluation(
                    hypothesis_id=hyp.id,
                    hypothesis_text=hyp.text,
                    speaker_role=hyp.speaker_role,
                    target_entity=target_entity,
                    status=status,
                    evidence_claim_id=evidence_claim.id if evidence_claim else None,
                    evidence_text=evidence_claim.text if evidence_claim else None,
                    evidence_provider=evidence_claim.speaker_role if evidence_claim else None,
                    reason=reason,
                    suggested_probe=suggested_probe,
                    evaluated_at=now_ms(),
                )
            )

        return evaluations

    def reconcile_lifecycle(self, ledger: Any) -> list[Claim]:
        """
        Scan the ledger's hypotheses, update claim.lifecycle = 'REFUTED'
        for any newly refuted theories, and return the mutated claims.
        """
        all_claims = list(ledger.claims.values())
        evals = self.evaluate_claims(all_claims)
        updated: list[Claim] = []

        for ev in evals:
            if ev.status == "REFUTED":
                c = ledger.claims.get(ev.hypothesis_id)
                if c and c.lifecycle != "REFUTED":
                    c.lifecycle = "REFUTED"
                    if ev.evidence_claim_id and not c.supersedes:
                        c.supersedes = ev.evidence_claim_id
                    updated.append(c)
                    log.info(
                        "elimination: reconciled hypothesis %s to REFUTED via %s",
                        c.id, ev.evidence_claim_id,
                    )

        return updated


# Singleton instance
hypothesis_matrix_service = HypothesisMatrixService()

