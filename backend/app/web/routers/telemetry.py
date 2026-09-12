"""
Telemetry Probe Router — REST endpoints for active telemetry queries.

Read-only probes against Datadog APM, Prometheus, and AWS CloudWatch.
Claims minted here are non-destructive and strictly non-causal (Rule 1).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.domain.services.telemetry import telemetry_service
from app.domain.services.elimination import hypothesis_matrix_service
from ..deps import session

log = logging.getLogger("echo.telemetry")

router = APIRouter(prefix="/telemetry", tags=["telemetry"])


class ProbeRequest(BaseModel):
    entity: str = Field(..., description="Target system or entity to probe (e.g. redis, postgres, checkout)")
    metric: str | None = Field(None, description="Specific metric to query (optional)")
    target_entity_id: str | None = Field(None, description="Graph entity ID to link the claim to")
    channel: str | None = Field(None, description="Channel ID of the target incident war room")


@router.post("/probe")
async def probe_telemetry(req: ProbeRequest) -> dict[str, Any]:
    """
    Execute a read-only telemetry probe.

    Mint a TOOL_RESULT claim in the Evidence Ledger, reconcile the hypothesis
    elimination matrix (marking disproven theories as REFUTED), and broadcast
    the delta over WebSocket to all connected dashboard consoles.
    """
    current = session(req.channel)
    reading = await telemetry_service.probe(req.entity, req.metric)
    claim = telemetry_service.synthesize_claim(reading, entity_id=req.target_entity_id)

    # Upsert claim into Ledger
    saved_claim = current.ledger.upsert_claim(claim)

    # Reconcile hypothesis elimination matrix
    reconciled = hypothesis_matrix_service.reconcile_lifecycle(current.ledger)

    # Broadcast delta: the new probe claim and any updated hypothesis claims
    broadcast_claims = [saved_claim.to_wire()] + [c.to_wire() for c in reconciled]
    await current.hub.publish({
        "claims": broadcast_claims,
    })

    log.info(
        "telemetry probe executed: entity=%s metric=%s status=%s -> claim=%s (reconciled %d hypotheses)",
        req.entity, reading.metric_name, reading.status, saved_claim.id, len(reconciled),
    )

    return {
        "status": "OK",
        "reading": reading.to_dict(),
        "claim": saved_claim.to_wire(),
        "reconciledCount": len(reconciled),
    }


@router.get("/catalog")
async def get_telemetry_catalog() -> dict[str, Any]:
    """Return available metrics and subsystems for interactive probing."""
    return telemetry_service.catalog()


@router.get("/matrix")
async def get_hypothesis_matrix(channel: str | None = None) -> dict[str, Any]:
    """Return the evaluated hypothesis elimination matrix for the active bridge session."""
    current = session(channel)
    evals = hypothesis_matrix_service.evaluate_claims(list(current.ledger.claims.values()))
    refuted = [e.to_wire() for e in evals if e.status == "REFUTED"]
    corroborated = [e.to_wire() for e in evals if e.status == "CORROBORATED"]
    open_theories = [e.to_wire() for e in evals if e.status == "OPEN"]
    return {
        "theories": [e.to_wire() for e in evals],
        "refuted": refuted,
        "corroborated": corroborated,
        "open": open_theories,
        "counts": {
            "total": len(evals),
            "refuted": len(refuted),
            "corroborated": len(corroborated),
            "open": len(open_theories),
        },
    }

