"""
The conversation leg, driven by the Agora SDK instead of a hand-built payload.

────────────────────────────────────────────────────────────────────────────
WHY THIS FILE EXISTS

Everything else about the Fast Loop was fine. The agent joined, subscribed to
the right participant, and spoke whatever `/speak` pushed at it. What it never
did was HEAR. Agora's own history showed the shape precisely:

    {"role": "user", "source": "asr", "content": "",
     "vpids_info": {"speech_duration": 3350}}

3.35 seconds of real speech, five end-of-speech events, and an empty string.
VAD was working. The recogniser was not running.

The cause is that the create-agent payload was assembled BY HAND in
`frontend/src/lib/server/agent-config.ts`. That payload has a trap the API
does not defend you against: Agora accepts unknown keys and returns 200
REGARDLESS, so every misplaced field fails silently and looks like success.
Chasing it field by field produced a file with more comment than code, each
block documenting a different silent failure — and the agent still could not
listen.

The official Python quickstart does not have this problem, because it never
writes the payload. It composes vendor objects and lets the SDK serialise
them, and the SDK does two things the hand-built version could not:

  1. `resolve_session_presets()` DERIVES the preset from the vendor blocks and
     then strips what the preset covers. Order matters absolutely: infer from
     full blocks first, strip second. Hand-writing both halves let them
     disagree, which is how we claimed `deepgram_nova_3` while sending an ASR
     block with no model — a preset nothing justified.
  2. It validates. `DeepgramSTT` REFUSES to construct without either an
     api_key or a managed model. A whole class of silent-200 bugs becomes a
     loud Python exception at build time instead.

So this module owns exactly one thing: creating and destroying the Agora
agent. It is the quickstart's `server/src/agent.py`, adapted to Echo's needs.

────────────────────────────────────────────────────────────────────────────
WHAT THIS DELIBERATELY DOES NOT DO

It does not own the Ledger, extraction, contradiction, the panel, RTI,
privacy, redaction, the proxy layer, or the Bridge. None of that moved. This
process already held all of it and still does; `bridge.py` keeps speaking
through the same REST endpoints against the agent id created here.

Nor does it own the PROMPT or the TOOL DEFINITIONS. Those still live in
`agent-config.ts` and are passed in over HTTP by the invite route. Zone 2
remains the only place that decides what Echo is told and which tools it may
call; duplicating that text here would create two sources of truth for the
most load-bearing string in the project, and they would drift.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
from typing import Any

from .. import config

log = logging.getLogger("echo.voice_agent")

# Populated on first use. The SDK pulls in pydantic and a vendor tree, and a
# process that never starts an agent (the Rehearsal Rig, the test suite) must
# not pay that cost or fail on an absent dependency.
_client: Any = None


class VoiceAgentError(RuntimeError):
    """Raised with an actionable message when the agent cannot be created."""


def _require_sdk() -> tuple[Any, ...]:
    """
    Import the SDK, or explain exactly how to install it.

    Deferred rather than top-level because `main.py` imports this module
    unconditionally, and the Slow Loop must still serve the dashboard on a
    machine where the SDK is missing — degradation, v6 §13.
    """
    try:
        from agora_agent import Area, AsyncAgora
        from agora_agent.agentkit import Agent as AgoraAgent
        from agora_agent.agentkit.vendors import DeepgramSTT, MiniMaxTTS, OpenAI
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise VoiceAgentError(
            "The Agora agent SDK is not installed in this interpreter.\n"
            "  backend\\.venv\\Scripts\\pip install agora-agents>=2.3.0"
        ) from exc
    return Area, AsyncAgora, AgoraAgent, DeepgramSTT, MiniMaxTTS, OpenAI


def _agora_client() -> Any:
    global _client
    if _client is not None:
        return _client

    Area, AsyncAgora, *_ = _require_sdk()
    settings = config.agora()
    if not settings.app_certificate:
        raise VoiceAgentError(
            "AGORA_APP_CERTIFICATE is required to mint the agent's own token.\n"
            "Add it to backend/.env or frontend/.env.local."
        )

    _client = AsyncAgora(
        area=Area.US,
        app_id=settings.app_id,
        app_certificate=settings.app_certificate,
    )
    return _client


# Live sessions, keyed by the agent id the SDK returns. Held so `stop()` can
# use the session's own teardown, which is cleaner than the stateless REST
# call — though that remains the fallback, because this map lives in memory
# and a restart forgets it while Agora does not.
_sessions: dict[str, Any] = {}


async def start(
    *,
    channel: str,
    agent_uid: int,
    user_uid: int,
    # Every OTHER human already on the bridge. The agent subscribes to all of
    # them plus `user_uid`; without this it can only hear whoever invited it.
    other_uids: list[int] | None = None,
    system_prompt: str,
    tts: dict[str, Any],
    greeting: str | None = None,
    llm_mode: str = "managed",
    groq_api_key: str | None = None,
    groq_model: str | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Create the Agora agent through the SDK and return its id.

    `system_prompt` and `tools` arrive from Zone 2 so the prompt keeps a single
    source of truth in `agent-config.ts`. Everything else is composed here as
    SDK objects, which is the entire point of the exercise: the wire payload is
    the SDK's business, not ours.
    """
    _area, _async_agora, AgoraAgent, DeepgramSTT, MiniMaxTTS, OpenAI = _require_sdk()

    if not channel.strip():
        raise VoiceAgentError("channel is required")
    if agent_uid <= 0 or user_uid <= 0:
        raise VoiceAgentError("agent_uid and user_uid must be positive")

    # Deduplicated and ordered with the inviter first, so a repeated uid or a
    # console that passes itself in `other_uids` cannot produce a duplicate
    # subscription.
    remote_uids: list[int] = [user_uid]
    for u in other_uids or []:
        if u > 0 and u not in remote_uids:
            remote_uids.append(u)

    client = _agora_client()

    # ── STT ────────────────────────────────────────────────────────────────
    # nova-3 with NO api_key is the Agora-MANAGED path: the SDK infers the
    # `deepgram_nova_3` preset from this model and strips the field itself.
    # Passing a key here would silently drop us off that path.
    #
    # This constructor VALIDATES — it raises unless there is a key or a
    # managed model. That single check is what the hand-built payload lacked.
    stt = DeepgramSTT(model="nova-3", language="en")

    # ── LLM ────────────────────────────────────────────────────────────────
    # Managed: no api_key, so Agora supplies and bills gpt-4o-mini and the SDK
    # infers `openai_gpt_4o_mini`. Groq: our own url and key, which by design
    # yields no LLM preset.
    #
    # `greeting_message` is what makes the quickstart greet on join — the
    # engine speaks it as soon as the agent enters the channel. Ours was forced
    # to "" (see below), so Echo joined in total silence and the only way to
    # tell a working agent from a dead one was to read the server log.
    #
    # `failure_message` stays EMPTY regardless. Agora speaks it whenever a turn
    # returns an empty completion, and VAD fires on coughs and room noise, so a
    # non-empty value is read aloud on every stray sound. Live runs recorded
    # "One moment." five times into a silent room.
    # ── max_history IS A SECRETS CONTROL, NOT ONLY A CONTEXT BUDGET ────────
    #
    # This is the number of RAW recognised turns Agora keeps inside its own
    # LLM context. Our redaction runs at the ingest boundary and keeps
    # credentials out of the transcript, the Ledger and Postgres — verified,
    # zero rows — but Agora's ASR feeds Agora's LLM directly. That copy is
    # not ours to scrub.
    #
    # The consequence was reported live: a password spoken aloud did NOT
    # appear anywhere in our record, and Echo still said it back when asked,
    # because it was remembering rather than reading.
    #
    # 32 turns is a long memory for that exposure. 12 keeps Echo coherent
    # across a normal exchange — plenty for "what did I just say", follow-up
    # questions and a clarification — while making an accidental secret age
    # out of context in a couple of minutes of conversation rather than
    # persisting for the whole incident.
    #
    # This is the STRUCTURAL half of the fix. The prompt clause
    # (`SECRETS_CLAUSE` in agent-config.ts) is the soft half, and a prompt is
    # a request. Neither is sufficient alone: the prompt covers the window
    # that is still in memory, this bounds how long that window lasts.
    #
    # The Ledger is unaffected — it is the durable record, and `recap()` hands
    # a replacement agent an attributed, non-diagnostic summary. Shrinking
    # Agora's short-term memory does not shorten the incident's memory.
    llm_kwargs: dict[str, Any] = {
        "greeting_message": greeting or "",
        "failure_message": "",
        "max_history": 12,
        "system_messages": [{"role": "system", "content": system_prompt}],
    }
    if llm_mode == "groq":
        if not groq_api_key:
            raise VoiceAgentError("groq mode needs a Groq API key")
        llm = OpenAI(
            base_url="https://api.groq.com/openai/v1/chat/completions",
            api_key=groq_api_key,
            model=groq_model or "openai/gpt-oss-120b",
            max_tokens=512,
            temperature=0.3,
            **llm_kwargs,
        )
    else:
        llm = OpenAI(
            model="gpt-4o-mini",
            max_tokens=1024,
            temperature=0.7,
            top_p=0.95,
            **llm_kwargs,
        )

    # ── TTS ────────────────────────────────────────────────────────────────
    # ── AGORA-MANAGED MiniMax, EXACTLY AS THE QUICKSTART USES IT ───────────
    # No `key`, which is what makes it managed: Agora supplies and bills the
    # voice, the SDK infers `minimax_speech_2_6_turbo`, and no TTS credential
    # of ours is in the request path at all.
    #
    # This replaced BYOK ElevenLabs deliberately. The quickstart is the only
    # configuration observed to listen and respond end to end here, and the
    # point of this module is to match it rather than to preserve a vendor
    # choice that was never the reason for the outage. It also removes a whole
    # class of failure: ELEVENLABS_VOICE_ID was empty, and the key turned out
    # to be permission-scoped so tightly it could not even list voices.
    #
    # `tts` is still accepted as an argument so Zone 2 keeps a seam for a BYOK
    # vendor later; it is deliberately unused on the managed path.
    tts_obj = MiniMaxTTS(
        model="speech_2_6_turbo",
        voice_id="English_captivating_female1",
    )

    # ── VAD ────────────────────────────────────────────────────────────────
    # The nested `config` shape, which is the only one the current API honours;
    # the older flat keys are deprecated and, being unknown keys, were accepted
    # and ignored.
    #
    # ── THIS IS THE FILE THAT DECIDES, AND IT WAS CUTTING SENTENCES ────────
    # `frontend/src/lib/server/agent-config.ts` has a TURN_DETECTION block too
    # and it is NOT in the request path — the SDK builds the agent here. Tuning
    # the frontend value changes nothing, which is a good way to lose an hour.
    #
    # Measured live at silence_duration_ms=480:
    #
    #     spoken: "please note that the database is down"
    #             "so the Redis is also down"
    #     got:    "Please know"   /   "So"
    #
    # Those are truncations, not mishearings. A speaker pausing for breath
    # after "please note that…" crosses 480ms easily, so Agora declared
    # end-of-turn mid-clause and handed Deepgram a two-word clip — which
    # Deepgram then transcribed correctly, because "Please know" IS what those
    # syllables sound like alone. That is why it presents as an accuracy
    # problem and is not one.
    #
    # It also poisons everything downstream: a fragment carries no subject, so
    # entity resolution finds nothing and the Ledger fills with claims nobody
    # finished making.
    #
    # 1500ms is conversational-dictation territory. The cost is Echo waiting
    # ~1s longer to answer; the benefit is hearing whole sentences. For an
    # agent whose entire job is an accurate record, that trade is not close.
    #
    # `interrupt_duration_ms` 300, not the quickstart's 160: at 160 Echo barged
    # in on breaths and back-channel "mm-hm", and an assistant that interrupts
    # constantly gets muted.
    #
    # `prefix_padding_ms` 800, not 300: audio captured BEFORE the trigger.
    # Too little and the first phoneme is clipped, so "Redis" arrives as
    # "edis" — the other half of the reported mis-transcription.
    #
    # If Echo feels sluggish to interrupt, lower silence in 200ms steps and
    # re-test with `npm run demo converse`. Never back to a value where a
    # mid-sentence breath ends the turn.
    turn_detection = {
        "config": {
            "speech_threshold": 0.5,
            "start_of_speech": {
                "mode": "vad",
                "vad_config": {
                    # ── 640, NOT 300: ECHO WAS BEING CUT OFF MID-SENTENCE ──
                    # This is how much detected speech BARGES IN on Echo. At
                    # 300ms almost anything qualifies — a cough, an "mm-hm",
                    # a chair creak, breathing near the mic — so Echo's
                    # answers were being truncated part-way through. Reported
                    # as "the voice of Echo is getting cut sometimes".
                    #
                    # The history here is instructive: it was 160ms, raised
                    # to 300 for exactly this symptom, and 300 was still not
                    # enough. Barge-in has to clear the noise floor of a real
                    # room, not a quiet desk.
                    #
                    # 640ms is roughly two syllables — long enough that
                    # genuine speech ("Echo, stop") still interrupts promptly,
                    # short enough that it does not feel unresponsive when
                    # somebody really does need to cut in.
                    #
                    # Trade-off, stated: interrupting Echo now needs a
                    # deliberate utterance rather than any sound at all. On an
                    # agent whose job is to be interruptible that is a real
                    # cost — but being unable to finish a sentence is worse,
                    # because the information never lands.
                    "interrupt_duration_ms": 640,
                    "prefix_padding_ms": 800,
                },
            },
            "end_of_speech": {
                "mode": "vad",
                "vad_config": {"silence_duration_ms": 1500},
            },
        },
    }

    agent = AgoraAgent(
        client=client,
        instructions=system_prompt,
        failure_message="",
        # 12, not 32 — and this is the occurrence that SHIPS. There is a
        # second `max_history` in `llm_kwargs` above; both were 32 and only
        # changing one would have left the exposure in place while looking
        # fixed, which is the worst possible outcome for a secrets control.
        # See the long note on `llm_kwargs` for why this number matters.
        max_history=12,
        turn_detection=turn_detection,
        advanced_features={"enable_rtm": True, "enable_tools": bool(tools)},
        parameters={
            "audio_scenario": "chorus",
            "data_channel": "rtm",
            "enable_error_message": True,
            "enable_metrics": True,
        },
    )
    agent = agent.with_stt(stt).with_llm(llm).with_tts(tts_obj)

    session = agent.create_async_session(
        channel=channel,
        agent_uid=str(agent_uid),
        # ── EVERY HUMAN ON THE BRIDGE, NOT JUST THE ONE WHO INVITED ────────
        #
        # This was `[str(user_uid)]`, and the comment above it asserted that
        # Agora supports exactly one subscribed user. That is what the SDK's
        # own field docs still say — "Currently, only one user ID is
        # supported" — but the field is typed `List[str]` and the live API
        # accepts a list, so the docstring is behind the service.
        #
        # With one uid the agent is deaf to everyone else in the room: only
        # the person whose console created it can be heard, and the other two
        # roles talk to an agent that never runs a recogniser on their audio.
        # Reported exactly that way — Echo answering the Support Engineer and
        # ignoring DevOps and the DBA.
        #
        # `remote_uids` is now every human uid the caller knows about. The
        # inviting console's uid is always included, so the single-human case
        # is unchanged.
        remote_uids=[str(u) for u in remote_uids],
        enable_string_uid=False,
        idle_timeout=300,
        expires_in=3600,
    )

    log.info(
        "voice_agent: starting channel=%s agent_uid=%s remote_uids=%s mode=%s",
        channel, agent_uid, remote_uids, llm_mode,
    )
    try:
        agent_id = await session.start()
    except Exception as exc:
        log.exception("voice_agent: start failed channel=%s", channel)
        raise VoiceAgentError(f"Agora rejected the agent: {exc}") from exc

    _sessions[agent_id] = session
    log.info("voice_agent: started agent_id=%s channel=%s", agent_id, channel)

    # ── ONE AGENT PER CHANNEL, ENFORCED AGAINST AGORA ──────────────────────
    # Adding a person replaces the agent (remote_rtc_uids is fixed at
    # creation), and nothing reaped the predecessor. Live inspection found
    # FOUR agents RUNNING on one channel, all subscribed to a single uid and
    # all answering — which is both "it only listens to one person" and
    # "the transcript catches only some words", since several agents publish
    # interleaved frames for the same speech.
    #
    # Best effort: a stray we cannot stop must not fail the join.
    try:
        reaped = await stop_strays(channel, keep_agent_id=agent_id)
        if reaped:
            log.info("voice_agent: reaped %d stray agent(s) on %s", reaped, channel)
    except Exception:
        log.warning("voice_agent: stray sweep failed on %s", channel, exc_info=True)
    return {"agent_id": agent_id, "channel": channel, "status": "started"}


