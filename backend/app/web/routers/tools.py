"""
The Fast Loop's tool surface — what Agora's servers call mid-turn.

Two endpoints, and the distinction between them is the security model:

    /tools/query_incident_state   READ — deterministic, no LLM, no gate
    /tools/invoke                 everything else, classified by ACTION
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from app.domain.models import now_ms
from ..deps import session, speech

log = logging.getLogger("echo.tools")

router = APIRouter(prefix="/tools")


@router.post("/query_incident_state")
async def query_incident_state(body: dict[str, Any]) -> dict[str, Any]:
    """
    The tool webhook Echo calls for ANY factual question.

    Deterministic read with no LLM in the path — which is what makes "ask eight
    times, get eight identical answers" a structural property rather than a
    hope about model stability (§5.2).
    """
    scope = body.get("scope") or (body.get("arguments") or {}).get("scope") or "summary"
    entity = body.get("entity") or (body.get("arguments") or {}).get("entity")
    return session().ledger.query(scope, entity)


@router.post("/probe_telemetry")
async def probe_telemetry(body: dict[str, Any]) -> dict[str, Any]:
    """
    Read-only telemetry probe endpoint for the Fast Loop agent.

    Called when Echo executes the probe_telemetry tool during a voice turn.
    Returns deterministic, non-causal metric readings and records them in the Ledger.
    """
    from app.domain.services.telemetry import telemetry_service
    from app.domain.services.elimination import hypothesis_matrix_service

    current = session()
    args = body.get("arguments") or body
    entity = args.get("entity") or body.get("entity") or "redis"
    metric = args.get("metric") or body.get("metric")

    reading = await telemetry_service.probe(str(entity), str(metric) if metric else None)
    claim = telemetry_service.synthesize_claim(reading)
    saved = current.ledger.upsert_claim(claim)

    reconciled = hypothesis_matrix_service.reconcile_lifecycle(current.ledger)
    broadcast_claims = [saved.to_wire()] + [c.to_wire() for c in reconciled]

    await current.hub.publish({
        "claims": broadcast_claims,
    })

    return {
        "status": "OK",
        "entity": reading.entity_id,
        "metric": reading.metric_name,
        "reading": reading.formatted,
        "raw": reading.to_dict(),
        "claimId": saved.id,
        "reconciledCount": len(reconciled),
    }


@router.post("/query_historical_incidents")
async def query_historical_incidents(body: dict[str, Any]) -> dict[str, Any]:
    """
    Cross-Incident Historical Retrieval tool endpoint for the Fast Loop agent.

    Allows Echo to retrieve precedents and postmortem findings from past incidents
    without ever asserting root cause (Rule 1). All returned lines carry strict attribution.
    """
    from app.infrastructure import vector_store

    args = body.get("arguments") or body
    query = str(args.get("query") or body.get("query") or "").strip()
    if not query:
        return {
            "query": "",
            "results": [],
            "summary": "No query was provided to search past incidents.",
            "count": 0,
        }

    results = await vector_store.search_historical_postmortems(
        query_text=query, top_k=3, score_threshold=0.35,
    )

    if not results:
        return {
            "query": query,
            "results": [],
            "summary": f"No past incident records match the query '{query}'.",
            "count": 0,
        }

    summaries = []
    for r in results:
        arch_id = r.get("archiveId", "archive")
        title = r.get("title", "Past Incident")
        sum_text = (r.get("summary") or "").strip()
        # Clean causal vocabulary to guarantee §6 compliance
        cleaned_sum = (
            sum_text[:200]
            .replace("caused by", "correlated with")
            .replace("root cause", "investigation focus")
            .replace(" because ", " coincident with ")
        )
        summaries.append(f"In past incident {arch_id} ('{title}'): {cleaned_sum}")

    spoken_summary = " | ".join(summaries)
    return {
        "query": query,
        "results": results,
        "summary": spoken_summary,
        "count": len(results),
    }


@router.post("/invoke")
async def invoke_tool(body: dict[str, Any]) -> dict[str, Any]:
    """
    Every tool call Echo makes lands here, whatever asked for it.

    Classification is a property of the ACTION, never of the request, so a
    prompt injection that talks Echo into execute_runbook_script still meets
    the Authorization Gate (§14.4).
    """
    current = session()

    action = (body.get("action") or "").strip()
    args = body.get("args") or {}
    if not action:
        return {"error": "action is required"}

    result = current.proxy.invoke(
        action, args, task=body.get("task", ""), evidence=body.get("evidence"),
    )

    if result.status == "PENDING_APPROVAL" and result.approval:
        # The dashboard raises the modal. It shows the full arguments AND the
        # evidence chain, so a human approves against the record rather than
        # against Echo's summary of it.
        await current.hub.broadcast({
            "kind": "APPROVAL_REQUEST",
            "at": now_ms(),
            "approval": {
                **result.approval,
                "evidence": [
                    c.to_wire() for c in (
                        current.ledger.claims.get(cid)
                        for cid in (body.get("evidence") or [])
                    ) if c
                ],
            },
        })

        # Echo says the sentence that makes the constraint audible.
        line = (
            f"DevOps, I have prepared {action.replace('_', ' ')}. "
            "It is a critical action — it needs your approval on the dashboard. "
            "I cannot authorise it from voice alone."
        )
        await speech(current).say(line, priority="high")

    return {
        "status": result.status,
        "action": result.action,
        "tier": result.tier,
        "detail": result.detail,
        "ref": result.ref,
        "approval": result.approval,
    }
