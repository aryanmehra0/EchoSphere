"""
Rehearsal Rig — Tier 3 (§15).

Tier 1 is the reducer against fixtures. Tier 2 scores the real extraction and
adjudication pipeline over fixed transcripts. Neither one touches HTTP, the
Ledger singleton, the Delta Hub, or the consent gate — so both stayed green
through a live run where the dashboard showed nothing.

Tier 3 drives the running SERVER the way the demo does: real endpoints, real
Ledger, real deltas, at conversational pace. It is the last thing between a
green build and standing up in front of a judge.

    .venv/Scripts/python -m rig.tier3            # one run
    .venv/Scripts/python -m rig.tier3 --runs 3   # the S6 gate

S6's exit criterion is THREE CONSECUTIVE CLEAN RUNS. Not an average, not a
best-of — consecutive, because the failure this catches is state leaking
between runs, and an average would hide exactly that.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from dataclasses import dataclass

import httpx

BASE = "http://127.0.0.1:8000"

G, R, Y, D, X = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


@dataclass
class Line:
    role: str
    uid: int
    text: str
    gap: float
    """Seconds to wait BEFORE speaking. Real pacing matters: the Turn Window
    flushes on silence, and firing four lines instantly tests a code path the
    demo will never take."""


SCRIPT = [
    Line("DevOps Lead", 1001,
         "Everyone on the bridge, massive spike in 500s on checkout. Latency is "
         "through the roof. Datadog looks like Redis might be evicting keys.", 0),
    Line("Support Engineer", 1002,
         "Tickets are flooding in. Users say their carts empty the second they "
         "hit purchase.", 9),
    Line("DevOps Lead", 1001,
         "Wait. I checked the primary Redis shard directly. Memory is at 40 "
         "percent. The cache is fine.", 11),
    Line("Support Engineer", 1002,
         "But application logs are definitely showing cache read timeouts on "
         "the checkout path.", 17),
]

# A distinctive sentence spoken while suspended. If it is findable afterwards,
# the consent gate is decorative.
SECRET = "Marcus is being performance managed out on Friday"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


async def one_run(client: httpx.AsyncClient, *, verbose: bool) -> list[Check]:
    await client.post(f"{BASE}/incident/reset")
    await asyncio.sleep(1.0)

    async def say(line_role: str, uid: int, text: str) -> dict:
        r = await client.post(f"{BASE}/observer/transcript",
                              json={"uid": uid, "role": line_role, "text": text})
        return r.json()

    for line in SCRIPT:
        if line.gap:
            await asyncio.sleep(line.gap)
        await say(line.role, line.uid, line.text)
        if verbose:
            print(f"{D}    {line.role:<17} {line.text[:52]}…{X}")

    # The pipeline flushes on silence; give it the window it expects.
    await asyncio.sleep(8)

    state = (await client.post(f"{BASE}/tools/query_incident_state", json={})).json()
    established = state.get("established", [])
    hypotheses = state.get("openHypotheses", [])
    unchecked = state.get("unchecked", [])
    entities = state.get("entities", [])

    def any_text(rows, *needles: str) -> bool:
        return any(all(n.lower() in row.get("text", "").lower() for n in [ns])
                   for row in rows for ns in needles)

    checks = [
        # ---- the epistemic split, which is the entire product --------------
        Check("hypothesis kept OUT of established",
              any_text(hypotheses, "evict") and not any_text(established, "evict"),
              "'might be evicting keys' must be an open question, never a fact"),

        Check("measurements recorded as established",
              any_text(established, "40 percent"),
              "a measured value must not be filed as a guess"),

        # ---- attribution, Rule 1 ------------------------------------------
        Check("every claim is attributed",
              all(c.get("speakerRole") for c in established + hypotheses),
              "a claim without a source is not sayable"),

        Check("both speakers present",
              {c.get("speakerRole") for c in established} >= {"DevOps Lead", "Support Engineer"},
              "per-UID attribution collapsed to one speaker"),

        # ---- entity resolution --------------------------------------------
        Check("entities converged (no drift)",
              0 < len(entities) <= 3,
              f"got {len(entities)}: {[e.get('id') for e in entities]}"),

        # ---- requirement 5, the quiet half --------------------------------
        Check("a gap was noticed", len(unchecked) > 0,
              "nothing was flagged as unestablished"),
    ]

    # ---- the consent gate, driven through the real endpoint ---------------
    await say("DevOps Lead", 1001, "Hang on, can we go off the record for a moment")
    await asyncio.sleep(1.5)
    dropped = await say("Support Engineer", 1002, SECRET)
    await asyncio.sleep(1.5)
    inv = (await client.get(f"{BASE}/privacy/inventory")).json()
    await say("DevOps Lead", 1001, "Right, we are back on the record")
    await asyncio.sleep(1.5)

    after = (await client.post(f"{BASE}/tools/query_incident_state", json={})).json()
    haystack = f"{after}{inv}"

    checks += [
        Check("off-the-record suspends ingestion",
              dropped.get("ignored") == "off the record",
              f"got {dropped}"),
        Check("suspended speech leaves NO trace",
              "Marcus" not in haystack and "performance managed" not in haystack,
              "the secret was retrievable after the fact"),
        Check("suspension is counted for audit",
              inv.get("suspended", {}).get("turnsDropped", 0) >= 1),
        Check("recording resumed",
              (await client.get(f"{BASE}/privacy/inventory")).json().get("recording") is True),
    ]

    return checks


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    async with httpx.AsyncClient(timeout=60) as client:
        try:
            await client.get(f"{BASE}/health")
        except Exception:
            print(f"{R}  Slow Loop is not running at {BASE}{X}")
            print(f"{D}  start it:  .venv/Scripts/python -m uvicorn app.main:app --port 8000{X}")
            return 2

        clean_streak = 0
        for run in range(1, args.runs + 1):
            print(f"\n{'═' * 72}\n  RUN {run}/{args.runs}\n{'═' * 72}")
            started = time.time()
            checks = await one_run(client, verbose=not args.quiet)

            for c in checks:
                mark = f"{G}✓{X}" if c.ok else f"{R}✗{X}"
                print(f"  {mark} {c.name}")
                if not c.ok and c.detail:
                    print(f"{D}      {c.detail}{X}")

            passed = sum(c.ok for c in checks)
            ok = passed == len(checks)
            clean_streak = clean_streak + 1 if ok else 0
            tone = G if ok else R
            print(f"\n  {tone}{passed}/{len(checks)}{X} in {time.time() - started:.0f}s"
                  f"   clean streak: {clean_streak}")

        print(f"\n{'═' * 72}")
        if clean_streak >= 3:
            print(f"  {G}S6 GATE MET — three consecutive clean runs{X}")
            return 0
        if args.runs >= 3:
            print(f"  {R}S6 GATE NOT MET — streak {clean_streak}, need 3 consecutive{X}")
            return 1
        print(f"  {Y}streak {clean_streak} — run with --runs 3 for the S6 gate{X}")
        return 0 if clean_streak else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
