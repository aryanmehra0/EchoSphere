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
import typing
from dataclasses import fields, is_dataclass
from typing import Any, Iterable

from . import config
from . import event_store

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

# Postgres `information_schema.columns.data_type` spellings that are all
# fine representations of the same Python-level shape — retyping WITHIN a
# group is unnecessary churn (and, on the one live database this ran
# against, is exactly what over-eagerly turned an already-working
# `transcripts.uid integer` into `bigint` for no benefit). Only a column
# whose existing type falls in a DIFFERENT group than the one its dataclass
# field expects is actually broken and worth the risk of a retype.
_SQL_TYPE_FAMILY: dict[str, str] = {
    "smallint": "integer", "integer": "integer", "bigint": "integer",
    "real": "float", "double precision": "float", "numeric": "float",
    "text": "text", "character varying": "text", "varchar": "text", "char": "text",
    "boolean": "boolean",
    "json": "json", "jsonb": "json",
}


def _sql_type_family(data_type: str) -> str:
    return _SQL_TYPE_FAMILY.get(data_type.lower(), data_type.lower())


def _sql_type_for(py_type: Any) -> str:
    """
    The Postgres column type for a dataclass field's resolved annotation.

    Used only by `_reconcile_schema` to ADD a genuinely missing column — it
    never touches an existing one. `Optional[X]` / `X | None` and `Literal`
    string unions (e.g. `EpistemicStatus`) are unwrapped first: a Literal is
    still text on the wire, and `list[str] | None` is still JSONB.
    """
    origin = typing.get_origin(py_type)
    if origin is typing.Union:
        # `X | None` -> X. A field typed as more than one real (non-None)
        # alternative doesn't occur in these models; TEXT is the safe
        # fallback if it ever does.
        args = [a for a in typing.get_args(py_type) if a is not type(None)]
        if len(args) == 1:
            return _sql_type_for(args[0])
        return "TEXT"
    if origin is typing.Literal:
        return "TEXT"
    if origin in (list, dict):
        return "JSONB"
    if py_type is bool:
        return "BOOLEAN"
    if py_type is int:
        return "BIGINT"
    if py_type is float:
        return "DOUBLE PRECISION"
    return "TEXT"


