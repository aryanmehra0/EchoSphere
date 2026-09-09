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
from app.infrastructure.deltas import DeltaHub

log = logging.getLogger("echo.session")

DEFAULT_CHANNEL = "inc-4417"


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

        # Serialises the pipeline. Both an incoming frame and the flush ticker
        # can reach extraction, and running the same window twice would double
        # every claim in it.
        self.pipeline_lock = asyncio.Lock()

        # In-flight background analyses, held strongly. asyncio keeps only a
        # weak reference to a running task, so a dropped one can be cancelled
        # mid-extraction by the garbage collector — silently losing claims for
        # speech that was already spoken.
        self.pipeline_tasks: set[asyncio.Task[Any]] = set()

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

    def current(self) -> IncidentSession:
        """The active session, created on first use."""
        session = self._sessions.get(self._default)
        if session is None:
            session = IncidentSession(self._default)
            self._sessions[self._default] = session
            log.info("session: created for channel %s", self._default)
        return session

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

    def reset(self) -> IncidentSession:
        """
        Replace the active session with a fresh one, keeping the channel.

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
        old = self.current()
        channel = old.channel

        # ── CANCEL THE PREVIOUS INCIDENT'S ANALYSIS ────────────────────────
        #
        # A pipeline task spawned moments before the reset is still extracting
        # the OLD incident's window. Two things go wrong if it is left alone:
        #
        #   - it publishes the previous run's claims onto the hub the fresh
        #     dashboards are now reading, so a cleared board repopulates with
        #     the incident that was just discarded;
        #   - `/health` reported `inFlight` from the current session only, so
        #     the straggler was invisible and Rehearsal Rig Tier 3 sampled
        #     while it was still writing. That is what failed run 2 of 3 on
        #     "hypothesis kept OUT of established" — the claim was late, not
        #     missing.
        #
        # A reset means "this incident is over", so cancelling is the honest
        # reading. The frames it was working on belonged to the discarded
        # incident and are not wanted in the new one.
        #
        # It is still RETIRED rather than dropped, because cancellation is not
        # instantaneous — the task observes it at its next await. Retired
        # sessions keep counting toward `total_in_flight` until they actually
        # finish, so a harness polling `inFlight` waits for the real quiescence.
        cancelled = 0
        for task in list(old.pipeline_tasks):
            if not task.done():
                task.cancel()
                cancelled += 1
        if cancelled:
            self._retired.append(old)
            log.info(
                "session: cancelled %d in-flight analysis task(s) on reset", cancelled,
            )

        session = IncidentSession(channel)
        self._sessions[channel] = session
        log.info("session: reset for channel %s", channel)
        return session


# The process-wide registry. Imported by the routers and by the pipeline.
registry = SessionRegistry()
