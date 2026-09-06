"""
Durable storage for the Evidence Ledger.

────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

The Ledger is the product's entire argument: every claim carries a source and
an epistemic status, and "ask eight times, get eight identical answers" is a
structural property of reading from it rather than from a model's memory. All
of that lived in a Python dict, so a backend restart mid-incident erased the
record while the bridge was still going — and there was no way to review an
incident afterwards, which is most of what an incident record is for.

────────────────────────────────────────────────────────────────────────────
WHY IT IS WRITE-BEHIND AND NOT WRITE-THROUGH

The in-memory Ledger stays the source of truth for reads. Writes are mirrored
to Postgres in the background and failures are logged, never raised.

That is deliberate. `/observer/transcript` sits on the voice hot path, and
`query_incident_state` is called synchronously by Agora's servers while a human
waits for Echo to answer. Putting a database round trip — or worse, a database
OUTAGE — in front of either would trade a durable record for a bridge that
stops working. A Ledger that is briefly behind on disk is recoverable; an
incident where Echo stopped answering is not.

The consequence is honest: if Postgres is down, the last few writes are lost on
restart. `/health` reports that state rather than hiding it.

────────────────────────────────────────────────────────────────────────────
WHY THE MAPPING IS GENERIC

Every model is a plain dataclass, and `dataclasses.fields()` already knows the
column names — they were chosen to match. Hand-writing eight INSERT statements
with eight field lists would create eight places to forget a new field, and the
failure mode is silent: the column simply never gets written.

So the column list is derived from the dataclass, and adding a field to a model
means adding one column to `schema.sql` and nothing else here.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import fields, is_dataclass
from typing import Any, Iterable

from . import config

log = logging.getLogger("echo.store")

# asyncpg is imported lazily for the same reason the Agora SDK is: the Slow
# Loop must still serve the dashboard on a machine where it is not installed.
_pool: Any = None
_enabled = False
_last_error: str | None = None

# Which table each dataclass belongs in, and which columns are JSON-encoded.
# Kept here rather than on the models so `models.py` stays free of storage
# concerns — it is imported by the Rehearsal Rig and the tests, neither of
# which should pull in a database vocabulary.
_TABLES: dict[str, str] = {
    "Claim": "claims",
    "Entity": "entities",
    "Link": "links",
    "Unchecked": "unchecked",
    "Task": "tasks",
    "Contradiction": "contradictions",
    "TimelineEvent": "timeline",
    "Transcript": "transcripts",
}

def _is_json_column(record: Any, column: str) -> bool:
    """
    Whether a column holds JSON, decided from the VALUE, not a hand-list.

    ── WHY NOT A HARDCODED SET ─────────────────────────────────────────────
    It was one: {position, aliases, evidence, speakers, panel} — and it missed
    `Claim.contradicts`, which is a `list[str]`. asyncpg rejected the write
    with "expected str, got list", so every claim carrying a contradiction
    silently failed to persist while everything around it succeeded. The
    Ledger on disk would have been quietly missing exactly the rows the
    product exists to record.

    A hand-maintained list of column names is a second source of truth that
    drifts the moment a model gains a field. Asking the value what it is
    cannot drift.
    """
    return isinstance(getattr(record, column, None), (list, dict))


# Columns the schema declares as JSONB. Kept only so `load` knows what to
# decode; writes decide from the value itself (see `_is_json_column`).
_JSON_COLUMNS: frozenset[str] = frozenset(
    {"position", "aliases", "evidence", "speakers", "panel", "contradicts"}
)

# The primary key column for each table, beside `channel`.
_KEYS: dict[str, str] = {
    "transcripts": "message_id",
}


def _key_column(table: str) -> str:
    return _KEYS.get(table, "id")


async def connect() -> bool:
    """
    Open the pool, or report why not. Never raises.

    Returns True when the Ledger will be persisted.
    """
    global _pool, _enabled, _last_error

    if not config.persistence_enabled():
        log.info("store: persistence disabled by LEDGER_PERSISTENCE")
        _enabled = False
        return False

    dsn = config.database_url()
    if not dsn:
        _enabled = False
        return False

    try:
        import asyncpg
    except ImportError:
        _last_error = "asyncpg is not installed (pip install asyncpg)"
        log.warning("store: %s — the Ledger will not be persisted", _last_error)
        _enabled = False
        return False

    try:
        # Small pool: this process is the only writer, and the work is short
        # background upserts rather than concurrent request handling.
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4, timeout=10)
        async with _pool.acquire() as conn:
            await conn.execute("SELECT 1")
    except Exception as exc:  # noqa: BLE001 — absence must not stop the service
        _last_error = str(exc)[:200]
        log.warning(
            "store: could not reach Postgres (%s) — running with an in-memory "
            "Ledger only. `docker compose up -d` starts it.",
            _last_error,
        )
        _pool = None
        _enabled = False
        return False

    _enabled = True
    _last_error = None
    log.info("store: Ledger persistence is ON")
    return True


async def close() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def status() -> dict[str, Any]:
    """Reported by /health, so a silent fallback is never actually silent."""
    return {
        "enabled": _enabled,
        "error": _last_error,
    }


def _columns(record: Any) -> list[str]:
    return [f.name for f in fields(record)]


def _value(record: Any, column: str) -> Any:
    """JSON-encode list/dict values; pass everything else through."""
    raw = getattr(record, column)
    if _is_json_column(record, column):
        return json.dumps(raw)
    if column in _JSON_COLUMNS and raw is None:
        return None
    return raw


async def _upsert(record: Any, channel: str) -> None:
    if not _enabled or _pool is None or not is_dataclass(record):
        return

    table = _TABLES.get(type(record).__name__)
    if table is None:
        return

    cols = _columns(record)
    key = _key_column(table)

    # channel first, then the dataclass's own fields, in declaration order.
    names = ["channel", *cols]
    placeholders = ", ".join(f"${i}" for i in range(1, len(names) + 1))
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != key)

    sql = (
        f"INSERT INTO {table} ({', '.join(names)}) VALUES ({placeholders}) "
        f"ON CONFLICT (channel, {key}) DO UPDATE SET {updates}"
    )
    values = [channel, *[_value(record, c) for c in cols]]

    try:
        async with _pool.acquire() as conn:
            await conn.execute(sql, *values)
    except Exception as exc:  # noqa: BLE001 — see the write-behind note above
        log.warning("store: could not persist %s: %s", table, str(exc)[:200])


def save(record: Any, channel: str) -> None:
    """
    Persist one record, in the background.

    Fire-and-forget on purpose: callers are on the voice hot path. The task is
    held in `_tasks` because asyncio keeps only a weak reference to a running
    task, and a dropped one can be cancelled mid-write by the garbage
    collector — the same trap `main.py` documents for the analysis pipeline.
    """
    if not _enabled:
        return
    try:
        task = asyncio.create_task(_upsert(record, channel))
    except RuntimeError:
        # No running loop (a synchronous test, the Rehearsal Rig). Persistence
        # is a side effect; its absence must not break the caller.
        return
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


_tasks: set[asyncio.Task[Any]] = set()


def save_many(records: Iterable[Any], channel: str) -> None:
    for record in records:
        save(record, channel)


async def clear(channel: str) -> None:
    """Drop one channel's record — the durable half of /incident/reset."""
    if not _enabled or _pool is None:
        return
    try:
        async with _pool.acquire() as conn:
            for table in set(_TABLES.values()):
                await conn.execute(f"DELETE FROM {table} WHERE channel = $1", channel)
        log.info("store: cleared persisted ledger for %s", channel)
    except Exception as exc:  # noqa: BLE001
        log.warning("store: could not clear %s: %s", channel, str(exc)[:200])


async def load(channel: str) -> dict[str, list[dict[str, Any]]]:
    """
    Read one channel's record back, as plain rows keyed by table.

    Returned as dicts rather than model instances so the caller decides how to
    rehydrate; `Ledger.restore` does that, and keeping the two apart means this
    module never imports `models`.
    """
    if not _enabled or _pool is None:
        return {}

    out: dict[str, list[dict[str, Any]]] = {}
    try:
        async with _pool.acquire() as conn:
            for table in set(_TABLES.values()):
                order = " ORDER BY at" if table not in ("entities", "links") else ""
                rows = await conn.fetch(
                    f"SELECT * FROM {table} WHERE channel = $1{order}", channel
                )
                out[table] = [
                    {
                        k: (json.loads(v) if k in _JSON_COLUMNS and isinstance(v, str) else v)
                        for k, v in dict(r).items()
                        if k != "channel"
                    }
                    for r in rows
                ]
    except Exception as exc:  # noqa: BLE001
        log.warning("store: could not load %s: %s", channel, str(exc)[:200])
        return {}

    return out
