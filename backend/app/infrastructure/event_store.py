"""
Append-Only Event Store and SQLite WAL Persistence — Phase 1 Architecture.

────────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS

The original store was write-behind to Postgres only. If Postgres was not
running (a common state in local dev or minimal container deployments), the
Ledger lived only in memory and restarting the process erased the entire
incident record.

Furthermore, direct upserts overwrite intermediate states. If an entity cycles
OK -> CRITICAL -> OK, an upsert discards the transition history.

This module provides:
1. Embedded, zero-dependency persistence via SQLite in WAL mode
   (Write-Ahead Logging), guaranteed to work on any Python installation.
2. An append-only event stream (incident_events) storing every discrete mutation
   for deterministic time-travel replay and SOC2/audit compliance.
3. Materialized current-state snapshots (incident_snapshots) for O(1) rehydration.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, Iterable

log = logging.getLogger("echo.event_store")

# Default database path inside backend/data
_DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data"
_DEFAULT_DB = _DEFAULT_DIR / "incident_events.db"

_db_path: Path = _DEFAULT_DB
_conn: sqlite3.Connection | None = None
_initialized = False

# Mapping from dataclass name to plural collection name
_TYPE_MAP: dict[str, str] = {
    "Claim": "claims",
    "Entity": "entities",
    "Link": "links",
    "Unchecked": "unchecked",
    "Task": "tasks",
    "Contradiction": "contradictions",
    "TimelineEvent": "timeline",
    "Transcript": "transcripts",
}

# The primary key field for each model
_KEY_FIELDS: dict[str, str] = {
    "transcripts": "message_id",
}


def _record_id(record: Any, record_type: str) -> str:
    key_field = _KEY_FIELDS.get(record_type, "id")
    val = getattr(record, key_field, None)
    return str(val or "")


def get_db_path() -> Path:
    env_path = os.getenv("SQLITE_DB_PATH", "").strip()
    return Path(env_path) if env_path else _DEFAULT_DB


def _init_schema(conn: sqlite3.Connection) -> None:
    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS incident_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                event_type TEXT NOT NULL,
                record_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_channel_seq
            ON incident_events(channel, seq);
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_events_channel_type
            ON incident_events(channel, event_type, record_id);
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS incident_snapshots (
                channel TEXT NOT NULL,
                record_type TEXT NOT NULL,
                record_id TEXT NOT NULL,
                payload TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (channel, record_type, record_id)
            );
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_snapshots_channel_type
            ON incident_snapshots(channel, record_type);
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS postmortem_archives (
                archive_id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                json_report TEXT NOT NULL,
                markdown_content TEXT NOT NULL
            );
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_archives_channel
            ON postmortem_archives(channel, created_at DESC);
        """)


