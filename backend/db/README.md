# The durable Evidence Ledger

## Start it

```bash
docker compose up -d          # from the repo root
```

Services started:
- **PostgreSQL 16**: port **5434** (not 5432 or 5433 — avoids colliding with local developer Postgres instances)
- **Redis 7 Alpine**: port **6379** (Streams backbone for `echosphere:deltas` and distributed state)
- **Qdrant Vector DB v1.11.3**: port **6333** (REST) and **6334** (gRPC) for semantic claim embeddings and similarity retrieval

`schema.sql` is applied automatically the first time the Postgres volume is created.

```bash
docker compose down           # stop; data survives
docker compose down -v        # stop and DELETE the data
```

## What is persisted

The incident **record**: claims, entities, links, unchecked items, tasks,
contradictions, the timeline, and the raw transcripts beneath them.


Deliberately **not** persisted:

- **the roster and the active-agent map** — session identity with a one-hour
  TTL. `roster.ts` argues that a restarted server has no business claiming to
  know who is on a channel it lost track of, and persisting it would make
  exactly that claim.
- **the delta ring buffer** — a replay window, meaningless once its consumers
  have reconnected and resynced.

## It is optional, on purpose

`store.connect()` never raises. With no database reachable the Slow Loop runs
on the in-memory Ledger it always used, and says so:

```json
GET /health  →  { "persistence": { "enabled": false, "error": "..." } }
```

That is reported rather than assumed — a silent fallback to a volatile Ledger
is precisely the kind of quiet degradation this project keeps having to hunt
down after the fact.

Turn it off explicitly with `LEDGER_PERSISTENCE=off`, or point somewhere else
with `DATABASE_URL`.

## Writes are behind, not through

The in-memory Ledger stays the source of truth for reads; writes are mirrored
in the background and failures are logged, never raised.

`/observer/transcript` is on the voice hot path and `query_incident_state` is
called synchronously by Agora while a human waits for Echo to answer. A
database round trip — or an outage — in front of either would trade a durable
record for a bridge that stops working.

The honest consequence: if Postgres is down, the last few writes are lost on
restart.

## Inspecting it

```bash
docker exec -it echosphere-postgres psql -U echo -d echosphere

\dt                                    -- tables
SELECT speaker_role, text FROM claims WHERE channel = 'inc-4417' ORDER BY at;
SELECT role, text FROM transcripts WHERE channel = 'inc-4417' ORDER BY at;
```

## Adding a field to a model

1. Add the column to `schema.sql`.
2. That is all.

The INSERT column list is derived from `dataclasses.fields()`, so there is no
second place to forget it. `backend/app/infrastructure/store.py` explains why
that matters: hand-written field lists fail *silently* — the column simply
never gets written.

There is still no migration TOOL, but an already-initialized volume is no
longer stuck on the old schema: `store.connect()` runs `_reconcile_schema()`
on every startup, which diffs each table's real columns against its
dataclass's fields (via `information_schema.columns`) and runs
`ALTER TABLE ... ADD COLUMN` for anything missing, inferring the SQL type
from the field's annotation. It will also RETYPE a column whose existing type
is in the wrong family for what the field now expects (this happened for
real: `valid_from`/`ttl_seconds` had been hand-added as `TEXT` before this
reconciliation existed, so every write of a non-null value threw
`UndefinedColumnError`'s cousin, `invalid input ... expected str, got int`,
right back to the same silent failure). A retype is attempted via
`ALTER COLUMN ... TYPE x USING col::x`, which fails loudly (logged, column
left as-is) rather than corrupting anything if existing data can't be cast —
so on a volume where that column already holds incompatible values, you're
back to applying an `ALTER TABLE` by hand, exactly as before this existed.

`docker compose down -v` (destroys all data) remains the alternative for
anyone who would rather start from a clean, fully fresh `schema.sql`.
