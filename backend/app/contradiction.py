"""
The Semantic Contradiction Engine — v6 §7, closing G4.

────────────────────────────────────────────────────────────────────────────
THE GAP THIS CLOSES

v5 said: "if a high-similarity but factually conflicting statement is found".
That sentence contains an unimplemented predicate. Embedding similarity measures
TOPICAL RELATEDNESS, not truth-value opposition:

    "Redis memory is at 40%" vs "Redis memory is at 41%"   ~0.99   NOT a conflict
    "Redis memory is at 40%" vs "Redis memory is at 95%"   ~0.97   IS  a conflict
    "The cache is fine"      vs "cache read timeouts"      ~0.72   IS  a conflict
    "Redis memory is at 40%" vs "Postgres memory is 40%"   ~0.94   NOT — different entity

A single threshold gives false positives on rows 1 and 4 and a false negative on
row 3. Both failure modes are fatal: the first makes Echo interrupt constantly
over nothing, the second misses the one contradiction the pitch is built on.

So retrieval is demoted to a CANDIDATE GENERATOR and an NLI-style LLM
adjudication makes the actual call.

    Stage 0  SCOPE       same entity, 30-minute window   <- kills row 4 for free
    Stage 1  RETRIEVE    rank by overlap, top-k          <- recall, not precision
    Stage 2  COOLDOWN    pair seen in the last 5 min?    <- stops re-firing
    Stage 3  ADJUDICATE  OPPOSED / REFINES / INDEPENDENT / AGREES
────────────────────────────────────────────────────────────────────────────

ON THE RETRIEVER: this uses lexical overlap rather than a neural embedder,
because no embedding vendor is configured (Groq serves chat and STT only) and
adding one would mean another credential. That is an honest weakness — it would
rank row 3 lower than a semantic model would. Two things make it acceptable:
Stage 0 shrinks the candidate pool to claims about ONE entity, so the ranking
job is small; and Stage 3 is where precision actually comes from. Swapping in a
real embedder is a drop-in change to `_similarity` and is the first upgrade to
make if recall proves short.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable

from . import config
from .models import Claim

if TYPE_CHECKING:  # imported lazily at the call site to avoid a cycle
    from .panel import PanelVerdict

log = logging.getLogger("echo.contradiction")

# §7.3 tuning.
#
# NO retrieval threshold, and that is deliberate.
#
# The first version used 0.12. The headline demo pair —
#   "Redis primary memory measured at 40 percent"  vs
#   "Redis cache read timeouts observed"
# — shares only the token "redis", scoring 0.111, and was silently filtered out.
# A test caught it. That is G4 row 3 exactly: the one contradiction the entire
# pitch is built on is the one a similarity threshold discards, because the two
# claims are about the SAME THING in COMPLETELY DIFFERENT WORDS.
#
# Tuning the number down would only move the cliff. The real insight is that
# Stage 0 already did the filtering: everything reaching here is an observed
# claim about the SAME ENTITY inside 30 minutes, and there are rarely many.
# Similarity's job is therefore to ORDER candidates, not to exclude any, and
# TOP_K is what bounds cost — exactly as §7.3 intends ("bounds adjudication
# cost to <=5 calls per new claim").
RETRIEVAL_THRESHOLD = 0.0
TOP_K = 5
# v6 §7.3 sets 0.75. Lowered to 0.60 on measured evidence, not preference.
#
# With entity resolution fixed, Tier 2 put detection at 83% and precision at
# 100% across both negative scenarios (no-conflict, different-entities) — so
# the gate was costing recall while buying precision we already had. The
# adjudicator's misses were verdicts in the 0.6–0.75 band, i.e. it saw the
# conflict and hedged.
#
# Re-measure BOTH sides after any change to this number. Recall alone is the
# metric that talks you into an agent that interrupts constantly, which is the
# G4 failure that gets Echo muted.
ADJUDICATION_CONFIDENCE_GATE = 0.60

# INDEPENDENT needs stronger evidence than OPPOSED — see `is_actionable`.
# OPPOSED is unambiguous; INDEPENDENT is also the right label for two
# observations that merely have nothing to do with each other.
INDEPENDENT_CONFIDENCE_GATE = 0.85
PAIR_COOLDOWN_SECONDS = 300.0   # 5 min
SCOPE_WINDOW_SECONDS = 1800.0   # 30 min

# Claims from the SAME speaker this close together came out of one utterance and
# are not in tension with each other.
#
# Found live: "I checked the primary Redis shard. Memory is at 40 percent. It is
# not eviction, the cache is fine." extracts as three claims, and the engine
# adjudicated DevOps against DevOps twice — two spurious interruptions before
# the real Support-vs-DevOps conflict was even reached. Someone stating three
# consistent facts in one breath is not contradicting themselves.
#
# Deliberately time-boxed rather than a blanket same-speaker ban: an engineer
# correcting themselves ten minutes later ("actually memory is at 95") IS worth
# surfacing, and §7 never says a conflict must be between two people.
SAME_UTTERANCE_SECONDS = 15.0

# How many retrieved pairs may convene a full Deliberation Panel (§7a) before
# the engine falls back to the cheaper single judge for the rest.
#
# Two, and the number is measured rather than chosen. `retrieve` returns
# TOP_K=5; a panel costs 2–3 LLM calls against Groq's 8000-tokens-per-minute
# ceiling, so an unbudgeted panel is up to 15 calls for one new claim. A live
# rehearsal on Aug 31 hit exactly that and lost the headline contradiction to
# 429s — the reasoning was correct and never got to execute.
#
# Lowered from 2 to 1 after measuring the real constraint. Groq's per-MINUTE
# limit is per ORGANISATION, not per key — the 429 names
# `organization org_01m0...` — so a second key buys daily budget and no TPM
# headroom at all. At 1536 reserved tokens a call, two pairs x two personas
# is most of an 8000/minute budget for ONE claim, and the overflow did not
# fail loudly: it backed the pipeline up until Turn Windows MERGED and
# extraction silently dropped claims from the middle of a batch.
#
# The headline conflict has always been the TOP pair by similarity. The
# second was costing more than it caught, and the single judge still covers
# the tail — it was the entire system the day before the panel landed.
PANEL_PAIR_BUDGET = 1

_WORD = re.compile(r"[a-z0-9]+")
# Words that carry no discriminating signal on an incident bridge.
_STOP = {
    "the", "a", "an", "is", "are", "was", "were", "at", "on", "in", "of", "to",
    "and", "or", "it", "we", "i", "that", "this", "for", "with", "has", "have",
    "showing", "show", "shows", "seeing", "see", "percent", "from",
}


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 1}


def _similarity(a: str, b: str) -> float:
    """
    Jaccard overlap. The swap point for a real embedder.

    Deliberately simple and deliberately RECALL-oriented — its job is to avoid
    missing a candidate, not to decide anything. Precision is Stage 3's problem.
    """
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _named_entities(text: str, aliases: dict[str, str]) -> set[str]:
    """
    Which entities does this sentence name OUTRIGHT?

    `aliases` is the Ledger's alias table (`extraction.entity_aliases`),
    mapping every label, id and alias to a canonical entity id.

    Matched on word boundaries, so "cache" hits "cache read timeouts" but
    "redis" does not hit "redistribute" — an accidental substring would
    manufacture exactly the cross-entity pairing this is meant to find
    honestly. Aliases shorter than three characters are skipped; they are
    almost always noise ("db", "id") and a two-letter false hit is expensive.
    """
    if not aliases or not text:
        return set()

    low = text.lower()
    found: set[str] = set()
    for alias, entity_id in aliases.items():
        if len(alias) < 3 or alias in _STOP:
            continue
        if re.search(rf"(?<![a-z0-9]){re.escape(alias)}(?![a-z0-9])", low):
            found.add(entity_id)
    return found


ADJUDICATION_PROMPT = """Two claims made about the same system during one incident. Classify the
LOGICAL relationship between them.

