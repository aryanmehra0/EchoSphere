"""
Outbound (Driven) Ports.

Interfaces that the Application Core requires from external infrastructure:
- Extraction LLM (Groq / Gemma)
- Deliberation Panel (Multi-model contradiction adjudication)
- Voice Bridge (Agora Conversational AI /speak and /interrupt)
- Ledger Storage (PostgreSQL persistence)
- Delta Broadcasting (WebSocket distribution)
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from app.domain.models import Claim


@runtime_checkable
class ExtractionLlmPort(Protocol):
    """Port for structured LLM knowledge extraction from transcripts."""

    async def __call__(
        self,
        transcript_text: str,
        compacted_context: dict[str, Any] | None = None,
        *,
        aliases: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Extract structured knowledge (entities, links, claims, tasks, timeline, unchecked)."""
        ...


@runtime_checkable
class ContradictionPanelPort(Protocol):
    """Port for multi-model deliberation on claim pairs."""

    async def deliberate(
        self,
        claim_a: Claim,
        claim_b: Claim,
    ) -> Any:
        """Adjudicate the logical relationship between two claims about the same entity."""
        ...


@runtime_checkable
class VoiceBridgePort(Protocol):
    """Port for proactive speech and interruption on the voice bridge."""

    async def speak(
        self,
        text: str,
        *,
        priority: Any = "high",
        dedupe_key: str | None = None,
        force: bool = False,
    ) -> Any:
        """Speak a verified line on the live audio channel."""
        ...

    async def interrupt(self) -> Any:
        """Interrupt current speech on the live audio channel."""
        ...


@runtime_checkable
class LedgerStorePort(Protocol):
    """Port for durable persistence of the Evidence Ledger."""

    def save(self, record: Any, channel: str) -> None:
        """Mirror a newly created domain record to durable storage."""
        ...


@runtime_checkable
class DeltaBroadcasterPort(Protocol):
    """Port for publishing sequenced delta payloads to connected clients."""

    async def publish(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Broadcast a state mutation delta to subscribers."""
        ...

