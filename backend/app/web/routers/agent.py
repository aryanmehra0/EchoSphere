"""
Agora Cloud Agent lifecycle — create, register, forget, stop.

Zone 2 drives all four: it holds the Agora credentials, so it is the only
party that knows an agent's id. This process holds that id in memory, which is
why re-registration after a backend restart is expected rather than an error.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.domain.policies.utterance import joined
from app.infrastructure import agora_agent
from ..deps import session, speech

log = logging.getLogger("echo.agent")

router = APIRouter(prefix="/agent")


def _with_recap(prompt: str) -> str:
    """
    Append the Ledger recap to a system prompt, when there is one.

    A replacement agent starts with an empty history, so without this the
    person who joins third can ask what has been established and be told
    nothing, while the dashboard beside them shows a full Ledger.
    """
    try:
        recap = session().ledger.recap()
    except Exception:
        log.warning("could not build the ledger recap", exc_info=True)
        return prompt
    if not recap:
        return prompt

    header = (
        "[WHAT THIS BRIDGE HAS ALREADY ESTABLISHED]\n"
        "You are joining an incident already in progress. What follows is"
        " the record so far, attributed. Treat it as the record, not as"
        " your own recollection, and keep attributing it when you refer"
        " to it.\n\n"
    )
    return prompt + "\n\n" + header + recap


async def _greet(*, can_read_ledger: bool) -> dict[str, Any]:
    """
    ── PROOF OF LIFE ──────────────────────────────────────────────────────
    Echo used to join in complete silence. From inside the room that is
    indistinguishable from a broken agent, a wrong channel, a failed invite
    or a mute TTS vendor — all four of which have happened here, and none of
    which announce themselves. One spoken line separates them instantly.

    Composed by `utterance.joined` rather than Agora's `greeting_message`
    so it passes the same §6 gate as every other sentence Echo speaks; the
    model never gets to write the first thing anyone hears.

    Best-effort: a greeting that fails must not fail the registration, or a
    hoarse TTS vendor would take the whole bridge down with it.
    """
    try:
        line = joined(can_read_ledger=can_read_ledger)
        # `speak` with force, NOT `speak_now`. speak_now interrupts first, and
        # a greeting has nothing to pre-empt — it is the first thing said. The
        # interrupt raced its own utterance and Agora recorded the arrival line
        # truncated to the single word "Echo".
        result = await speech().say(line, priority="high", force=True)
        return {"spoken": bool(result and result.ok), "text": line}
    except Exception as exc:  # noqa: BLE001 — never block registration
        log.warning("greeting failed (agent is registered regardless): %s", exc)
        return {"spoken": False, "error": str(exc)}


@router.post("/start")
async def start_agent(body: dict[str, Any]) -> JSONResponse:
    """
    Create the Agora agent through the official SDK, then register it here.

    ── WHY ZONE 2 NO LONGER BUILDS THE PAYLOAD ────────────────────────────
    It built it by hand, and Agora returns 200 for a payload it only partly
    understands. Every misplaced field failed silently, and the failure that
    survived longest was the one that matters most: the recogniser never ran,
    so `content` came back EMPTY for turns carrying seconds of real speech.

    The SDK derives the vendor presets instead of asserting them, and refuses
    to construct an invalid recogniser at all. See `adapters/agora_agent.py`.

    This endpoint deliberately also does the REGISTER step, because the two
    were previously separate calls from Zone 2 and a lost second call left
    Echo mute for the session with no way back. One call, one outcome.
    """
    current = session()

    channel = (body.get("channel") or "").strip()
    prompt = body.get("systemPrompt") or ""
    if not channel or not prompt:
        return JSONResponse(
            {"error": "channel and systemPrompt are required"}, status_code=400,
        )

    try:
        result = await agora_agent.start(
            channel=channel,
            agent_uid=int(body.get("agentUid") or 0),
            user_uid=int(body.get("userUid") or 0),
            # Everyone else already on the bridge, so Echo can hear the whole
            # room rather than only the console that invited it.
            other_uids=[int(u) for u in (body.get("otherUids") or []) if int(u) > 0],
            # ── HAND A REPLACEMENT AGENT THE INCIDENT SO FAR ───────────────
            # Adding a speaker means a NEW agent (remote_rtc_uids is fixed at
            # creation), and a new agent starts with an empty history. Without
            # this, whoever joins third can ask "what have we established?"
            # and be told nothing — while the dashboard beside them shows a
            # full Ledger.
            #
            # The recap is attributed and non-diagnostic by construction, and
            # INFERRED claims are excluded, so nothing enters the prompt that
            # the model could mistake for its own knowledge.
            system_prompt=_with_recap(prompt),
            tts=body.get("tts") or {},
            greeting=body.get("greeting"),
            llm_mode=(body.get("llmMode") or "managed"),
            groq_api_key=body.get("groqApiKey"),
            groq_model=body.get("groqModel"),
            tools=body.get("tools"),
        )
    except agora_agent.VoiceAgentError as exc:
        # Degradation (§13): a failed invite must not take the dashboard with
        # it. Reported, not raised.
        log.warning("agent start failed: %s", exc)
        return JSONResponse(
            {"error": str(exc), "degraded": True}, status_code=502,
        )

    agent_id = result["agent_id"]
    already_known = current.agent["agent_id"] == agent_id
    current.agent["agent_id"] = agent_id
    current.agent["channel"] = channel
    log.info("agent started and registered: %s on %s", agent_id, channel)

    greeting = None
    if not already_known and bool(body.get("greet", True)):
        greeting = await _greet(can_read_ledger=bool(body.get("tools")))

    return JSONResponse({
        "ok": True,
        "agentId": agent_id,
        "channel": channel,
        "agent": current.agent,
        "greeting": greeting,
    })


@router.post("/stop")
async def stop_agent_endpoint(body: dict[str, Any]) -> dict[str, Any]:
    """Stop the agent through the SDK and forget it here."""
    current = session()

    agent_id = (body.get("agentId") or current.agent["agent_id"] or "").strip()
    if not agent_id:
        return {"ok": False, "reason": "no agent registered"}
    try:
        await agora_agent.stop(agent_id)
    except agora_agent.VoiceAgentError as exc:
        log.warning("agent stop failed: %s", exc)
        return {"ok": False, "reason": str(exc)}
    current.agent["agent_id"] = None
    current.agent["channel"] = None
    return {"ok": True, "stopped": agent_id}


@router.post("/register")
async def register_agent(body: dict[str, Any]) -> dict[str, Any]:
    """
    Called after Zone 2's /api/invite-agent succeeds.

    The Bridge cannot speak without an agent id, and only Zone 2 knows it —
    it holds the Agora credentials that created the agent.
    """
    current = session()

    agent_id = (body.get("agentId") or "").strip()
    channel = (body.get("channel") or "").strip()
    if not agent_id or not channel:
        return {"error": "agentId and channel are required"}

    # Is this the same agent we already knew about?
    #
    # Re-registration is EXPECTED, not an error. Zone 2's invite is idempotent
    # per channel, so a second console joining - or the same person rejoining
    # after a reload - reuses the agent and registers it again. It has to:
    # this process holds the agent id in memory, so a backend restart forgets
    # it, and without a re-register Echo stays mute forever with no way back
    # short of a new channel.
    #
    # What must NOT repeat is the greeting. Echo announcing itself on every
    # reload is the "filler" the prompt forbids, and on a live bridge it reads
    # as a stuck agent.
    already_known = current.agent["agent_id"] == agent_id

    current.agent["agent_id"] = agent_id
    current.agent["channel"] = channel
    log.info(
        "agent %s: %s on %s",
        "re-registered" if already_known else "registered", agent_id, channel,
    )

    # Zone 2 decides whether this arrival deserves an announcement, because
    # only Zone 2 knows whether it just CREATED the agent or is re-registering
    # one that already existed. This process cannot tell: it holds the agent id
    # in memory, so after a restart every agent looks new to it, and Echo would
    # re-introduce itself to a room it has been sitting in for twenty minutes.
    wants_greeting = bool(body.get("greet", True))

    if already_known or not wants_greeting:
        reason = "already registered" if already_known else "not a new session"
        return {
            "ok": True,
            "agent": current.agent,
            "greeting": {"spoken": False, "reason": reason},
        }

    greeting = await _greet(can_read_ledger=bool(body.get("toolsEnabled")))
    return {"ok": True, "agent": current.agent, "greeting": greeting}


@router.post("/unregister")
async def unregister_agent(body: dict[str, Any]) -> dict[str, Any]:
    """
    Forget the agent — the other half of `/agent/register`.

    Without this, stopping an agent left the Bridge Controller holding a dead
    id: `/speak` would be issued against an agent that had left the channel,
    fail, and raise the degradation banner for a reason nobody could see. The
    pre-flight caught it as "leftover agent from a previous run" that no reset
    could clear, because only a backend restart cleared it.

    Scoped by channel so a stop on one bridge cannot silence another.
    """
    current = session()

    channel = (body.get("channel") or "").strip()
    if channel and current.agent["channel"] not in (None, channel):
        return {"ok": False, "reason": "different channel", "agent": current.agent}

    was = current.agent["agent_id"]
    current.agent["agent_id"] = None
    current.agent["channel"] = None
    log.info("agent unregistered: %s", was or "(none)")
    return {"ok": True, "was": was}
