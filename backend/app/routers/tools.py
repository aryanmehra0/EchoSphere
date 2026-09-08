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

from ..deps import session, speech
from ..models import now_ms

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
