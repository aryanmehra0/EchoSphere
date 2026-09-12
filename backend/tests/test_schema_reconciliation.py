"""
Tests for `store._reconcile_schema` — the self-healing fix for the schema
drift found between `backend/db/schema.sql` and the dataclasses in
`app/domain/models.py` (Claim/TimelineEvent/Transcript all gained fields
`schema.sql` never got). Verified live against a real Postgres during
development (a fresh column got added with the right type, and a
hand-added-as-TEXT column that had been silently failing every write got
correctly retyped) — these tests pin that behavior with a fake pool so it
runs without a live database.
"""

from __future__ import annotations

import unittest

from app.infrastructure.store import _reconcile_schema, _sql_type_family, _sql_type_for


class FakeConnection:
    """
    Just enough of asyncpg's connection interface for `_reconcile_schema`:
    `fetch` answers `information_schema.columns`-shaped rows from an
    in-memory table map, and `execute` records DDL instead of running it.
    """

    def __init__(self, tables: dict[str, dict[str, str]]) -> None:
        # table -> {column_name: data_type}
        self.tables = tables
        self.executed: list[str] = []

    async def fetch(self, query: str, table: str) -> list[dict[str, str]]:
        columns = self.tables.get(table, {})
        return [{"column_name": name, "data_type": dtype} for name, dtype in columns.items()]

    async def execute(self, statement: str) -> None:
        self.executed.append(statement)


class FakeAcquire:
    def __init__(self, conn: FakeConnection) -> None:
        self.conn = conn

    async def __aenter__(self) -> FakeConnection:
        return self.conn

    async def __aexit__(self, *exc: object) -> None:
        return None


class FakePool:
    def __init__(self, tables: dict[str, dict[str, str]]) -> None:
        self.conn = FakeConnection(tables)

    def acquire(self) -> FakeAcquire:
        return FakeAcquire(self.conn)


class TestSqlTypeInference(unittest.TestCase):
    def test_optional_int_is_bigint(self) -> None:
        self.assertEqual(_sql_type_for(int | None), "BIGINT")

    def test_plain_str_is_text(self) -> None:
        self.assertEqual(_sql_type_for(str), "TEXT")

    def test_list_of_str_is_jsonb(self) -> None:
        self.assertEqual(_sql_type_for(list[str]), "JSONB")

    def test_optional_dict_is_jsonb(self) -> None:
        self.assertEqual(_sql_type_for(dict[str, object] | None), "JSONB")

    def test_bool_is_boolean(self) -> None:
        self.assertEqual(_sql_type_for(bool), "BOOLEAN")

    def test_float_is_double_precision(self) -> None:
        self.assertEqual(_sql_type_for(float), "DOUBLE PRECISION")


class TestSqlTypeFamily(unittest.TestCase):
    def test_integer_and_bigint_are_the_same_family(self) -> None:
        """
        The bug found live: retyping `transcripts.uid` from `integer` to
        `bigint` on every startup was pure churn — both are perfectly good
        homes for a Python int, and a real column already using either
        should never be touched.
        """
        self.assertEqual(_sql_type_family("integer"), _sql_type_family("bigint"))
        self.assertEqual(_sql_type_family("integer"), _sql_type_family("smallint"))

    def test_text_and_integer_are_different_families(self) -> None:
        self.assertNotEqual(_sql_type_family("text"), _sql_type_family("bigint"))

    def test_json_and_jsonb_are_the_same_family(self) -> None:
        self.assertEqual(_sql_type_family("json"), _sql_type_family("jsonb"))


