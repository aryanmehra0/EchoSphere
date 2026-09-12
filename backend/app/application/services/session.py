"""
The incident session — everything that is "this bridge, right now".

────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

All of this state used to be eight module-level globals in `main.py`:

    ledger, hub, window, engine, proxy, degraded, privacy, _agent

Three problems came with that shape, and all three were visible in the code
rather than theoretical:

  1. `/incident/reset` had to REBIND them, so it carried a `global` statement
     naming five of them — and it still could not reset the contradiction
     engine's cooldown table without reaching past the encapsulation
     (`engine._cooldown.clear()  # noqa: SLF001`).

  2. The ingestion pipeline could not be tested without importing the FastAPI
     app, because the state it operates on lived beside the routes.

  3. A second incident was structurally impossible. Not "unsupported" —
     impossible, because there was exactly one Ledger per process.

Grouping them here fixes all three at once: reset becomes "drop this session
and build another", the pipeline takes a session as an argument, and a second
channel is a second `IncidentSession` rather than a second process.

────────────────────────────────────────────────────────────────────────────
WHAT IS DELIBERATELY *NOT* HERE

The `httpx.AsyncClient`. It is owned by the app lifespan, not by an incident:
one pooled client should outlive any single bridge, and tying its lifetime to
a reset would tear down live connections mid-call.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.application.services.extraction import TurnWindow
from app.domain.ledger import Ledger
from app.domain.policies.contradiction import ContradictionEngine
from app.domain.policies.degradation import Degradation
from app.domain.policies.privacy import PrivacyGate
from app.domain.policies.proxy import ProxyActionLayer
from app.infrastructure import config
from app.infrastructure.deltas import DeltaHub

log = logging.getLogger("echo.session")

DEFAULT_CHANNEL = "inc-4417"


class TooManySessions(RuntimeError):
    """Raised by `SessionRegistry.get_or_create` when creating a session for
    a genuinely new channel would exceed `config.max_concurrent_incidents()`.
    An already-existing channel is never affected by this — only growth is
    capped."""


class IncidentSession:
    """
    One bridge's live state, and the lock that serialises analysis of it.

    Everything on here is per-incident and disposable. Constructing a new
    instance IS the reset: there is no `clear()` to get subtly wrong, and no
    field that can be forgotten because it was added after the reset was
    written.
    """

    def __init__(self, channel: str = DEFAULT_CHANNEL) -> None:
        self.channel = channel

        # The record, and the fan-out that carries it to every dashboard.
        self.ledger = Ledger(channel=channel)
        self.hub = DeltaHub()

        # The analysis path.
        self.window = TurnWindow()
        self.engine = ContradictionEngine()

        # Governance and consent.
        self.proxy = ProxyActionLayer(channel=channel)
        self.privacy = PrivacyGate()

        # What is currently broken, in the operator's language.
        self.degraded = Degradation()

        # The live Agora agent, registered by Zone 2 once /api/invite-agent
        # succeeds. State rather than config: it changes every session, and
        # only Zone 2 knows the id because it holds the credentials that made
        # it.
        self.agent: dict[str, str | None] = {"agent_id": None, "channel": None}

        # Who is actually on this bridge, and what they're allowed to approve.
        # Recorded ONCE, server-side, at join time (POST /bridge/roster) by
        # Zone 2 after it has already decided — from the authenticated
        # enterprise identity, not a free client claim — what role a
        # participant may hold. `/approval/redeem` looks a uid up here rather
        # than trusting whatever role string arrives with the redeem request;
        # without this, redemption had no real roster to check against at all.
        self.roster: dict[int, dict[str, Any]] = {}

        # Serialises the pipeline. Both an incoming frame and the flush ticker
        # can reach extraction, and running the same window twice would double
        # every claim in it.
        self.pipeline_lock = asyncio.Lock()

        # In-flight background analyses, held strongly. asyncio keeps only a
        # weak reference to a running task, so a dropped one can be cancelled
        # mid-extraction by the garbage collector — silently losing claims for
        # speech that was already spoken.
        self.pipeline_tasks: set[asyncio.Task[Any]] = set()

        # True from the moment a pipeline task is spawned until that task
        # actually acquires `pipeline_lock` and starts running (cleared by
        # `PipelineRunner.run`). Under sustained LLM slowness, every incoming
        # transcript used to spawn its own task, and each one just queues on
        # the same lock — since `WindowDrainStep` re-checks the window fresh
        # once a task finally runs, a task still queued behind another is
        # guaranteed to pick up everything accumulated by then, so spawning
        # more than one queued-but-not-yet-running task per session is pure
        # redundant overhead, not extra throughput. `ingest.py`'s fallback
        # (non-Redis-stream) spawn path checks this before spawning.
        self.pipeline_pending = False

        # Phase 5 (P1): Rehydrate from event store if snapshots exist for this channel
        from app.infrastructure import event_store
        try:
            snapshots = event_store.load_channel_snapshots(channel)
            if snapshots:
                self.ledger.rehydrate_from_snapshot(snapshots)
                events = event_store.replay_events(channel)
                if events:
                    max_seq = max(e["seq"] for e in events)
                    self.hub._seq = max_seq
                log.info(
                    "session: rehydrated channel %s (%d claims, %d entities, seq=%d)",
                    channel, len(self.ledger.claims), len(self.ledger.entities), self.hub.seq,
                )
        except Exception as exc:
            log.warning("session: failed to rehydrate channel %s from event store: %s", channel, exc)

    # -- the reset seam ----------------------------------------------------

    def spawn_pipeline(self, coro: Any, *, on_error: Any = None) -> asyncio.Task[Any]:
        """
        Run one pipeline pass in the background, holding a strong reference.

        Callers used to do this inline in the route handler, including the
        `add_done_callback` that keeps the task alive. Centralised so the
        "hold a reference or the GC cancels it" rule is applied in exactly one
        place rather than remembered at each call site.
        """
        task = asyncio.create_task(coro)
        self.pipeline_tasks.add(task)
        task.add_done_callback(self.pipeline_tasks.discard)
        if on_error is not None:
            task.add_done_callback(on_error)
        return task

    @property
    def in_flight(self) -> int:
        """How many analyses are running — reported by /health."""
        return len(self.pipeline_tasks)


class SessionRegistry:
    """
    The process's sessions, keyed by channel.

    A registry rather than a bare module global because `/incident/reset`
    needs to REPLACE a session, and every route needs to find the current one
    by identity rather than by holding a stale reference. Handlers ask the
    registry each time; nothing caches the object across a request.

    Single-channel today — every route resolves to `current()` — but the
    keying is real, so admitting a second bridge is a routing change rather
    than an architectural one.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, IncidentSession] = {}
        self._default = DEFAULT_CHANNEL
        # Sessions that have been reset away but may still have analysis in
        # flight. See `total_in_flight`.
        self._retired: list[IncidentSession] = []

    def get_or_create(self, channel: str | None = None) -> IncidentSession:
        """
        Get or create an IncidentSession for a specific channel or the default.

        Raises `TooManySessions` rather than creating one when the channel is
        genuinely new AND the process is already at `max_concurrent_incidents`
        — an existing channel is always returned regardless of that cap, so
        this only ever blocks growth, never a channel already in use.
        """
        target_channel = (channel or "").strip() or self._default
        session = self._sessions.get(target_channel)
        if session is None:
            limit = config.max_concurrent_incidents()
            if len(self._sessions) >= limit:
                raise TooManySessions(
                    f"already at the {limit}-incident limit (MAX_CONCURRENT_INCIDENTS); "
                    f"refusing to create a session for a new channel {target_channel!r}"
                )
            session = IncidentSession(target_channel)
            self._sessions[target_channel] = session
            log.info("session: created for channel %s", target_channel)
        return session

    def current(self) -> IncidentSession:
        """The default active session, created on first use."""
        return self.get_or_create(self._default)

    def list_channels(self) -> list[str]:
        """Return all active channel identifiers."""
        return list(self._sessions.keys())

    @property
    def total_in_flight(self) -> int:
        """
        Analyses running anywhere in this process, retired sessions included.

        ── WHY THIS IS NOT `current().in_flight` ───────────────────────────
        `/health` publishes this as `pipeline.inFlight`, and Rehearsal Rig
        Tier 3 polls it to decide when a run has finished — it treats zero as
        "the pipeline is idle, safe to assert".

        A reset replaces the session, but a pipeline task spawned just before
        it keeps running against the OLD session, which is where its task
        handle lives. Reporting only the current session's count made
        `inFlight` read 0 while an extraction from the previous run was still
        in flight, so Tier 3 sampled early. That surfaced as run 2 of 3
        failing "hypothesis kept OUT of established" — the claim was not
        missing, it had not landed yet.

        Before the session refactor a single module-global set held every
        task, so this was true by accident. Now it has to be deliberate.
        """
        live = sum(s.in_flight for s in self._sessions.values())

        # Drop retired sessions once their work has drained, so this list
        # cannot grow across a long rehearsal.
        self._retired = [s for s in self._retired if s.in_flight]
        return live + sum(s.in_flight for s in self._retired)

    def reset(self, channel: str | None = None) -> IncidentSession:
        """
        Replace the session for the given channel (or default) with a fresh one.

        This is the whole reason the class exists. Previously five module
        globals were rebound by hand and the engine's cooldown was cleared
        through a private attribute; a field added to the incident later would
        simply have been missed. Now anything that lives on the session is
        reset by construction, and nothing has to remember to do it.

        A new incident deliberately starts ON the record: carrying a privacy
        pause across a reset would mean the next incident silently records
        nothing, which is the one failure mode of that feature nobody would
        notice until afterwards. `PrivacyGate()` in `__init__` guarantees it.
        """
        target_channel = (channel or "").strip() or self._default
        old = self._sessions.get(target_channel) or IncidentSession(target_channel)

        cancelled = 0
        for task in list(old.pipeline_tasks):
            if not task.done():
                task.cancel()
                cancelled += 1
        if cancelled:
            self._retired.append(old)
            log.info(
                "session: cancelled %d in-flight analysis task(s) on reset for %s",
                cancelled,
                target_channel,
            )

        from app.infrastructure import event_store
        try:
            event_store.clear_channel(target_channel)
        except Exception as exc:
            log.warning("session: failed to clear event store for %s on reset: %s", target_channel, exc)

        session = IncidentSession(target_channel)
        self._sessions[target_channel] = session
        log.info("session: reset for channel %s", target_channel)
        return session


# The process-wide registry. Imported by the routers and by the pipeline.
registry = SessionRegistry()
