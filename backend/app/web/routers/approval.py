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


def get_entry_for(current: Any, uid: int) -> dict[str, Any] | None:
    """
    The real roster lookup — a participant's role as recorded server-side by
    `POST /bridge/roster` at join time (see `bridge.py`), never as claimed by
    the redeem request itself.

    A uid with no roster entry (never joined through the normal flow, or
    joined before this session was reset) is simply unauthorized — there is
    nothing to look up, so nothing to trust.
    """
    return current.roster.get(uid)


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
    actor_name = body.get("actorName") or body.get("actor_name")
    actor_user_id = body.get("actorUserId") or body.get("actor_user_id")

    entry = get_entry_for(current, uid)
    # The ROLE used for authorization is the one recorded on the roster at
    # join time — never the `role` field in this request body. A body-supplied
    # role is not read at all here; trusting it is exactly the hole this
    # rewrite closes (see `bridge.py`'s /bridge/roster for where the real
    # value comes from).
    role = str((entry or {}).get("role") or "")

    result = current.proxy.redeem(
        str(body.get("nonce", "")), uid, role,
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
