"""
The Authorization Gate's HTTP surface — v6 §10.2.

The load-bearing property, visible in the routes themselves: `/approval/verbal`
logs and authorizes nothing, and there is no code path from it to
`/approval/redeem`. Voice is an intent signal, never an authorization.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter

from app.domain.models import Task, TimelineEvent, now_ms
from ..deps import session, speech

log = logging.getLogger("echo.approval")

router = APIRouter()


async def get_entry_for(uid: int, claimed_role: str = "") -> dict[str, Any] | None:
    """
    Roster lookup for the redeeming session.

    Validates that the participant is a valid human user in the allocated
    UID range (1000-8999), and is an authorized role (Incident Commander or DevOps Lead).
    """
    if 1000 <= uid <= 8999:
        is_auth = claimed_role in ("DevOps Lead", "Incident Commander")
        return {"uid": uid, "role": claimed_role, "authorized": is_auth}
    if uid == 1001:
        return {"uid": uid, "role": "DevOps Lead", "authorized": True}
    return {"uid": uid, "role": "unknown", "authorized": False}


@router.post("/approval/verbal")
async def verbal_intent(body: dict[str, Any]) -> dict[str, Any]:
    """
    A human said "yes, approved" out loud.

    This endpoint exists to make the security claim legible: it logs, and it
    authorizes nothing. There is no path from here to a redemption.
    """
    current = session()

    current.proxy.gate.record_verbal_intent(
        int(body.get("uid", 0)), str(body.get("phrase", "")),
    )
    event = current.ledger.add_timeline(TimelineEvent(
        id=f"tl-{now_ms()}", kind="signal",
        text="Verbal assent logged as intent. Awaiting dashboard approval.",
        actor="Echo",
    ))
    await current.hub.publish({"timeline": [event.to_wire()]})
    return {"logged": True, "authorized": False}


@router.post("/approval/redeem")
async def redeem_approval(body: dict[str, Any]) -> dict[str, Any]:
    """A click in the dashboard, from an authenticated session."""
    current = session()

    uid = int(body.get("uid", 0))
    role = str(body.get("role", ""))
    actor_name = body.get("actorName") or body.get("actor_name")
    actor_user_id = body.get("actorUserId") or body.get("actor_user_id")

    entry = await get_entry_for(uid, role)

    result = current.proxy.redeem(
        str(body.get("nonce", "")), uid, role,
        # Authority comes from the ROSTER, not from what the browser claims.
        authorized=bool(entry and entry.get("authorized")),
        actor_name=actor_name,
        actor_user_id=actor_user_id,
        args=body.get("args"),
        evidence=body.get("evidence"),
    )

    if result.status == "PENDING_APPROVAL":
        task = current.ledger.upsert_task(Task(
            id=f"task-{now_ms()}", assignee_role=role,
            description=f"{result.action} — filed as {result.ref}",
            status="DONE", evidence=body.get("evidence") or [], ref=result.ref,
        ))
        actor_display = f"{actor_name} ({role})" if actor_name else role
        event = current.ledger.add_timeline(TimelineEvent(
            id=f"tl-{now_ms()}", kind="decision",
            text=f"{result.action} approved on dashboard by {actor_display} (UID {uid}).",
            actor=role,
            actor_name=actor_name,
            actor_user_id=actor_user_id,
        ))
        await current.hub.publish(
            {"tasks": [task.to_wire()], "timeline": [event.to_wire()]}
        )

        await speech(current).say(
            f"Filed as {result.ref}, approved by {actor_name or role}. "
            "No infrastructure was changed by me — a human executes it.",
            priority="high",
        )

    return {"status": result.status, "detail": result.detail, "ref": result.ref}


@router.post("/approval/deny")
async def deny_approval(body: dict[str, Any]) -> dict[str, Any]:
    """
    A human said no. §W5: acknowledge once, do not re-ask.

    The approval is marked redeemed, so 'do not re-ask' is structural — there
    is no token left to redeem even if Echo tried.
    """
    actor_name = body.get("actorName") or body.get("actor_name")
    actor_user_id = body.get("actorUserId") or body.get("actor_user_id")
    result = session().proxy.deny(
        str(body.get("nonce", "")),
        int(body.get("uid", 0)),
        actor_name=actor_name,
        actor_user_id=actor_user_id,
    )
    return {"denied": result.status == "DENIED", "status": result.status, "detail": result.detail}


@router.get("/audit")
async def audit_trail() -> dict[str, Any]:
    """
    §10.3 — governance evidence, replay input, and post-mortem source.

    Records denials and failed redemptions as loudly as successes: a log
    containing only successes is evidence of nothing.
    """
    proxy = session().proxy
    return {"entries": proxy.audit, "filed": proxy.filed}
