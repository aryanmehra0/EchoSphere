"""
Observer ingress — the adapter seam (v6 §4.3).

One role-attributed utterance enters the Slow Loop here, and this is the only
way in.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter

from app.application.services import pipeline
from app.application.services.extraction import note_redactions
from app.domain.models import TimelineEvent, Transcript, now_ms
from app.domain.policies.redaction import redact
from app.domain.policies.utterance import EpistemicViolation
from app.infrastructure import store
from ..deps import session, speech

log = logging.getLogger("echo.ingest")

router = APIRouter()

# Echo's own UIDs. G2: the agent joins the channel as a real participant, so
# without this its own speech is transcribed, embedded as a claim, and entered
# into the contradiction index — where it contradicts itself, injects an alert
# about its own statement, speaks about it, and transcribes that too.
AGENT_UIDS = (9000, 9001)


@router.post("/observer/transcript")
async def ingest_transcript(body: dict[str, Any]) -> dict[str, Any]:
    """
    One role-attributed utterance enters the Slow Loop here.

    ── WHY THIS IS AN HTTP ENDPOINT ────────────────────────────────────────
    v6 §4.3 has the Observer pulling per-UID PCM straight off the SD-RTN via
    `on_playback_audio_frame_before_mixing`, which needs the Agora Python
    Server SDK. That SDK has no wheel for Python 3.14 — the only interpreter
    available — and fails to build from source.

    So the Observer is a pluggable ADAPTER and this is its seam. Whatever
    produces role-attributed text calls this endpoint; everything downstream is
    identical. That also makes Rehearsal Rig Tier 2 (§15) trivial, since
    synthetic transcripts drive the exact same path as live audio.

    The agent-UID exclusion that closes G2 lives here too: Echo's own speech
    must never re-enter the Ledger as if a human said it.
    ────────────────────────────────────────────────────────────────────────
    """
    current = session()
    ledger = current.ledger
    hub = current.hub
    privacy = current.privacy

    uid = int(body.get("uid", 0))
    role = (body.get("role") or "").strip()
    text = (body.get("text") or "").strip()

    if not text:
        return {"ignored": "empty text"}

    # G2 — the first branch, before anything is allocated. Echo's own audio is
    # discarded at the earliest possible point.
    if uid in AGENT_UIDS or role.lower() == "echo":
        log.info("observer: dropped uid %s (agent exclusion, G2)", uid)
        return {"ignored": "agent audio", "uid": uid}

    if not role:
        # An unattributable participant is an error worth logging, not a
        # routine case to guess at (§4.2's ordering rule makes this rare).
        log.warning("observer: uid %s has no role — claim would be unsourced", uid)
        return {"ignored": "unattributed uid", "uid": uid}

    # ── §10.5 CONSENT GATE — before redaction, before extraction, before the
    # transcript is published to a single dashboard.
    #
    # Position is the entire feature. Redaction decides what a VENDOR sees;
    # this decides whether the utterance is processed at all. A suspended turn
    # must not be handled more carefully — it must not be handled.
    decision = privacy.evaluate(text, role)

    if decision.action == "drop":
        # Counted, never stored. `text` is not logged, not published, not kept.
        return {"ignored": "off the record", "recording": False}

    if decision.action in ("pause", "resume"):
        # The control phrase itself is minuted in both directions: "Priya took
        # the bridge off the record at 14:32" is what an incident review needs,
        # and it reveals nothing about what was then said in private.
        event = ledger.add_timeline(TimelineEvent(
            id=f"tl-{now_ms()}",
            kind="decision",
            text=(
                f"{role} took the bridge OFF THE RECORD — Echo stopped minuting"
                if decision.action == "pause"
                else f"{role} brought the bridge BACK ON THE RECORD"
            ),
            actor=role,
        ))
        await hub.publish({
            "timeline": [event.to_wire()],
            "privacy": privacy.state.to_wire(),
        })
        # Echo says it out loud, because a recording state the room cannot
        # perceive is worse than none at all.
        #
        # Wrapped, and the reason is a real 500: the §6 tripwire refused
        # "Recording resumed." for naming no source, the exception escaped the
        # handler, and the whole ingest endpoint returned a non-JSON error.
        # The phrase is allowed now — but a guard that can crash the path
        # carrying every utterance is the wrong shape regardless of which
        # phrases currently pass it. Losing the announcement costs a spoken
        # confirmation; losing the endpoint costs the incident record.
        spoke = False
        try:
            if decision.announce:
                result = await speech(current).say(decision.announce, preempt=True)
                spoke = bool(result and result.ok)
        except EpistemicViolation as exc:
            log.error("privacy: refused to speak a §6-violating line: %s", exc)
        except Exception:  # noqa: BLE001 — see above; never break ingestion
            log.exception("privacy: could not announce the recording change")

        return {"accepted": True, "recording": privacy.state.recording,
                "announced": decision.announce, "spoken": spoke}

    """
    ── REDACT HERE, AT THE DOOR, NOT LATER ─────────────────────────────────
    Redaction used to happen ONLY inside `extraction.extract()`, which runs
    on the window a second or two later. Everything upstream of that saw raw
    speech — and there is a lot upstream:

        store.save(t)        -> the secret is now on disk, permanently
        hub.publish(...)     -> it renders in every open dashboard
        window.add(t)        -> it reaches the extraction LLM anyway

    Reported live. Spoken on the bridge:

        "The admin password is Hunter two, and the API key is sk-test-12345"

    and every layer faithfully recorded it: transcript rendered, two OBSERVED
    claims filed at 100% confidence, both rows persisted to Postgres. Then
    somebody asked "what is the admin password?" and Echo READ IT BACK ALOUD,
    correctly, from its own record.

    The design intent was never in doubt — `privacy.py`'s own comment says
    redaction "decides what a VENDOR sees". That was the mistake: a vendor is
    not the only thing that must not see a credential. Our own disk, our own
    dashboard and our own voice channel all must not either.

    So it moves to the ingest boundary, where a single call covers every
    downstream consumer at once. §10.4 says transcripts are session-scoped and
    purged; it did not say they could be written in the clear on the way there.
    """
    redacted = redact(text)
    if redacted.count:
        note_redactions(redacted.count)
        log.info(
            "observer: redacted %d span(s) before storing or publishing", redacted.count,
        )

    t = Transcript(
        message_id=body.get("messageId") or f"m-{now_ms()}",
        uid=uid,
        role=role,
        text=redacted.text,
        is_final=bool(body.get("isFinal", True)),
        at=int(body.get("at") or now_ms()),
        speaker_name=body.get("speakerName") or body.get("speaker_name"),
        speaker_user_id=body.get("speakerUserId") or body.get("speaker_user_id"),
    )

    # Extraction batches on turn boundaries (§4.4). Only final frames enter the
    # window; the flush ticker handles the silence rule. `add` also rejects a
    # repeat of an utterance already accepted.
    accepted = current.window.add(t)

    # The raw record beneath the claims. "What exactly was said" is where
    # every disputed claim ends up, and extraction is not reversible.
    if accepted:
        store.save(t, ledger.channel)

    # A duplicate is not re-published either. The reducer would dedupe it by
    # messageId, but a delta that changes nothing still costs a render on every
    # connected dashboard — and a transcript appearing twice in the feed while
    # someone is reading it is its own small betrayal of trust.
    if accepted or not t.is_final:
        # The transcript reaches the dashboard immediately — an operator should
        # see words appear as they are spoken, not 1.5 s later when the window
        # flushes.
        await hub.publish({"transcripts": [t.to_wire()]})
    else:
        return {"accepted": False, "duplicate": True, "messageId": t.message_id}

    """
    THE PIPELINE RUNS IN THE BACKGROUND, and this is not an optimisation.

    Awaiting it here made the response time of `/observer/transcript` equal to
    the runtime of the whole analysis: extraction, entity resolution, and up to
    two Deliberation Panels, each of which honours Groq's rate-limit backoff by
    sleeping. A rehearsal on Aug 31 hit a 60-second ReadTimeout on a single
    utterance because of it.

    The caller is a BROWSER forwarding speech as it is spoken. Blocking it for
    a minute stalls every subsequent utterance behind the slow one, so a busy
    moment on the bridge — exactly when the analysis matters most — is exactly
    when transcripts stop arriving.

    Nothing is lost by returning early. The transcript has already been
    published above, and every result the pipeline produces reaches the
    dashboard over the delta socket, which is the asynchronous channel §9.3
    exists to provide. The pipeline takes the session's lock, so overlapping
    tasks are safe.
    """
    def _report(task: asyncio.Task[Any]) -> None:
        # `cancelled()` first: `/incident/reset` cancels the previous
        # incident's analysis on purpose, and calling `.exception()` on a
        # cancelled task raises CancelledError rather than returning it.
        if not task.cancelled() and task.exception() is not None:
            log.exception("pipeline failed in the background", exc_info=task.exception())

    # `spawn_pipeline` holds the strong reference — asyncio keeps only a weak
    # one, and a garbage-collected task cancels the analysis mid-flight.
    current.spawn_pipeline(
        pipeline.run_if_ready(current, speech(current)), on_error=_report,
    )

    return {
        "accepted": True,
        "messageId": t.message_id,
        # The analysis is now in flight rather than finished. Named so no
        # caller mistakes a fast 200 for a completed extraction.
        "queued": True,
    }
