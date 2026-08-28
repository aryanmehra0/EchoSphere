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
from typing import Any, Awaitable, Callable

from . import config
from .models import Claim

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
ADJUDICATION_CONFIDENCE_GATE = 0.75
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


ADJUDICATION_PROMPT = """Two claims about the same system entity. Classify their logical relationship.

OPPOSED     - cannot both be true of the same entity at the same time
REFINES     - compatible; one adds precision to the other
INDEPENDENT - about different properties; both can hold
AGREES      - same assertion, different words

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
        return (
            self.relation in ("OPPOSED", "INDEPENDENT")
            and self.confidence >= ADJUDICATION_CONFIDENCE_GATE
        )


class ContradictionEngine:
    def __init__(self) -> None:
        # pair key -> monotonic time of last adjudication
        self._cooldown: dict[tuple[str, str], float] = {}

    @staticmethod
    def _pair_key(a: str, b: str) -> tuple[str, str]:
        return (a, b) if a < b else (b, a)

    def scope(self, new: Claim, existing: list[Claim], *, now_ms_: int | None = None) -> list[Claim]:
        """
        Stage 0 — same entity, same incident, inside the window.

        This single filter removes the large majority of spurious candidates
        before any similarity cost is paid, and it is what makes the
        "Redis memory 40%" / "Postgres memory 40%" false positive impossible
        rather than merely unlikely.
        """
        if not new.entity:
            return []

        cutoff = (now_ms_ if now_ms_ is not None else new.at) - SCOPE_WINDOW_SECONDS * 1000

        def _same_utterance(c: Claim) -> bool:
            return (
                c.speaker_role == new.speaker_role
                and abs(c.at - new.at) < SAME_UTTERANCE_SECONDS * 1000
            )

        return [
            c for c in existing
            if c.id != new.id
            and c.entity == new.entity
            # Only claims Echo could actually say are worth conflicting over.
            # A HYPOTHESIS is already visibly unconfirmed, and an INFERRED claim
            # may never be spoken at all (§6.2 Rule 3).
            and c.epistemic_status in ("OBSERVED", "TOOL_RESULT")
            and c.at >= cutoff
            and not _same_utterance(c)
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
        call_llm: Callable[[str, str], Awaitable[str]] | None = None,
        now: float | None = None,
    ) -> tuple[Claim, Adjudication] | None:
        """
        The whole pipeline. Returns the counterpart claim and the verdict when
        something is worth surfacing, otherwise None.
        """
        if new.epistemic_status not in ("OBSERVED", "TOOL_RESULT"):
            return None

        candidates = self.scope(new, existing)
        if not candidates:
            return None

        for claim, score in self.retrieve(new, candidates):
            if self.in_cooldown(new.id, claim.id, now=now):
                log.info("contradiction: pair %s/%s in cooldown", new.id, claim.id)
                continue

            verdict = await self.adjudicate(new, claim, call_llm=call_llm)
            self.mark_adjudicated(new.id, claim.id, now=now)

            log.info(
                "contradiction: %s vs %s  sim=%.2f  %s @%.2f",
                new.id, claim.id, score, verdict.relation, verdict.confidence,
            )

            if verdict.is_actionable:
                return claim, verdict

        return None


def _strip_fences(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    return text[start : end + 1] if start != -1 and end > start else text


async def _groq_json(system: str, user: str) -> str:
    from groq import AsyncGroq

    client = AsyncGroq(api_key=config.groq_api_key())
    resp = await client.chat.completions.create(
        model=config.analysis_model(),
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.0,  # a judgment call should not vary between runs
        max_tokens=1024,
    )
    return resp.choices[0].message.content or "{}"
