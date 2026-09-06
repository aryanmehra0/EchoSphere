# The durable Evidence Ledger

## Start it

```bash
docker compose up -d          # from the repo root
```

Postgres comes up on **5433** (not 5432 — a developer machine very often
already runs one on the default port, and connecting to the wrong server
produces a confusing "database exists but the tables are missing").

`schema.sql` is applied automatically the first time the volume is created.

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
second place to forget it. `backend/app/store.py` explains why that matters:
hand-written field lists fail *silently* — the column simply never gets
written.

Note this repo has no migration tool yet. An existing volume will not pick up
a new column; either `docker compose down -v` (destroys data) or apply the
`ALTER TABLE` by hand.
