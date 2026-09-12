"""
The "hold a strong reference or the GC cancels it" rule, in one place.

asyncio keeps only a WEAK reference to a task created via
`asyncio.create_task`/`loop.create_task` — nothing else holding one means the
task can be garbage-collected mid-execution, silently cancelling whatever it
was doing. `store.py`'s Postgres mirror and `application/services/session.py`'s
`spawn_pipeline` both already solved this with the same shape (a module/
instance-level `set` plus `add_done_callback(discard)`); this is that shape
factored out so a new fire-and-forget call site doesn't have to reinvent it —
or, as happened for real, skip it. `domain/ledger.py`'s vector-store/Redis
mirror writes and `infrastructure/deltas.py`'s delta-log mirror both used
`loop.create_task(...)` directly with nothing holding the result.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Coroutine

_tasks: set[asyncio.Task[Any]] = set()


def spawn(make_coro: Callable[[], Coroutine[Any, Any, Any]]) -> asyncio.Task[Any] | None:
    """
    Schedule the coroutine `make_coro()` produces in the background, holding
    a strong reference until it completes. Returns `None` (constructing
    nothing) when there is no running event loop, rather than raising.

    Takes a zero-argument CALLABLE, not an already-built coroutine, and this
    is load-bearing, not a style choice: `spawn(some_coroutine_fn(...))`
    evaluates `some_coroutine_fn(...)` — constructing the coroutine object —
    before `spawn` ever runs. If there is then no running loop, that
    coroutine was already created and is never awaited or closed, which is
    exactly the `RuntimeWarning: coroutine '...' was never awaited` this
    module exists to avoid (found live: the first version of this helper
    had precisely this bug). Passing a callable defers construction until
    after the loop check, so nothing is created on the no-loop path at all.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    task = loop.create_task(make_coro())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task