def get_connection() -> sqlite3.Connection:
    global _conn, _db_path, _initialized
    target = get_db_path()
    if _conn is None or _db_path != target:
        target.parent.mkdir(parents=True, exist_ok=True)
        _db_path = target
        _conn = sqlite3.connect(str(_db_path), check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode = WAL;")
        _conn.execute("PRAGMA synchronous = NORMAL;")
        _conn.execute("PRAGMA busy_timeout = 5000;")
        _init_schema(_conn)
        _initialized = True
    elif not _initialized:
        _init_schema(_conn)
        _initialized = True
    return _conn


def init_db(db_path: Path | str | None = None) -> None:
    """Initialize SQLite tables with WAL mode."""
    global _conn, _db_path, _initialized
    if db_path:
        p = Path(db_path)
        if _conn is not None and _db_path != p:
            _conn.close()
            _conn = None
        _db_path = p
        os.environ["SQLITE_DB_PATH"] = str(p)

    conn = get_connection()
    _init_schema(conn)
    _initialized = True
    log.info("event_store: SQLite WAL initialized at %s", _db_path)


def _to_json_compatible(record: Any) -> dict[str, Any]:
    if is_dataclass(record):
        return asdict(record)
    if isinstance(record, dict):
        return record
    return dict(record)


def record_event(record: Any, channel: str) -> int | None:
    """
    Append an immutable event and update the materialized snapshot table.
    Returns the sequence number of the recorded event.
    """
    if not is_dataclass(record) and not isinstance(record, dict):
        return None

    class_name = type(record).__name__ if is_dataclass(record) else record.get("event_type", "Unknown")
    table_name = _TYPE_MAP.get(class_name, class_name.lower())
    rec_id = _record_id(record, table_name)
    if not rec_id:
        return None

    data = _to_json_compatible(record)
    payload_str = json.dumps(data)
    now_ms = int(time.time() * 1000)

    try:
        conn = get_connection()
        with conn:
            cur = conn.execute(
                """
                INSERT INTO incident_events (channel, event_type, record_id, payload, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (channel, table_name, rec_id, payload_str, now_ms),
            )
            seq = cur.lastrowid

            conn.execute(
                """
                INSERT INTO incident_snapshots (channel, record_type, record_id, payload, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(channel, record_type, record_id) DO UPDATE SET
                    payload = EXCLUDED.payload,
                    updated_at = EXCLUDED.updated_at
                """,
                (channel, table_name, rec_id, payload_str, now_ms),
            )
        return seq
    except Exception as exc:
        log.warning("event_store: failed to record event for %s/%s: %s", channel, table_name, exc)
        return None


def record_many(records: Iterable[Any], channel: str) -> None:
    for r in records:
        record_event(r, channel)


def load_channel_snapshots(channel: str) -> dict[str, list[dict[str, Any]]]:
    """
    Read materialized snapshots for one channel, returning a dictionary
    keyed by plural collection name (claims, entities, links, etc.).
    """
    out: dict[str, list[dict[str, Any]]] = {}
    try:
        conn = get_connection()
        cur = conn.execute(
            """
            SELECT record_type, payload
            FROM incident_snapshots
            WHERE channel = ?
            ORDER BY updated_at ASC
            """,
            (channel,),
        )
        for row in cur.fetchall():
            rec_type = row["record_type"]
            try:
                item = json.loads(row["payload"])
                out.setdefault(rec_type, []).append(item)
            except Exception:
                continue
    except Exception as exc:
        log.warning("event_store: could not load snapshots for %s: %s", channel, exc)
    return out


def replay_events(
    channel: str, since_seq: int = 0, to_seq: int | None = None
) -> list[dict[str, Any]]:
    """
    Fetch raw immutable events in sequence order for time-travel and replay.
    """
    events: list[dict[str, Any]] = []
    try:
        conn = get_connection()
        sql = "SELECT seq, event_type, record_id, payload, created_at FROM incident_events WHERE channel = ? AND seq > ?"
        params: list[Any] = [channel, since_seq]
        if to_seq is not None:
            sql += " AND seq <= ?"
            params.append(to_seq)
        sql += " ORDER BY seq ASC"

        cur = conn.execute(sql, params)
        for row in cur.fetchall():
            try:
                payload = json.loads(row["payload"])
            except Exception:
                payload = {}
            events.append({
                "seq": row["seq"],
                "event_type": row["event_type"],
                "record_id": row["record_id"],
                "payload": payload,
                "created_at": row["created_at"],
            })
    except Exception as exc:
        log.warning("event_store: could not replay events for %s: %s", channel, exc)
    return events


def clear_channel(channel: str) -> None:
    """Purge events and snapshots for a specific channel upon reset."""
    try:
        conn = get_connection()
        with conn:
            conn.execute("DELETE FROM incident_events WHERE channel = ?", (channel,))
            conn.execute("DELETE FROM incident_snapshots WHERE channel = ?", (channel,))
        log.info("event_store: cleared SQLite events and snapshots for %s", channel)
    except Exception as exc:
        log.warning("event_store: could not clear SQLite store for %s: %s", channel, exc)


def archive_postmortem(channel: str, report: dict[str, Any], markdown: str) -> str:
    """Persist completed incident postmortem into durable SQLite archive."""
    archive_id = f"pm-{int(time.time() * 1000)}-{channel}"
    try:
        conn = get_connection()
        with conn:
            conn.execute(
                """
                INSERT INTO postmortem_archives (archive_id, channel, created_at, json_report, markdown_content)
                VALUES (?, ?, ?, ?, ?)
                """,
                (archive_id, channel, int(time.time() * 1000), json.dumps(report), markdown),
            )
        log.info("event_store: archived postmortem %s for channel %s", archive_id, channel)
        return archive_id
    except Exception as exc:
        log.warning("event_store: could not archive postmortem for %s: %s", channel, exc)
        return archive_id


def list_postmortem_archives(channel: str | None = None) -> list[dict[str, Any]]:
    """List historical postmortem summaries."""
    out: list[dict[str, Any]] = []
    try:
        conn = get_connection()
        if channel:
            cur = conn.execute(
                "SELECT archive_id, channel, created_at, json_report FROM postmortem_archives WHERE channel = ? ORDER BY created_at DESC",
                (channel,),
            )
        else:
            cur = conn.execute(
                "SELECT archive_id, channel, created_at, json_report FROM postmortem_archives ORDER BY created_at DESC",
            )
        for row in cur.fetchall():
            try:
                rep = json.loads(row["json_report"])
                summary = rep.get("summary", {})
            except Exception:
                summary = {}
            out.append({
                "archiveId": row["archive_id"],
                "channel": row["channel"],
                "createdAt": row["created_at"],
                "title": summary.get("title", f"Incident Postmortem - {row['channel']}"),
                "severity": summary.get("severity", "SEV-1"),
                "status": summary.get("status", "RESOLVED"),
            })
    except Exception as exc:
        log.warning("event_store: could not list postmortem archives: %s", exc)
    return out


def get_postmortem_archive(archive_id: str) -> dict[str, Any] | None:
    """Retrieve full postmortem archive by id."""
    try:
        conn = get_connection()
        cur = conn.execute(
            "SELECT archive_id, channel, created_at, json_report, markdown_content FROM postmortem_archives WHERE archive_id = ?",
            (archive_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return {
            "archiveId": row["archive_id"],
            "channel": row["channel"],
            "createdAt": row["created_at"],
            "report": json.loads(row["json_report"]),
            "markdown": row["markdown_content"],
        }
    except Exception as exc:
        log.warning("event_store: could not fetch archive %s: %s", archive_id, exc)
        return None


def close() -> None:
    global _conn
    if _conn is not None:
        try:
            _conn.close()
        except Exception:
            pass
        _conn = None
