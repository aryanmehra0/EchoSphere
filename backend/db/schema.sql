-- EchoSphere — the Evidence Ledger, made durable.
--
-- ── WHAT IS PERSISTED AND WHAT IS NOT ───────────────────────────────────────
-- This holds the incident RECORD: what was claimed, by whom, with what
-- epistemic status. That is the thing the product's whole argument rests on,
-- and losing it to a backend restart mid-incident is the one data loss that
-- actually matters.
--
-- NOT here, on purpose:
--   * the roster and the active-agent map — session identity with a one-hour
--     TTL. `roster.ts` argues a restarted server has no business claiming to
--     know who is on a channel it lost track of, and persisting it would make
--     exactly that claim.
--   * the delta ring buffer — a replay window, meaningless once its consumers
--     have reconnected and resynced.
--
-- ── WHY `at` IS BIGINT AND NOT TIMESTAMPTZ ──────────────────────────────────
-- Every model already carries `at` as epoch milliseconds (`now_ms()`), and the
-- wire format the dashboard consumes is the same number. Converting on the way
-- in and back out would add two places for a timezone bug to live, in a
-- product where the ordering of claims is load-bearing.

-- Channels are first-class: a row's identity is (channel, id), so a second
-- incident cannot collide with the first. The backend is still single-channel
-- today, but writing the schema single-channel would guarantee a migration.
CREATE TABLE IF NOT EXISTS claims (
    channel          TEXT    NOT NULL,
    id               TEXT    NOT NULL,
    text             TEXT    NOT NULL,
    -- OBSERVED | REPORTED | INFERRED. Not an enum type: the vocabulary lives
    -- in models.py, and a CHECK constraint here would be a second source of
    -- truth that silently rejects writes after the Python side gains a value.
    epistemic_status TEXT    NOT NULL,
    speaker_role     TEXT    NOT NULL,
    confidence       DOUBLE PRECISION NOT NULL,
    at               BIGINT  NOT NULL,
    entity           TEXT,
    supersedes       TEXT,
    -- JSONB, not TEXT: `Claim.contradicts` is a list[str]. Declaring it TEXT
    -- made asyncpg reject every claim carrying a contradiction with
    -- "expected str, got list" — silently, since writes are write-behind, so
    -- the durable Ledger would have been missing exactly the rows this
    -- product exists to record.
    contradicts      JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (channel, id)
);

-- The Ledger reads claims by entity and in time order on every query, and the
-- recap injected into a replacement agent's prompt is an ORDER BY at DESC.
CREATE INDEX IF NOT EXISTS claims_channel_at   ON claims (channel, at);
CREATE INDEX IF NOT EXISTS claims_channel_ent  ON claims (channel, entity);

CREATE TABLE IF NOT EXISTS entities (
    channel  TEXT NOT NULL,
    id       TEXT NOT NULL,
    label    TEXT NOT NULL,
    kind     TEXT NOT NULL,
    status   TEXT,
    detail   TEXT,
    metric   TEXT,
    -- {x, y} for the graph, and a list of alias strings. Shapes the dashboard
    -- owns; the database has no reason to know their internals.
    position JSONB,
    aliases  JSONB NOT NULL DEFAULT '[]'::jsonb,
    PRIMARY KEY (channel, id)
);

CREATE TABLE IF NOT EXISTS links (
    channel TEXT NOT NULL,
    id      TEXT NOT NULL,
    source  TEXT NOT NULL,
    target  TEXT NOT NULL,
    label   TEXT,
    kind    TEXT,
    PRIMARY KEY (channel, id)
);

CREATE TABLE IF NOT EXISTS unchecked (
    channel         TEXT   NOT NULL,
    id              TEXT   NOT NULL,
    description     TEXT   NOT NULL,
    at              BIGINT NOT NULL,
    suggested_owner TEXT,
    PRIMARY KEY (channel, id)
);

CREATE TABLE IF NOT EXISTS tasks (
    channel       TEXT   NOT NULL,
    id            TEXT   NOT NULL,
    assignee_role TEXT   NOT NULL,
    description   TEXT   NOT NULL,
    status        TEXT   NOT NULL,
    at            BIGINT NOT NULL,
    -- Claim ids justifying the task. Kept as JSONB rather than a join table:
    -- it is read as an opaque list and never queried across.
    evidence      JSONB  NOT NULL DEFAULT '[]'::jsonb,
    ref           TEXT,
    PRIMARY KEY (channel, id)
);

CREATE TABLE IF NOT EXISTS contradictions (
    channel  TEXT   NOT NULL,
    id       TEXT   NOT NULL,
    claim_a  TEXT   NOT NULL,
    claim_b  TEXT   NOT NULL,
    speakers JSONB  NOT NULL DEFAULT '[]'::jsonb,
    at       BIGINT NOT NULL,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    relation TEXT,
    why      TEXT,
    -- The adjudication panel's votes. Structured, but only ever read whole.
    panel    JSONB,
    PRIMARY KEY (channel, id)
);

CREATE TABLE IF NOT EXISTS timeline (
    channel TEXT   NOT NULL,
    id      TEXT   NOT NULL,
    kind    TEXT   NOT NULL,
    text    TEXT   NOT NULL,
    actor   TEXT,
    at      BIGINT NOT NULL,
    PRIMARY KEY (channel, id)
);

CREATE INDEX IF NOT EXISTS timeline_channel_at ON timeline (channel, at);

-- Transcripts are the raw record beneath the claims. Persisted because "what
-- exactly was said" is the question every disputed claim ends at, and the
-- extraction that produced the claim is not reversible.
CREATE TABLE IF NOT EXISTS transcripts (
    channel    TEXT    NOT NULL,
    message_id TEXT    NOT NULL,
    uid        INTEGER NOT NULL,
    role       TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    is_final   BOOLEAN NOT NULL DEFAULT TRUE,
    at         BIGINT  NOT NULL,
    PRIMARY KEY (channel, message_id)
);

CREATE INDEX IF NOT EXISTS transcripts_channel_at ON transcripts (channel, at);