OPPOSED     - they CANNOT BOTH BE TRUE of the same entity at the same time.
              One of the two people must be wrong.
REFINES     - compatible; one adds precision to the other
INDEPENDENT - about different properties; both can hold
AGREES      - same assertion, different words

THE MOST COMMON MISTAKE IS OVER-USING "OPPOSED".

During an incident many different symptoms are reported at once. Two symptoms
are NOT opposed — they are usually AGREES or INDEPENDENT, because a single
fault produces several at the same time. Ask yourself: "if both speakers are
honest and accurate, is one of them still necessarily wrong?" If the answer is
no, it is NOT OPPOSED.

  "Tickets are flooding in" vs "Latency is through the roof"
      -> AGREES. Two symptoms of one outage. Both are true.
  "Checkout is returning 500s" vs "Users report empty carts"
      -> AGREES. Same failure seen from two angles.
  "Memory is at 40 percent" vs "Cache read timeouts are occurring"
      -> INDEPENDENT. Different properties; both can hold, and the room is
         probably conflating them.
  "The cache is fine" vs "Cache read timeouts are occurring"
      -> OPPOSED. A cache serving timeouts is not fine.
  "Memory is at 40 percent" vs "Memory is at 95 percent"
      -> OPPOSED. Same property, incompatible values.