async def _agent_channel(agent_id: str) -> str | None:
    """
    Which channel an agent is serving, read straight off the REST API.

    The SDK's typed models for both `get` and `get_history` omit `channel`,
    but the history endpoint returns it. Identification matters more than
    elegance here: a project-wide sweep that cannot tell channels apart would
    stop an agent serving a different bridge, which is unrecoverable for the
    people on it.

    Returns None when it cannot be determined, and the caller then leaves the
    agent alone.
    """
    import base64

    import httpx

    settings = config.agora()
    raw = f"{settings.customer_id}:{settings.customer_secret}".encode()
    auth = "Basic " + base64.b64encode(raw).decode()
    url = f"{settings.conv_ai_base}/agents/{agent_id}/history"

    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.get(url, headers={"Authorization": auth})
        if not resp.is_success:
            return None
        return resp.json().get("channel")
    except Exception:
        return None


async def stop_strays(channel: str, keep_agent_id: str | None = None) -> int:
    """
    Stop every OTHER agent Agora still has running on this channel.

    ── WHY THIS IS NOT HOUSEKEEPING ────────────────────────────────────────
    Nothing ever reaped them, and they do not expire quickly. Live inspection
    found FOUR agents RUNNING on `inc-4417` at once, each from a previous
    join, each subscribed to uid 1001 and each answering out loud.

    That single fact produces both of the symptoms reported:

      - "it only listens to one person" — every one of those agents predates
        multi-uid subscription, so whichever answered first was pinned to
        1001 and deaf to 1002 and 1003.
      - "the transcript only catches some of the words" — several agents
        share one channel and all publish transcript frames for the same
        speech. They interleave and interrupt each other, so what any console
        renders is a shredded mix of several agents' partial views.

    Adding a person REPLACES the agent (remote_rtc_uids is fixed at creation),
    so without this every join leaves its predecessor behind. Three people
    joining means three agents in the room.

    Best effort by design: a stray we cannot stop must not fail the join that
    is trying to fix the room.
    """
    stopped = 0

    # ── WHY THIS IS RAW REST AND NOT THE SDK ────────────────────────────────
    # `client.agents.list(...)` was called as an async pager:
    #
    #     pager = client.agents.list(settings.app_id, limit=100)
    #     items = [item async for item in pager]
    #
    # It is not a pager. In this SDK version `list` is a plain coroutine, so
    # `async for` raised `TypeError: 'async for' requires __aiter__, got
    # coroutine` on the FIRST line of the try — every single call. The
    # `except` swallowed it, logged one line, and returned 0.
    #
    # So the reaper has never stopped anything. It reported success by
    # returning a number, and that number was always zero — which is exactly
    # the "FOUR agents RUNNING on inc-4417" this function's docstring
    # describes, still happening with the fix supposedly in place.
    #
    # Awaiting it properly does not help either: `list` authenticates
    # differently from the rest of the API and answers a correct customer pair
    # with `401 Invalid authentication type`. The REST endpoint takes the same
    # HTTP Basic credential every other call here uses, so it is used directly
    # — the same choice `_channel_of` already made one function above.
    #
    # ── LIST WITHOUT FILTERS, FILTER HERE ───────────────────────────────────
    # `channel=` and `state=` are accepted and then return an EMPTY list while
    # agents are demonstrably running: the same project answered
    # `?channel=inc-4417&state=RUNNING` with zero entries and `?limit=5` with
    # three RUNNING agents. Ask for everything and filter locally, where it
    # cannot be silently ignored.
    import base64

    import httpx

    settings = config.agora()
    raw = f"{settings.customer_id}:{settings.customer_secret}".encode()
    auth = "Basic " + base64.b64encode(raw).decode()

    try:
        async with httpx.AsyncClient(timeout=15.0) as http:
            resp = await http.get(
                f"{settings.conv_ai_base}/agents",
                headers={"Authorization": auth},
                params={"limit": 100},
            )
        if not resp.is_success:
            log.warning(
                "voice_agent: could not list agents on %s — HTTP %s %s",
                channel, resp.status_code, resp.text[:200],
            )
            return 0
        # {"data": {"list": [{"agent_id","status","start_ts"}, ...]}}
        items = (resp.json().get("data") or {}).get("list") or []
    except Exception:
        log.warning("voice_agent: could not list agents on %s", channel, exc_info=True)
        return 0

    log.info("voice_agent: reaper sees %d agent(s) project-wide", len(items))

    for item in items:
        aid = item.get("agent_id")
        if not aid or aid == keep_agent_id:
            continue

        # Only stop what is actually alive. The list carries ended agents too,
        # and a stop against one of those is a wasted round trip that logs a
        # scary-looking 404.
        state = str(item.get("status") or "").upper()
        if state not in ("RUNNING", "STARTING", "CREATING"):
            continue

        # ── CONFIRM THE CHANNEL BEFORE STOPPING ANYTHING ────────────────────
        # The list response carries only {agent_id, status, start_ts} — no
        # channel — so a project-wide sweep would happily kill an agent
        # serving a DIFFERENT bridge. `get` is the only place the channel is
        # exposed, so each candidate is confirmed individually.
        #
        # An agent we cannot identify is LEFT ALONE. Killing the wrong bridge
        # is unrecoverable for the people on it; leaving a stray costs one
        # duplicate voice that the next join will clear.
        # ── THE SDK MODELS DROP `channel`, SO ASK REST DIRECTLY ────────────
        # `agents.get` returns {message, start_ts, stop_ts, status, agent_id}
        # and `agents.get_history` parses into {agent_id, start_ts, status,
        # contents} — neither model keeps `channel`, though the raw history
        # JSON carries it. Rather than guess, read the field off the wire.
        if await _agent_channel(aid) != channel:
            continue
        try:
            # `stop()` rather than a bare SDK call: it already prefers the
            # live session and falls back to REST, which is the same
            # both-paths handling a stray needs. The previous code called
            # `client.stop_agent(aid)` against a `client` local that no
            # longer exists here, so every reap raised NameError inside this
            # handler — the stray was correctly identified and then never
            # stopped.
            await stop(aid)
            stopped += 1
            log.info("voice_agent: stopped stray agent %s on %s", aid, channel)
        except Exception:
            log.warning("voice_agent: could not stop stray %s", aid, exc_info=True)

    return stopped


async def stop(agent_id: str) -> None:
    """Stop an agent, preferring its live session and falling back to REST."""
    if not agent_id.strip():
        raise VoiceAgentError("agent_id is required")

    session = _sessions.pop(agent_id, None)
    if session is not None:
        try:
            await session.stop()
            log.info("voice_agent: stopped via session agent_id=%s", agent_id)
            return
        except Exception:
            # A restart empties `_sessions` while Agora still holds the agent,
            # so a stale entry must not be the end of the road.
            log.warning(
                "voice_agent: session stop failed, falling back agent_id=%s",
                agent_id, exc_info=True,
            )

    await _agora_client().stop_agent(agent_id)
    log.info("voice_agent: stopped via client agent_id=%s", agent_id)
