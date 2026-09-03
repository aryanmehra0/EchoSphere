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
import re
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


# Placeholder id stems the model falls back on when it has not named a thing.
# `entity-1` and `entity-2` share a stem and are almost certainly DIFFERENT
# things, so a stem check on ids alone reports drift that is not there — which
# it did, on its first run.
_GENERIC_STEMS = {"entity", "e", "item", "thing", "system", "unknown", "node"}


def _no_split_entities(entities: list[dict]) -> bool:
    """
    True when no two entities are the same real-world thing under two ids.

    Drift is the failure that hurts: contradiction scoping is by entity
    equality (§7 Stage 0), so "redis" and "redis-primary" as separate ids means
    the headline conflict is never even considered — silently, with a healthy
    dashboard and nothing in the logs.

    Compared on LABEL, not id. The label is what the room actually calls the
    thing, and it is what makes `redis` / `redis-primary` recognisable as one
    system while `checkout-service` / `carts-client` stay two. Ids are a weaker
    signal because the model sometimes emits placeholders, and an earlier
    version of this check failed a perfectly good run over `entity-1` and
    `entity-2` sharing a stem.
    """
    seen: list[str] = []
    for entity in entities:
        label = re.sub(r"[^a-z0-9 ]+", " ", str(entity.get("label") or "").lower())
        label = " ".join(label.split())

        if not label:
            # No label to compare — fall back to the id, unless it is one of
            # the model's generic placeholders.
            eid = str(entity.get("id") or "").lower()
            stem = re.split(r"[-_ ]", eid)[0] if eid else ""
            if not stem or stem in _GENERIC_STEMS:
                continue
            label = stem

        for other in seen:
            # Containment, not equality: "redis" is inside "redis primary",
            # which is exactly the shape drift takes.
            if label == other or label in other or other in label:
                return False
        seen.append(label)
    return True


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

    """
    WAIT FOR QUIESCENCE, NOT A FIXED DELAY.

    This used to sleep 8 seconds. The pipeline now runs in background tasks
    (so `/observer/transcript` stops blocking the browser) and honours Groq's
    rate-limit backoff, so the last window's claims can land well after that.
    A run that "lost" Act 2 had simply not finished it yet — the gate sampled
    early and reported a correctness regression that was a stopwatch problem.

    Polls until the claim count stops moving for two consecutive seconds, or
    45s passes. Quiescence is the real signal: the pipeline is done when it
    stops producing, and how long that takes is not what S6 is measuring.
    """
    async def snapshot() -> dict:
        return (await client.post(f"{BASE}/tools/query_incident_state", json={})).json()

    async def busy() -> bool:
        """
        Is the pipeline still working? Asked, not inferred.

        An earlier version watched the claim count and stopped when it held
        steady for two seconds. Under rate-limit backoff the count sits still
        mid-window for exactly that long, so the gate declared the run finished
        while Act 2 was still being extracted — and then reported the missing
        measurement as a correctness regression. It was a stopwatch problem
        twice over.
        """
        try:
            h = (await client.get(f"{BASE}/health")).json()
            p = h.get("pipeline") or {}
            return bool(p.get("inFlight")) or bool(p.get("windowFrames"))
        except Exception:  # noqa: BLE001 — a probe failure must not end the wait
            return True

    quiet = 0
    for _ in range(60):
        await asyncio.sleep(1.0)
        quiet = 0 if await busy() else quiet + 1
        # Three idle seconds: a task can finish and the next flush start within
        # one, and stopping between them would sample a half-done ledger.
        if quiet >= 3:
            break

    state = await snapshot()

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

        # THE MEASUREMENT, NOT ITS PHRASING.
        #
        # This asserted the literal string "40 percent" and failed
        # intermittently on runs where extraction wrote "40%" or
        # "memory utilization at 40 percent" — the measurement was recorded
        # correctly and the check called it a regression. Two separate
        # explanations were offered for that flakiness before the check itself
        # turned out to be the flaky part.
        #
        # What matters is that a MEASURED value landed in ESTABLISHED rather
        # than being filed as a guess. The number and a unit is the test; the
        # model's wording is not ours to fix.
        Check("measurements recorded as established",
              any(
                  re.search(r"\b40\s*(percent|%)", c.get("text", ""), re.I)
                  for c in established
              ),
              "established rows were: "
              + " | ".join(c.get("text", "")[:48] for c in established[:6])),

        # The failure this catches shipped to a live dashboard: "Datadog
        # indicates Redis might be evicting keys" filed as OBSERVED at 100%,
        # beside the same guess filed as an open question. A hedge in the
        # ESTABLISHED column refutes the entire pitch in one row.
        Check("no hedge filed as a fact",
              not any(
                  re.search(r"\b(might|may be|could be|probably|possibly|likely"
                            r"|looks? like|seems?|suspect|i think)\b",
                            c.get("text", ""), re.I)
                  for c in established
              ),
              "; ".join(c.get("text", "") for c in established
                        if re.search(r"\b(might|may be|could be|probably)\b",
                                     c.get("text", ""), re.I))),

        Check("one assertion is not filed twice",
              len({c.get("text", "").lower() for c in established}) == len(established),
              "duplicate rows in the Ledger"),

        # ---- attribution, Rule 1 ------------------------------------------
        Check("every claim is attributed",
              all(c.get("speakerRole") for c in established + hypotheses),
              "a claim without a source is not sayable"),

        Check("both speakers present",
              {c.get("speakerRole") for c in established} >= {"DevOps Lead", "Support Engineer"},
              "per-UID attribution collapsed to one speaker"),

        # ---- entity resolution --------------------------------------------
        # DRIFT, not count.
        #
        # This used to assert `len(entities) <= 3` and failed a run that
        # produced redis-primary / checkout-service / datadog-service /
        # carts-client — four DISTINCT things, correctly separated. Counting
        # entities measures how much the speakers mentioned, not whether
        # resolution worked.
        #
        # The failure that actually matters is one real thing under two ids
        # ("redis" and "redis-primary"), because contradiction scoping is by
        # entity equality: split the entity and the headline conflict silently
        # never fires. That is what this checks now.
        Check("entities converged (no drift)",
              _no_split_entities(entities),
              f"same thing under two ids: {[e.get('id') for e in entities]}"),

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
    ap.add_argument("--cooldown", type=int, default=120,
                    help="seconds between runs; 0 disables. 120 is sized "
                         "to Groq's free-tier 8000 tokens/MINUTE, which is "
                         "per organisation — a second key does not raise it")
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
            """
            COOLDOWN BETWEEN RUNS, and it is not padding.

            Groq's per-minute token limit is per ORGANISATION, so
            back-to-back runs spend one budget three times over. When it
            runs out the pipeline does not fail loudly: it retries, backs
            up, and Turn Windows MERGE — at which point extraction drops
            claims from the middle of a batch. The gate then reports a
            missing measurement, which reads exactly like a correctness
            regression and is not one.

            A real demo does not run three times in three minutes. Waiting
            makes this gate measure CORRECTNESS rather than throughput,
            which is what S6 is for.
            """
            if run > 1 and args.cooldown:
                print(f"{D}  cooling down {args.cooldown}s so the per-minute budget recovers…{X}")
                await asyncio.sleep(args.cooldown)

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
