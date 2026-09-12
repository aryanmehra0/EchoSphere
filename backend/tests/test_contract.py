"""
The frozen HTTP contract — what the unchanged frontend requires.

────────────────────────────────────────────────────────────────────────────
WHY THIS TEST EXISTS

The set of routes the console, the demo scripts, the Rehearsal Rig and
`validate.ps1` actually call is NOT self-evident from reading `main.py`. It was
recovered by grepping every caller in the repository, and three routes turned
out to have no caller at all.

That is a dangerous shape to refactor in. Splitting `main.py` into routers
means every route is re-registered somewhere new, and a handler that is
accidentally dropped fails at the moment a human is talking to Echo — not at
import, and not in any existing test.

So this pins the surface. If a refactor loses `/observer/transcript`, this
fails in seven seconds instead of on a live bridge.

It asserts the path SET, deliberately, not the response bodies: the shapes are
covered by the suites that own each feature. What no other test covers is
"does this route still exist at all".
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import unittest

# Module level, matching test_conversation.py — see the note there about
# `load_dotenv` and `mock.patch.dict`.
from app.main import app

# Every path with a caller outside this process, and who calls it.
#
# Keep the comments: when a future change wants to delete one of these, the
# caller named here is what has to be changed first.
REQUIRED_PATHS: dict[str, str] = {
    # -- the dashboard's live feed ------------------------------------------
    "/ws/deltas": "frontend lib/delta-socket.ts — HELLO/SNAPSHOT/REPLAY",
    # -- the ingest seam ----------------------------------------------------
    "/observer/transcript": "frontend lib/delta-socket.ts:464, rig tier2/tier3",
    # -- agent lifecycle, driven by Zone 2 ---------------------------------
    "/agent/start": "frontend lib/server/active-agents.ts:250",
    "/agent/stop": "frontend lib/server/active-agents.ts:282",
    "/agent/register": "frontend lib/server/active-agents.ts:159",
    "/agent/unregister": "frontend lib/server/active-agents.ts:191",
    # -- the Fast Loop's read channel, called by Agora's servers -----------
    "/tools/query_incident_state": "Agora Engine via agent-config.ts:735",
    "/tools/invoke": "Agora Engine via agent-config.ts:741..757 (4 tools)",
    # -- the Authorization Gate, redeemed from the dashboard ---------------
    "/approval/redeem": "frontend components/intel/ApprovalModal.tsx:81",
    "/approval/deny": "frontend components/intel/ApprovalModal.tsx:81",
    "/approval/verbal": "logged intent — asserts voice authorizes nothing",
    "/audit": "governance evidence, post-mortem source",
    # -- operations ---------------------------------------------------------
    "/health": "frontend api/health, demo.mjs, start.ps1, validate.ps1",
    "/health/model": "demo.mjs pre-flight — refuses GO on an exhausted quota",
    "/incident/reset": "demo.mjs reset, start.ps1 -Reset, rig tier3",
    # -- consent ------------------------------------------------------------
    "/privacy/inventory": "demo.mjs:244, rig/tier3.py:272",
    "/privacy/recording": "rig/tier3.py:289",
    # -- the Bridge ---------------------------------------------------------
    "/bridge/say": "validate.ps1:191 and test_conversation — auth-gate target",
    "/bridge/interrupt": "rehearsal / operator escape hatch",
    "/bridge/close-out": "W9 close-out, operator driven",
    "/bridge/roster": "frontend api/token/route.ts, server-side, at join time",
}

# Paths deleted because nothing in the repository called them. Listed so a
# re-introduction is a deliberate act with a caller attached, rather than a
# quiet re-appearance during a merge.
#
#   /rti/observe            no producer exists — needs per-UID PCM the
#                           installed stack cannot supply
#   /ledger/claim           claims enter through extraction; a second
#   /ledger/unchecked       unvalidated write path into the Ledger is a
#                           liability, not a feature
#   /bridge/contradiction   a second implementation of the headline
#                           behaviour, without the panel verdict
REMOVED_PATHS: frozenset[str] = frozenset({
    "/rti/observe",
    "/ledger/claim",
    "/ledger/unchecked",
    "/bridge/contradiction",
})


def served_paths() -> set[str]:
    """
    Every path this app actually serves, HTTP and WebSocket alike.

    ── WHY THIS WALKS `_IncludedRouter` ────────────────────────────────────
    Reading `app.routes` and taking `route.path` is the obvious implementation
    and it is WRONG on this FastAPI version. `include_router` appends a
    deferred `_IncludedRouter` placeholder that carries no `.path` and expands
    only when a request is matched — so the naive version reported four paths
    (the auto-generated /docs and /openapi.json) and would have passed this
    suite while every real route was missing.

    That is the exact failure this file exists to catch, so it must not be
    possible to fool it. Descend into anything holding its own `routes`.
    """
    found: set[str] = set()

    def walk(routes: object, prefix: str = "") -> None:
        for route in routes or ():  # type: ignore[union-attr]
            path = getattr(route, "path", None)
            if isinstance(path, str) and path.startswith("/"):
                found.add(prefix + path)
                continue

            # A deferred include: `original_router` holds the real APIRouter
            # and `include_context.prefix` the prefix it was mounted under.
            inner = getattr(route, "original_router", None)
            if inner is not None:
                context = getattr(route, "include_context", None)
                walk(
                    getattr(inner, "routes", None),
                    prefix + (getattr(context, "prefix", "") or ""),
                )
                continue

            # A mounted sub-application or a plain nested router.
            nested = getattr(route, "routes", None)
            if nested:
                walk(nested, prefix)

    walk(app.routes)
    return found


class TheFrozenContract(unittest.TestCase):

    def test_every_required_route_is_served(self) -> None:
        """
        The frontend is not being changed, so none of these may disappear.

        Reported with the caller's name, because "route missing" on its own
        sends the next person hunting for who needed it.
        """
        missing = {
            path: caller
            for path, caller in REQUIRED_PATHS.items()
            if path not in served_paths()
        }
        self.assertEqual(
            missing, {},
            "These routes have external callers and are no longer served. "
            "Restore them, or change the caller first.",
        )

    def test_deleted_routes_have_not_returned(self) -> None:
        """
        Each of these was removed for a reason recorded above. A route coming
        back silently — through a merge, or a copied handler — should be a test
        failure rather than a discovery.
        """
        returned = REMOVED_PATHS & served_paths()
        self.assertEqual(
            returned, set(),
            "Deleted routes are being served again. If one is genuinely "
            "needed, move it to REQUIRED_PATHS with its caller named.",
        )

    def test_the_root_health_check_answers(self) -> None:
        """
        `/health` is the one path the tunnel serves unauthenticated, and
        `start.ps1` blocks on it. It must answer even with no credentials —
        503 is a valid answer here, a crash is not.
        """
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            response = client.get("/health")

        self.assertIn(response.status_code, (200, 503))
        body = response.json()
        # The keys start.ps1 and demo.mjs read.
        for key in ("ready", "credentials", "persistence", "degraded", "agent"):
            self.assertIn(key, body)


if __name__ == "__main__":
    unittest.main()
