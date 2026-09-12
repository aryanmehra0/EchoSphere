"""
Tests for `app.infrastructure.background_tasks.spawn` — the shared
"hold a strong reference or the GC cancels it" helper factored out of
`store.py`'s pattern for `domain/ledger.py` and `infrastructure/deltas.py`'s
fire-and-forget mirror writes, which previously used a bare
`asyncio.create_task`/`loop.create_task` with nothing else holding the
result.
"""

from __future__ import annotations

import asyncio
import unittest
import warnings

from app.infrastructure import background_tasks


class TestBackgroundTasksSpawn(unittest.IsolatedAsyncioTestCase):
    async def test_spawn_runs_the_coroutine_to_completion(self) -> None:
        ran = asyncio.Event()

        async def work() -> None:
            ran.set()

        task = background_tasks.spawn(lambda: work())
        self.assertIsNotNone(task)
        await asyncio.wait_for(ran.wait(), timeout=1.0)

    async def test_spawn_holds_a_strong_reference_until_completion(self) -> None:
        """The whole point: nothing else in the caller holds the task, so if
        `spawn` didn't keep its own strong reference, a GC pass could cancel
        it mid-flight. This doesn't force a GC (timing-dependent and
        flaky) — it instead asserts the module's own tracking set is what's
        holding it, which is the actual mechanism that prevents that."""
        started = asyncio.Event()
        finish = asyncio.Event()

        async def work() -> None:
            started.set()
            await finish.wait()

        task = background_tasks.spawn(lambda: work())
        await asyncio.wait_for(started.wait(), timeout=1.0)

        self.assertIn(task, background_tasks._tasks)

        finish.set()
        await asyncio.wait_for(task, timeout=1.0)
        # Discarded from the tracking set once done — this is what keeps it
        # from growing without bound over a long-running process.
        self.assertNotIn(task, background_tasks._tasks)

    def test_spawn_with_no_running_loop_constructs_nothing(self) -> None:
        """
        Regression: an earlier version of `spawn` took an already-built
        coroutine rather than a callable. `spawn(some_coro(...))` evaluates
        `some_coro(...)` — constructing the coroutine object — BEFORE
        `spawn` runs, so on the no-loop path that coroutine was created and
        then never awaited or closed: exactly the
        `RuntimeWarning: coroutine '...' was never awaited` this module
        exists to avoid. Taking a callable defers construction until after
        the loop check, so nothing is created at all here.
        """
        constructed = {"n": 0}

        def make_coro():
            constructed["n"] += 1
            async def work() -> None:
                pass
            return work()

        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            result = background_tasks.spawn(make_coro)  # no running loop in a plain sync test

        self.assertIsNone(result)
        self.assertEqual(constructed["n"], 0, "the coroutine must not be constructed with no loop to run it")


if __name__ == "__main__":
    unittest.main()