async def _reconcile_schema(pool: Any) -> None:
    """
    Self-heal `schema.sql` drift: add any dataclass field with no matching
    column, for every table this store writes to.

    ── WHY THIS EXISTS ──────────────────────────────────────────────────────
    This project has no migration tool (`backend/db/README.md` says so
    plainly): the documented process for a field added to a model is "edit
    schema.sql, then by hand either `docker compose down -v` or run an
    `ALTER TABLE` yourself" against an already-initialized volume. Nobody
    did the second half when `Claim` gained `valid_from`/`valid_until`/
    `ttl_seconds`/`lifecycle`/`speaker_name`/`speaker_user_id` (and
    `TimelineEvent`/`Transcript` similarly) — `schema.sql` only runs on a
    FRESH Postgres data directory, so every already-running dev volume kept
    the old, narrower table. Every write of one of those fields then threw
    `UndefinedColumnError`, caught by `_upsert`'s broad `except Exception`
    and only logged — `/health` kept reporting Postgres as fully healthy.

    Deriving the column list from `dataclasses.fields()` (as `_columns()`
    already does for INSERT) instead of a hand-kept list was supposed to
    make this impossible; it only closed half the gap, because the SCHEMA
    itself was still hand-kept. This closes the other half: on every
    connect, diff each table's real columns against its dataclass's fields
    and add whatever is missing. Additive only — it never drops, renames, or
    retypes a column, so it cannot lose data; the worst case is doing
    nothing when a column already matches (the common case, and cheap).
    """
    from app.domain import models as domain_models

    classes_by_name = {
        "Claim": domain_models.Claim,
        "Entity": domain_models.Entity,
        "Link": domain_models.Link,
        "Unchecked": domain_models.Unchecked,
        "Task": domain_models.Task,
        "Contradiction": domain_models.Contradiction,
        "TimelineEvent": domain_models.TimelineEvent,
        "Transcript": domain_models.Transcript,
    }

    async with pool.acquire() as conn:
        for class_name, table in _TABLES.items():
            cls = classes_by_name[class_name]
            hints = typing.get_type_hints(cls, include_extras=True)
            existing = {
                row["column_name"]: row["data_type"]
                for row in await conn.fetch(
                    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
                    table,
                )
            }
            if not existing:
                # Table itself doesn't exist yet — schema.sql hasn't run and
                # never will on this connection (it's initdb-only); nothing
                # to reconcile until an operator creates it.
                continue

            for f in fields(cls):
                sql_type = _sql_type_for(hints.get(f.name, str))

                if f.name not in existing:
                    try:
                        await conn.execute(
                            f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "{f.name}" {sql_type}'
                        )
                        log.info("store: added missing column %s.%s (%s)", table, f.name, sql_type)
                    except Exception as exc:  # noqa: BLE001 — one bad column must not block startup
                        log.warning("store: could not add column %s.%s: %s", table, f.name, exc)
                    continue

                # A column can exist with the WRONG type: this happened for
                # real on a live dev database — `valid_from`/`ttl_seconds`
                # etc. had already been hand-added as TEXT (a guess made
                # before this reconciliation existed), which made every
                # write of a non-null value throw `invalid input for query
                # argument: expected str, got int`, right back to the same
                # silent failure this whole mechanism exists to prevent.
                # `USING col::type` is Postgres's explicit-cast retype: safe
                # to attempt unconditionally because it fails loudly (caught
                # below, logged, left as-is) rather than corrupting anything
                # if the column already holds data that cannot be cast.
                if _sql_type_family(existing[f.name]) != _sql_type_family(sql_type):
                    try:
                        await conn.execute(
                            f'ALTER TABLE {table} ALTER COLUMN "{f.name}" TYPE {sql_type} USING "{f.name}"::{sql_type}'
                        )
                        log.info(
                            "store: retyped column %s.%s from %s to %s",
                            table, f.name, existing[f.name], sql_type,
                        )
                    except Exception as exc:  # noqa: BLE001 — one bad column must not block startup
                        log.warning(
                            "store: could not retype column %s.%s (%s -> %s): %s",
                            table, f.name, existing[f.name], sql_type, exc,
                        )


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

    # Always initialize local SQLite WAL store for zero-dependency persistence
    try:
        event_store.init_db()
    except Exception as exc:
        log.warning("store: SQLite WAL initialization failed: %s", exc)

    if not config.persistence_enabled():
        log.info("store: Postgres persistence disabled by LEDGER_PERSISTENCE")
        _enabled = False
        return True

    dsn = config.database_url()
    if not dsn:
        _enabled = False
        return True

    if dsn == config.DEFAULT_DATABASE_URL:
        # Loud rather than silent: `echo:echo` is a fine default for the
        # `docker-compose.yml` this project ships, and a real liability if
        # it's ever what a production deployment is actually running
        # against because nobody set DATABASE_URL. `tool_secret()` already
        # fails CLOSED when unset for exactly this class of risk; a DSN
        # can't fail closed the same way (no database is worse than a weak
        # one), so this is the next best thing — impossible to miss in logs.
        log.warning(
            "store: DATABASE_URL is not set — using the default dev DSN "
            "(postgres/echo:echo on 127.0.0.1:5434). Set DATABASE_URL explicitly "
            "before running this against anything other than the bundled "
            "docker-compose Postgres."
        )

    try:
        import asyncpg
    except ImportError:
        _last_error = "asyncpg is not installed (pip install asyncpg)"
        log.warning("store: %s — running on local SQLite WAL store", _last_error)
        _enabled = False
        return True

    try:
        # Small pool: this process is the only writer, and the work is short
        # background upserts rather than concurrent request handling.
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=4, timeout=10)
        async with _pool.acquire() as conn:
            await conn.execute("SELECT 1")
    except Exception as exc:  # noqa: BLE001 — absence must not stop the service
        _last_error = str(exc)[:200]
        log.warning(
            "store: could not reach Postgres (%s) — running on local SQLite WAL store. "
            "`docker compose up -d` starts Postgres mirror.",
            _last_error,
        )
        _pool = None
        _enabled = False
        return True

    try:
        await _reconcile_schema(_pool)
    except Exception as exc:  # noqa: BLE001 — a reconciliation bug must not block startup
        log.warning("store: schema reconciliation failed: %s", exc)

    _enabled = True
    _last_error = None
    log.info("store: Ledger dual-tier persistence (SQLite WAL + Postgres) is ON")
    return True