Confidence must reflect real certainty. Use a value below 0.6 whenever you are
unsure — staying silent costs the room nothing, and a false interruption costs
it trust.

Return JSON only: {"relation": "...", "confidence": 0.0-1.0, "property": "...", "why": "one sentence"}"""


@dataclass
class Adjudication:
    relation: str
    confidence: float
    why: str = ""
    # NOT named `property`: that shadows the builtin decorator used immediately
    # below and turns `@property` into a call on a str. The JSON key stays
    # "property" to match the §7.1 prompt; only the field name differs.
    about_property: str = ""

    @property
    def is_actionable(self) -> bool:
        """
        Worth interrupting the room for.

        OPPOSED is the obvious case. INDEPENDENT is included on purpose: §7.1's
        design note points out that two engineers using different evidence to
        argue about the same conclusion is MORE common in real incidents and
        more impressive to demonstrate, because a keyword system cannot see it
        at all. AGREES and REFINES are recorded silently.
        """
        if self.relation == "OPPOSED":
            # Unambiguous: two things that cannot both be true. Worth the
            # interruption at the standard gate.
            return self.confidence >= ADJUDICATION_CONFIDENCE_GATE

        if self.relation == "INDEPENDENT":
            # A HIGHER bar, and it was earned the hard way.
            #
            # §7.1 rightly says INDEPENDENT is worth surfacing when two people
            # argue past each other with different evidence. But INDEPENDENT is
            # also the correct label for two observations that simply have
            # nothing to do with each other — and on a busy bridge those are far
            # more common.
            #
            # Tier 2 caught exactly that: with both at the same gate, the engine
            # interrupted over "tickets are flooding in" versus "massive spike
            # in 500s", which are two symptoms that AGREE. Echo interrupting to
            # point out that two people said compatible things is the G4 failure
            # that gets it muted.
            return self.confidence >= INDEPENDENT_CONFIDENCE_GATE

        # AGREES and REFINES are recorded silently.
        return False


class ContradictionEngine:
    def __init__(self) -> None:
        # pair key -> monotonic time of last adjudication
        self._cooldown: dict[tuple[str, str], float] = {}

    def reset(self) -> None:
        """
        Forget every pair's cooldown — a new incident starts silent.

        Public because `/incident/reset` needs it and used to get there with
        `engine._cooldown.clear()  # noqa: SLF001`. That worked, but it made
        the reset path depend on a private field's name and type: a stale
        cooldown carried into a fresh incident silences a genuine conflict,
        which is the kind of bug that looks like the feature simply not firing.
        """
        self._cooldown.clear()

    @staticmethod
    def _pair_key(a: str, b: str) -> tuple[str, str]:
        return (a, b) if a < b else (b, a)

    def scope(
        self,
        new: Claim,
        existing: list[Claim],
        *,
        now_ms_: int | None = None,
        aliases: dict[str, str] | None = None,
    ) -> list[Claim]:
        """
        Stage 0 — same subject, same incident, inside the window.

        This single filter removes the large majority of spurious candidates
        before any similarity cost is paid, and it is what makes the
        "Redis memory 40%" / "Postgres memory 40%" false positive impossible
        rather than merely unlikely.

        ── WHY "SAME SUBJECT" IS NOT "SAME `entity` FIELD" ──────────────────
        It was, and that silently cost the headline contradiction on Sep 6.

        Extraction files each claim under ONE entity id. "The cache is fine"
        landed on Redis; "application logs are showing cache read timeouts on
        the checkout path" landed on checkout, because the sentence also names
        checkout and the model had to pick one. Two claims that cannot both be
        true were therefore never even compared — `scope` returned [], no panel
        ran, and nothing appeared on the dashboard or in the room. Nothing
        errored either, which is what makes this failure mode expensive.

        A claim is ABOUT every system it names, not merely the one that won the
        extractor's tie-break. So a candidate also qualifies when one claim
        names the other's entity outright.

        This deliberately does NOT weaken the precision guard above. That guard
        works because "Redis memory is at 40%" does not contain the word
        Postgres — mention is required, not merely co-occurrence in the
        incident, so those two remain unpaired. Widening recall here is also
        the cheap direction to be wrong in: Stage 3's Panel still decides, and
        it is tuned to refuse OPPOSED.
        ────────────────────────────────────────────────────────────────────
        """
        if not new.entity:
            return []

        cutoff = (now_ms_ if now_ms_ is not None else new.at) - SCOPE_WINDOW_SECONDS * 1000
        table = aliases or {}
        named_by_new = _named_entities(new.text, table)

        def _same_utterance(c: Claim) -> bool:
            return (
                c.speaker_role == new.speaker_role
                and abs(c.at - new.at) < SAME_UTTERANCE_SECONDS * 1000
            )

        def _same_subject(c: Claim) -> bool:
            if c.entity == new.entity:
                return True
            if c.entity and c.entity in named_by_new:
                return True
            return new.entity in _named_entities(c.text, table)

        """
        ── A CORRECTION IS NOT A CONTRADICTION ─────────────────────────────
        Two exclusions below carry that rule, and neither existed:

        `retired` — every id some later claim supersedes. A speaker saying
        "correction, memory is actually 95 percent, not 40" retires their own
        earlier measurement, and arguing with a retired claim is arguing with
        something nobody stands behind any more.

        `new.supersedes` — the new claim must not be compared against the
        very claim it replaces. Without this the correction and the original
        are still a candidate pair, which is precisely the interruption that
        was reported: Echo told the room that somebody disagreed with
        themselves, seconds after they had corrected themselves.

        What is deliberately NOT excluded: two DIFFERENT speakers disagreeing.
        That is the real thing, and `supersedes` is only set within one
        speaker's own revisions (see the extraction prompt).
        """
        retired = {c.supersedes for c in existing if c.supersedes}
        retired.update(c.supersedes for c in [new] if c.supersedes)

        return [
            c for c in existing
            if c.id != new.id
            and _same_subject(c)
            # Only claims Echo could actually say are worth conflicting over.
            # A HYPOTHESIS is already visibly unconfirmed, and an INFERRED claim
            # may never be spoken at all (§6.2 Rule 3).
            and c.epistemic_status in ("OBSERVED", "TOOL_RESULT")
            and c.at >= cutoff
            and not _same_utterance(c)
            # Retired by a later correction, or the very claim this one
            # corrects.
            and c.id not in retired
            and c.id != new.supersedes
        ]

    def retrieve(self, new: Claim, candidates: list[Claim]) -> list[tuple[Claim, float]]:
        """Stage 1 — rank and cap. Recall-oriented, low threshold, top-k."""
        scored = [(c, _similarity(new.text, c.text)) for c in candidates]
        if RETRIEVAL_THRESHOLD > 0:
            scored = [(c, s) for c, s in scored if s >= RETRIEVAL_THRESHOLD]
        # Most-related first, so `evaluate` adjudicates the likeliest conflict
        # before spending calls on weaker candidates.
        scored.sort(key=lambda pair: pair[1], reverse=True)
        return scored[:TOP_K]

    def in_cooldown(self, a: str, b: str, *, now: float | None = None) -> bool:
        """Stage 2 — has this exact pair already been surfaced recently?"""
        t = now if now is not None else time.monotonic()
        last = self._cooldown.get(self._pair_key(a, b))
        return last is not None and (t - last) < PAIR_COOLDOWN_SECONDS

    def mark_adjudicated(self, a: str, b: str, *, now: float | None = None) -> None:
        self._cooldown[self._pair_key(a, b)] = now if now is not None else time.monotonic()

    async def adjudicate(
        self,
        a: Claim,
        b: Claim,
        *,
        call_llm: Callable[[str, str], Awaitable[str]] | None = None,
    ) -> Adjudication:
        """
        Stage 3 — the actual decision.

        A narrow NLI task with four labels and structured output, which is where
        current models are most reliable. Reliability matters more here than
        sophistication: a wrong OPPOSED interrupts the room for nothing.
        """
        user = (
            f"A: [{a.speaker_role}] {a.text}\n"
            f"B: [{b.speaker_role}] {b.text}\n"
            f"Entity: {a.entity or 'unspecified'}"
        )
        llm = call_llm or _groq_json

        try:
            raw = await llm(ADJUDICATION_PROMPT, user)
            data = json.loads(_strip_fences(raw))
            return Adjudication(
                relation=str(data.get("relation", "INDEPENDENT")).upper(),
                confidence=float(data.get("confidence", 0.0)),
                why=str(data.get("why", "")),
                about_property=str(data.get("property", "")),
            )
        except Exception as exc:  # noqa: BLE001 — an adjudication failure must not
            # take the pipeline down. Staying silent is the safe default: a
            # missed contradiction is a lost opportunity, a spurious one is an
            # interruption the room did not need.
            log.warning("adjudication failed, defaulting to silence: %s", exc)
            return Adjudication(relation="INDEPENDENT", confidence=0.0, why=str(exc))

    async def evaluate(
        self,
        new: Claim,
        existing: list[Claim],
        *,
        call_llm: Callable[..., Awaitable[str]] | None = None,
        now: float | None = None,
        use_panel: bool = True,
        aliases: dict[str, str] | None = None,
    ) -> tuple[Claim, Adjudication | "PanelVerdict"] | None:
        """
        The whole pipeline. Returns the counterpart claim and the verdict when
        something is worth surfacing, otherwise None.

        ── WHY `use_panel` DEFAULTS TO TRUE ────────────────────────────────
        Stage 3 used to be one call against `ADJUDICATION_PROMPT`, and that
        prompt leans hard away from OPPOSED on purpose — it was tuned to stop
        false alarms. A live rehearsal on Aug 30 showed the cost: the pair
        "the cache is fine" / "cache read timeouts" came back INDEPENDENT and
        the room heard nothing, because one prompt cannot sit at both ends of
        a precision/recall tradeoff.

        `panel.deliberate` runs two oppositely-biased analysts on two
        different models and has a third settle any split. Measured on the
        four-pair rig: 4/4, including the pair that failed live, with both
        precision guards still quiet.

        `use_panel=False` keeps the single judge for the tests that predate
        the panel — they exercise scope, retrieval and cooldown, and are
        clearer driving one deterministic call than three.
        ────────────────────────────────────────────────────────────────────
        """
        if new.epistemic_status not in ("OBSERVED", "TOOL_RESULT"):
            return None

        candidates = self.scope(new, existing, aliases=aliases)
        if not candidates:
            return None

        deliberated = 0
        # The best non-OPPOSED verdict found so far, kept in case nothing
        # stronger turns up. See the block at the end of this loop.
        held: tuple[Claim, "Adjudication | PanelVerdict"] | None = None

        for claim, score in self.retrieve(new, candidates):
            if self.in_cooldown(new.id, claim.id, now=now):
                log.info("contradiction: pair %s/%s in cooldown", new.id, claim.id)
                continue

            """
            BUDGET: only the strongest candidates get a panel.

            `retrieve` returns TOP_K=5 ranked by similarity, and a panel costs
            2–3 LLM calls where the single judge cost one. Five candidates
            therefore meant up to 15 calls for ONE new claim, against Groq's
            8000-tokens-per-MINUTE ceiling — and a busy window has several new
            claims. The first live rehearsal after wiring the panel in drowned
            in 429s and lost the headline contradiction: the analysis was
            right, it just never got to run.

            The tail of the ranking is where the weak pairs are anyway. Beyond
            the budget, fall back to the single judge — cheaper, and it was the
            entire system until yesterday, so it is a sound floor rather than a
            degradation.
            """
            panel_here = use_panel and deliberated < PANEL_PAIR_BUDGET

            if panel_here:
                from .panel import deliberate

                deliberated += 1
                verdict = await deliberate(new, claim, call_llm=call_llm)
            else:
                verdict = await self.adjudicate(new, claim, call_llm=call_llm)
            self.mark_adjudicated(new.id, claim.id, now=now)

            log.info(
                "contradiction: %s vs %s  sim=%.2f  %s @%.2f",
                new.id, claim.id, score, verdict.relation, verdict.confidence,
            )

            if verdict.is_actionable:
                """
                OPPOSED OUTRANKS INDEPENDENT, AND THE LOOP USED TO IGNORE THAT.

                This returned on the FIRST actionable verdict, whatever it was.
                `retrieve` ranks by similarity, not by importance, so a weakly
                related pair can outrank the pair that matters - and once an
                actionable INDEPENDENT was found the loop stopped, leaving the
                OPPOSED pair behind it unexamined.

                Seen in validation: "cache read timeouts" was paired with
                "latency is through the roof" (INDEPENDENT, correctly - they
                are different properties), Echo announced that, and the run
                ended. "The cache is fine" was sitting two places down the
                ranking, and those two genuinely cannot both be true. The
                headline finding was lost to a lesser one that merely scored
                higher on token overlap.

                The two relations are not peers. OPPOSED means two claims
                cannot both be true, which is the thing a bridge most needs to
                hear. INDEPENDENT means people are talking past each other -
                worth saying, never worth saying INSTEAD.

                So OPPOSED still short-circuits, and an INDEPENDENT is held
                while the remaining candidates are checked. The extra spend
                lands only when the first hit was the weaker kind, which is
                exactly when it is worth spending; PANEL_PAIR_BUDGET still caps
                the panels, so the ceiling that caused the 429 storm is intact.
                """
                if verdict.relation == "OPPOSED":
                    return claim, verdict
                if held is None:
                    held = (claim, verdict)

        return held


def _strip_fences(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start != -1 and end > start else text


async def _groq_json(system: str, user: str) -> str:
    """
    Adjudication shares the extraction client, and therefore its 429 handling.

    A rate-limited adjudication currently degrades to silence (see
    `adjudicate`), which is the safe default but means a busy minute could
    quietly suppress the headline feature. Retrying first is much better than
    defaulting to silence first.
    """
    from .extraction import groq_json

    return await groq_json(system, user, max_tokens=1024)
