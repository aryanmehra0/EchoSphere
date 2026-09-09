"""
Inbound (Driving) Ports.

Interfaces that define the application use cases exposed to drivers
(HTTP routers, WebSocket handlers, Fast Loop tools, and test harnesses):
- IngestTranscriptUseCase: Ingesting role-attributed speech frames into the session
- QueryIncidentStateUseCase: Deterministic querying of the incident evidence ledger
- ActionApprovalUseCase: 2-channel authorization gate and action redemption
- PrivacyConsentUseCase: Spoken consent gate ("off the record" tracking)
- ContradictionAdjudicationUseCase: Contradiction evaluation between claims
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from app.domain.models import Claim, Transcript


@runtime_checkable
class IngestTranscriptUseCase(Protocol):
    """Use case for processing incoming speech transcripts from the voice bridge or synthetic harness."""

    async def ingest(self, frame: Transcript) -> dict[str, Any] | None:
        """Ingest a single transcript frame into the incident session."""
        ...


@runtime_checkable
class QueryIncidentStateUseCase(Protocol):
    """Use case for deterministic queries against the Evidence Ledger."""

    def query(self, scope: str, entity: str | None = None) -> dict[str, Any]:
        """Query the evidence ledger for a given scope and optional entity."""
        ...


@runtime_checkable
class ActionApprovalUseCase(Protocol):
    """Use case for the 2-channel action proxy and authorization gate."""

    def invoke(
        self,
        action: str,
        args: dict[str, Any],
        *,
        task: str = "",
        evidence: list[str] | None = None,
        now: float | None = None,
    ) -> Any:
        """Classify and invoke or gate a proxy action."""
        ...

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
    ) -> Any:
        """Redeem a pending critical action authorization."""
        ...


@runtime_checkable
class PrivacyConsentUseCase(Protocol):
    """Use case for spoken consent gating and 'off the record' suspension."""

    def evaluate(self, text: str, role: str, *, now: float | None = None) -> Any:
        """Evaluate whether an utterance pauses, resumes, records, or drops speech."""
        ...


@runtime_checkable
class ContradictionAdjudicationUseCase(Protocol):
    """Use case for evaluating pairs of claims for logical contradiction."""

    async def deliberate(
        self,
        claim_a: Claim,
        claim_b: Claim,
    ) -> Any:
        """Adjudicate the logical relationship between two claims."""
        ...