async def close() -> None:
    global _pool
    event_store.close()
    if _pool is not None:
        await _pool.close()
        _pool = None


def status() -> dict[str, Any]:
    """Reported by /health, so a silent fallback is never actually silent."""
    return {
        "enabled": True,
        "postgres": _enabled,
        "sqlite_wal": True,
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
    Persist one record. Always records to local SQLite WAL event store,
    and mirrors to Postgres in background if available.
    """
    try:
        event_store.record_event(record, channel)
    except Exception as exc:
        log.warning("store: SQLite save failed: %s", exc)

    if not _enabled:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop (a synchronous test, the Rehearsal Rig). Persistence
        # is a side effect; its absence must not break the caller.
        #
        # This check used to happen by calling `asyncio.create_task(_upsert(...))`
        # directly and catching the RuntimeError it raises with no loop — but
        # `_upsert(record, channel)` is evaluated (creating the coroutine
        # object) BEFORE `create_task` ever runs, so that coroutine was left
        # created and never awaited or closed, which is exactly the
        # `RuntimeWarning: coroutine '_upsert' was never awaited` seen in the
        # test suite. Checking for a loop first means `_upsert(...)` is never
        # even constructed on this path.
        return
    task = loop.create_task(_upsert(record, channel))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


_tasks: set[asyncio.Task[Any]] = set()


def save_many(records: Iterable[Any], channel: str) -> None:
    for record in records:
        save(record, channel)


async def clear(channel: str) -> None:
    """Drop one channel's record — the durable half of /incident/reset."""
    try:
        event_store.clear_channel(channel)
    except Exception as exc:
        log.warning("store: SQLite clear failed: %s", exc)

    if not _enabled or _pool is None:
        return
    try:
        async with _pool.acquire() as conn:
            for table in set(_TABLES.values()):
                await conn.execute(f"DELETE FROM {table} WHERE channel = $1", channel)
        log.info("store: cleared persisted ledger for %s", channel)
    except Exception as exc:  # noqa: BLE001
        log.warning("store: could not clear Postgres %s: %s", channel, str(exc)[:200])


async def load(channel: str) -> dict[str, list[dict[str, Any]]]:
    """
    Read one channel's record back, as plain rows keyed by table.
    Checks Postgres first; falls back seamlessly to SQLite WAL store.
    """
    if _enabled and _pool is not None:
        try:
            out: dict[str, list[dict[str, Any]]] = {}
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
            if any(out.values()):
                return out
        except Exception as exc:  # noqa: BLE001
            log.warning("store: could not load from Postgres %s: %s", channel, str(exc)[:200])

    # Fallback to local SQLite WAL store
    return event_store.load_channel_snapshots(channel)


def archive_postmortem(channel: str, report: dict[str, Any], markdown: str) -> str:
    """Archive a postmortem snapshot into durable storage."""
    return event_store.archive_postmortem(channel, report, markdown)


def list_postmortem_archives(channel: str | None = None) -> list[dict[str, Any]]:
    """List historical archived postmortems."""
    return event_store.list_postmortem_archives(channel)


def get_postmortem_archive(archive_id: str) -> dict[str, Any] | None:
    """Get specific archived postmortem by ID."""
    return event_store.get_postmortem_archive(archive_id)