class TestReconcileSchema(unittest.IsolatedAsyncioTestCase):
    async def test_adds_a_genuinely_missing_column_with_the_right_type(self) -> None:
        """The fresh-schema.sql-drift case: a column the dataclass declares
        that the table has never had at all."""
        pool = FakePool({
            "claims": {
                "channel": "text", "id": "text", "text": "text",
                "epistemic_status": "text", "speaker_role": "text",
                "confidence": "double precision", "at": "bigint",
                "entity": "text", "supersedes": "text", "contradicts": "jsonb",
                # valid_from/valid_until/ttl_seconds/lifecycle/speaker_name/
                # speaker_user_id deliberately absent, as on a real
                # pre-fix volume.
            },
            "entities": {"channel": "text", "id": "text", "label": "text", "kind": "text", "status": "text",
                         "detail": "text", "metric": "text", "position": "jsonb", "aliases": "jsonb"},
            "links": {"channel": "text", "id": "text", "source": "text", "target": "text", "label": "text", "kind": "text"},
            "unchecked": {"channel": "text", "id": "text", "description": "text", "at": "bigint", "suggested_owner": "text"},
            "tasks": {"channel": "text", "id": "text", "assignee_role": "text", "description": "text", "status": "text",
                      "at": "bigint", "evidence": "jsonb", "ref": "text"},
            "contradictions": {"channel": "text", "id": "text", "claim_a": "text", "claim_b": "text", "speakers": "jsonb",
                                "at": "bigint", "resolved": "boolean", "relation": "text", "why": "text", "panel": "jsonb"},
            "timeline": {"channel": "text", "id": "text", "kind": "text", "text": "text", "actor": "text", "at": "bigint"},
            "transcripts": {"channel": "text", "message_id": "text", "uid": "integer", "role": "text", "text": "text",
                            "is_final": "boolean", "at": "bigint"},
        })

        await _reconcile_schema(pool)

        added = pool.conn.executed
        for expected_col, expected_type in [
            ("valid_from", "BIGINT"), ("valid_until", "BIGINT"), ("ttl_seconds", "BIGINT"),
            ("lifecycle", "TEXT"), ("speaker_name", "TEXT"), ("speaker_user_id", "TEXT"),
        ]:
            self.assertTrue(
                any(f'"{expected_col}" {expected_type}' in stmt and "ADD COLUMN" in stmt for stmt in added),
                f"expected an ADD COLUMN for claims.{expected_col} ({expected_type}); executed: {added}",
            )
        # timeline/transcripts are missing their own new fields the same way.
        self.assertTrue(any('"actor_name"' in s and "ADD COLUMN" in s for s in added))
        self.assertTrue(any('"actor_user_id"' in s and "ADD COLUMN" in s for s in added))
        self.assertTrue(any('"speaker_name"' in s and "ADD COLUMN" in s for s in added))

    async def test_retypes_a_column_in_the_wrong_type_family(self) -> None:
        """The live bug: `valid_from` had been hand-added as TEXT before this
        reconciliation existed, so every write of a non-null value failed."""
        pool = FakePool({
            "claims": {
                "channel": "text", "id": "text", "text": "text",
                "epistemic_status": "text", "speaker_role": "text",
                "confidence": "double precision", "at": "bigint",
                "entity": "text", "supersedes": "text", "contradicts": "jsonb",
                "valid_from": "text", "valid_until": "text", "ttl_seconds": "text",
                "lifecycle": "text", "speaker_name": "text", "speaker_user_id": "text",
            },
            "entities": {}, "links": {}, "unchecked": {}, "tasks": {}, "contradictions": {},
            "timeline": {}, "transcripts": {},
        })

        await _reconcile_schema(pool)

        retypes = [s for s in pool.conn.executed if "ALTER COLUMN" in s]
        for col in ("valid_from", "valid_until", "ttl_seconds"):
            self.assertTrue(
                any(f'"{col}" TYPE BIGINT' in s for s in retypes),
                f"expected a retype of claims.{col} to BIGINT; executed: {retypes}",
            )
        # lifecycle/speaker_name/speaker_user_id are already TEXT, matching
        # what they should be — must NOT be retyped.
        self.assertFalse(any('"lifecycle"' in s for s in retypes))

    async def test_does_not_retype_a_column_already_in_the_right_family(self) -> None:
        """The over-eager-churn bug found live: `transcripts.uid` was
        `integer`, which is perfectly fine for a Python int, and got
        needlessly retyped to `bigint` before this family-aware check
        existed. A column already in the right family must be left alone."""
        pool = FakePool({
            "claims": {}, "entities": {}, "links": {}, "unchecked": {}, "tasks": {}, "contradictions": {},
            "timeline": {},
            "transcripts": {
                "channel": "text", "message_id": "text", "uid": "integer", "role": "text",
                "text": "text", "is_final": "boolean", "at": "bigint",
                "speaker_name": "text", "speaker_user_id": "text",
            },
        })

        await _reconcile_schema(pool)

        retypes = [s for s in pool.conn.executed if "ALTER COLUMN" in s and "transcripts" in s]
        self.assertEqual(retypes, [])

    async def test_a_table_that_does_not_exist_yet_is_skipped_without_error(self) -> None:
        pool = FakePool({})  # no tables at all
        await _reconcile_schema(pool)  # must not raise
        self.assertEqual(pool.conn.executed, [])


if __name__ == "__main__":
    unittest.main()
