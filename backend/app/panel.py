"""
The Deliberation Panel — §7a.

── WHY THIS EXISTS ─────────────────────────────────────────────────────────
Adjudication was one LLM call against one prompt, and that prompt carries a
deliberate thumb on the scale:

    THE MOST COMMON MISTAKE IS OVER-USING "OPPOSED".

That line was added for a real reason — early runs interrupted the room over
two symptoms of one fault, which is worse than saying nothing. But a single
prompt cannot sit at both ends of a precision/recall tradeoff, and the bias
has since over-corrected. A live rehearsal on Aug 30 fed the headline pair:

    DevOps Lead      "Memory is at 40 percent. The cache is fine."
    Support Engineer "application logs are showing cache read timeouts"

Entity resolution was correct (both on `redis`), scope was correct (different
speakers, 14.3s apart), retrieval was correct. The adjudicator returned
INDEPENDENT and the room heard nothing. The prompt's own example table
teaches exactly that answer for the memory/timeout pair, while teaching
OPPOSED for the fine/timeout pair — so the verdict depended on which
candidate came back first.

One judge with one bias cannot be tuned out of this. So: three, with
DIFFERENT biases, and their disagreement becomes part of the output rather
than something to be averaged away.

── WHY IT DOES NOT BREAK RULE 1 ────────────────────────────────────────────
"Echo never asserts causation" is the grading rubric, and a panel that
argued about ROOT CAUSE would break it outright.

So the personas do not argue about what broke. They argue about EVIDENCE:
whether two statements can both be true, and which reading the evidence
better supports. The Referee says why one READING is wrong — never why a
SYSTEM failed. That distinction is enforced here in code, not left to a
prompt: `_causally_clean()` runs the §6 tripwire over every persona's words
before any of it is allowed to leave this module.

The panel makes Echo MORE careful, not more confident. It is the same
restraint applied one level up — Echo now shows its own uncertainty about
its own judgement, instead of presenting a single verdict as settled.

── WHY IT IS ESSENTIALLY FREE ──────────────────────────────────────────────
Groq's daily cap is scoped PER MODEL (see `config.analysis_models`). Putting
each persona on a different model buys genuine independence — they cannot
anchor on each other — and draws each one from a separate daily bucket. A
three-persona panel costs about what one adjudication cost, in quota terms.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

log = logging.getLogger("echo.panel")

# OPPOSED is inherited unchanged from the single-judge era, so the headline
# behaviour stays comparable. See `contradiction.ADJUDICATION_CONFIDENCE_GATE`.
OPPOSED_GATE = 0.60

# INDEPENDENT is REBASED, and the arithmetic matters.
#
# It now also requires dissent (see `PanelVerdict.is_actionable`), and a split
# costs DISSENT_PENALTY. Leaving the old 0.85 here while subtracting 0.15 from
# every contested verdict meant only a perfect 1.00 could ever clear it — the
# path was dead, and the first test written against it caught that.
#
# The gate is checked AFTER the penalty, so 0.70 here is the same bar the
# single judge held at 0.85 before it. Combined with the dissent requirement,
# INDEPENDENT is now strictly harder to trigger than it used to be.
INDEPENDENT_GATE = 0.70

# A dissenting minority does not get to veto, but it does get to lower the
# confidence of the majority — the panel should sound less certain when it
# was not unanimous, because it genuinely is less certain.
DISSENT_PENALTY = 0.15


# ---------------------------------------------------------------------------
# The personas
# ---------------------------------------------------------------------------

_SHARED_RULES = """
OPPOSED     - they CANNOT BOTH BE TRUE of the same entity at the same time.
REFINES     - compatible; one adds precision to the other
INDEPENDENT - about different properties; both can hold
AGREES      - same assertion, different words

You are judging EVIDENCE, not diagnosing a fault. Never state or imply what
caused the incident. Do not use the words "because", "due to", "caused by",
or "root cause" about the SYSTEM. You may use them about the STATEMENTS.

Return JSON only:
{"relation": "...", "confidence": 0.0-1.0, "property": "...", "why": "one sentence"}
"""

SKEPTIC_PROMPT = """You are the SKEPTIC on an incident bridge. Your job is to PREVENT FALSE ALARMS.

Two claims were made about the same system. Classify their logical relationship.
""" + _SHARED_RULES + """
YOUR BIAS, AND IT IS DELIBERATE: during an incident many symptoms appear at
once, and a single fault produces several of them. Two symptoms are almost
never OPPOSED. Ask: "if both speakers are honest and accurate, is one of them
still NECESSARILY wrong?" If no, it is not OPPOSED.

  "Tickets are flooding in" vs "Latency is through the roof"
      -> AGREES. Two symptoms of one outage.
  "Memory is at 40 percent" vs "Memory is at 95 percent"
      -> OPPOSED. Same property, incompatible values.

Interrupting a room for nothing costs trust. When unsure, score below 0.6."""

SEEKER_PROMPT = """You are the SEEKER on an incident bridge. Your job is to CATCH THE CONFLICT
EVERYONE ELSE TALKED PAST.

Two claims were made about the same system. Classify their logical relationship.
""" + _SHARED_RULES + """
YOUR BIAS, AND IT IS DELIBERATE: incident bridges lose hours because two
people hold incompatible pictures and neither notices. A blanket summary
("the cache is fine") and a specific measurement ("cache read timeouts on
checkout") CONFLICT even though they describe different properties — the
summary asserts a health verdict the observation contradicts.

  "The cache is fine" vs "Cache read timeouts are occurring"
      -> OPPOSED. A cache serving timeouts is not fine.
  "Memory is at 40 percent" vs "Cache read timeouts are occurring"
      -> INDEPENDENT, and worth saying so: two people are reasoning about
         one component from different properties and may be arguing past
         each other.

Do not invent conflicts between plain symptoms. But do not let a confident
summary stand unchallenged against a contradicting measurement."""

REFEREE_PROMPT = """You are the REFEREE on an incident bridge. Two analysts disagreed about the
SAME PAIR of statements. Decide which reading the evidence better supports.

You are judging their READINGS, not the incident. Never state what caused the
outage. "Wrong" here means "wrong about the relationship between these two
statements" — nothing else.

Weigh: does one statement assert a HEALTH VERDICT that the other's
MEASUREMENT contradicts? A verdict ("X is fine") is contradicted by an
observation of X failing, even when the properties differ.

Return JSON only:
{"relation": "...", "confidence": 0.0-1.0, "property": "...",
 "why": "one sentence for the winning reading",
 "why_other_failed": "one sentence on what the other analyst missed"}"""


@dataclass(frozen=True)
class Persona:
    name: str
    prompt: str
    model: str
    """Pinned so the personas cannot anchor on each other, and so each draws
    from its own daily quota bucket."""


def personas() -> tuple[list[Persona], Persona]:
    """
    Built at call time, not import time, so the models follow config/env.

    The pairing is deliberate: the SKEPTIC keeps the strongest model, because
    suppressing a false alarm correctly is the harder judgement and the more
    expensive mistake. The SEEKER only has to notice a candidate — the
    Referee re-checks it before anything reaches the room.
    """
    from . import config

    chain = config.analysis_models()
    primary = chain[0]
    second = chain[1] if len(chain) > 1 else primary
    third = chain[2] if len(chain) > 2 else primary

    return [
        Persona("SKEPTIC", SKEPTIC_PROMPT, primary),
        Persona("SEEKER", SEEKER_PROMPT, second),
    ], Persona("REFEREE", REFEREE_PROMPT, third)


# ---------------------------------------------------------------------------
# What a deliberation produces
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Position:
    """One persona's read, kept verbatim so the dashboard can show the argument."""
    persona: str
    model: str
    relation: str
    confidence: float
    why: str = ""
    why_other_failed: str = ""
    """Referee only — what the losing analyst missed. Empty for the bench."""

    def as_dict(self) -> dict[str, object]:
        return {
            "persona": self.persona,
            "model": self.model,
            "relation": self.relation,
            "confidence": round(self.confidence, 2),
            "why": self.why,
            "whyOtherFailed": self.why_other_failed,
        }


@dataclass(frozen=True)
class PanelVerdict:
    """
    The reconciled outcome, plus the reasoning that produced it.

    `positions` and `dissent` are the point. A single verdict hides that the
    judgement was close; showing the split lets a human weigh Echo's certainty
    instead of inheriting it — which is the same principle as separating
    OBSERVED from HYPOTHESIS, applied to Echo's own analysis.
    """
    relation: str
    confidence: float
    why: str = ""
    about_property: str = ""
    positions: list[Position] = field(default_factory=list)
    dissent: bool = False
    why_other_failed: str = ""

    @property
    def is_actionable(self) -> bool:
        """
        Worth interrupting the room for.

        ── WHY INDEPENDENT ALSO REQUIRES A SPLIT ───────────────────────────
        The single judge surfaced INDEPENDENT above 0.85 on the theory that
        two engineers arguing past each other with different evidence is
        worth naming. Under a panel that rule misfires, and a live run showed
        exactly how: "users say their carts empty" against "latency is
        through the roof" came back unanimous INDEPENDENT at 0.90 and
        interrupted the bridge. Both analysts were RIGHT — those are two
        different properties — but agreeing on that is the default state of
        any two claims about one entity, and averaging two confident votes
        clears a fixed gate far more easily than one vote ever did.

        So confidence alone no longer earns the interruption. The analysts
        must have DISAGREED about how the pair relates: a split is the signal
        that something subtle is happening, whereas easy unanimity is the
        signal that nothing is.

        This deliberately costs a demo beat — the redis memory/timeout pair
        was a scripted INDEPENDENT moment and now stays quiet. That is the
        right trade. Restraint is the product, one sharp intervention beats
        two soft ones, and a false interruption costs more trust than a
        missed nuance.
        ─────────────────────────────────────────────────────────────────────
        """
        if self.relation == "OPPOSED":
            return self.confidence >= OPPOSED_GATE
        if self.relation == "INDEPENDENT":
            return self.dissent and self.confidence >= INDEPENDENT_GATE
        return False

    def as_dict(self) -> dict[str, object]:
        return {
            "relation": self.relation,
            "confidence": round(self.confidence, 2),
            "why": self.why,
            "property": self.about_property,
            "dissent": self.dissent,
            "whyOtherFailed": self.why_other_failed,
            "positions": [p.as_dict() for p in self.positions],
        }


# ---------------------------------------------------------------------------
# Rule 1 enforcement — in code, not in a prompt
# ---------------------------------------------------------------------------

# A prompt asking a model not to diagnose is a request. This is the guarantee.
#
# ── WHY THIS IS TWO LISTS AND NOT ONE REGEX ─────────────────────────────────
# The first version matched fixed phrases ("is caused by", "root cause is") and
# the very first panel run walked straight through it. The REFEREE, asked why
# one analyst was wrong, wrote:
#
#   "High latency is a direct technical CAUSE of user-facing failures … ticket
#    volume is a DOWNSTREAM CONSEQUENCE OF the latency issue."
#
# Textbook Rule 1 violation, in Echo's own voice, on the dashboard. The phrase
# list could not have caught it — English has too many ways to assert cause.
#
# So the test is structural instead: does a causal connector appear in the same
# SENTENCE as a piece of system telemetry? Reasoning about a READING ("the
# Seeker's answer is wrong because it ignored the verdict") carries no
# telemetry noun and survives. Reasoning about the SYSTEM ("latency caused the
# tickets") always names one, and dies.
# ────────────────────────────────────────────────────────────────────────────
_CAUSAL_CONNECTOR = re.compile(
    r"\b("
    r"caus(e|es|ed|ing|al|ally|ality)|root\s+cause|because\s+of|due\s+to|owing\s+to"
    r"|consequence|downstream|upstream\s+of|stems?\s+from|arises?\s+from"
    r"|result(s|ed|ing)?\s+(in|from)|lead(s|ing)?\s+to|led\s+to"
    r"|trigger(s|ed|ing)?\s+by|responsible\s+for|culprit|explains?\s+(the|why)"
    r"|knock-?on|cascad(e|es|ed|ing)"
    r")\b",
    re.I,
)

# Telemetry and component vocabulary. A causal connector next to any of these
# is a diagnosis of the system, whatever grammar it is wearing.
_SYSTEM_NOUN = re.compile(
    r"\b("
    r"latency|cache|redis|memcach\w*|memory|ram|timeouts?|errors?|5\d\d|5xx|4xx"
    r"|deploy\w*|release|rollout|shard|network|database|db|postgres|disk|cpu"
    r"|evict\w*|queue|throughput|outage|degradation|failures?|spike|checkout"
    r"|service|endpoint|node|pod|container|replica|connection|traffic|load"
    r"|tickets?|carts?|purchase|users?"
    # Abstract telemetry words. A Referee explaining a READING has no need of
    # these; one drifting into diagnosis reaches for them immediately — this
    # list grew from "causally linked SYMPTOMS of the same INCIDENT", which
    # walked through the first version untouched.
    r"|symptoms?|metrics?|incident|degrad\w*|behaviou?r|telemetry"
    r")\b",
    re.I,
)


def _causally_clean(text: str, *, where: str) -> str:
    """
    Drop any persona sentence that diagnoses the system.

    Sentence-by-sentence rather than all-or-nothing, so a Referee that makes
    one clean point and one causal one keeps the clean half.

    Dropping beats rewriting: a half-scrubbed causal claim is more dangerous
    than no explanation, because it still reads as a diagnosis to a human
    skimming the dashboard under pressure. Losing the sentence costs a line of
    colour; keeping it costs the rubric.
    """
    if not text:
        return ""

    kept: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        if not sentence:
            continue
        if _CAUSAL_CONNECTOR.search(sentence) and _SYSTEM_NOUN.search(sentence):
            log.warning(
                "panel: dropped a causal assertion from %s: %r", where, sentence,
            )
            continue
        kept.append(sentence)

    return " ".join(kept)


# ---------------------------------------------------------------------------
# The deliberation
# ---------------------------------------------------------------------------

_LlmCall = Callable[..., Awaitable[str]]


def _strip_fences(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return text


# ── WHY THIS NUMBER IS 1536 AND NOT 4096 OR 320 ─────────────────────────────
# Groq's per-minute limit counts RESERVED output, not produced output — its own
# 429 reads "Limit 8000, Used 6140, Requested 1903". At the default 4096, three
# personas reserve 12k against an 8k/minute ceiling before a single token comes
# back, and the first live Mode A rehearsal after wiring the panel in drowned in
# 429s and lost the headline contradiction. The analysis was correct; it never
# got to run.
#
# The obvious fix — "a verdict is 40 tokens of JSON, so reserve 320" — is WRONG,
# and failed immediately with:
#
#     max completion tokens reached before generating a valid document
#
# `gpt-oss-120b` is a REASONING model. It emits reasoning tokens before the
# JSON, so a tight ceiling truncates it mid-thought and every persona abstains —
# turning a rate-limit problem into a total-silence problem.
#
# 1536 is the measured middle: a 2.7× cut in reservation, still ample headroom
# for the reasoning pass. Do not tighten this to "just enough for the JSON".
PANEL_MAX_TOKENS = 1536


async def _ask(persona: Persona, user: str, call_llm: _LlmCall) -> Position:
    """One persona's independent read. A failure is a silent abstention."""
    try:
        raw = await call_llm(
            persona.prompt, user,
            models=[persona.model], max_tokens=PANEL_MAX_TOKENS,
        )
        data = json.loads(_strip_fences(raw))
        return Position(
            persona=persona.name,
            model=persona.model,
            relation=str(data.get("relation", "INDEPENDENT")).upper(),
            confidence=float(data.get("confidence", 0.0)),
            why=_causally_clean(str(data.get("why", "")), where=persona.name),
            why_other_failed=_causally_clean(
                str(data.get("why_other_failed", "")), where=persona.name,
            ),
        )
    except Exception as exc:  # noqa: BLE001 — one persona failing must not
        # take the panel down; an abstention just means fewer votes. This is
        # why the quorum below is written against however many came back.
        log.warning("panel: %s abstained (%s)", persona.name, exc)
        return Position(persona.name, persona.model, "ABSTAIN", 0.0, "")


async def deliberate(
    a: object,
    b: object,
    *,
    call_llm: _LlmCall | None = None,
) -> PanelVerdict:
    """
    Two biased analysts read the same pair, and a Referee settles any split.

    `a` and `b` are Claims — typed loosely so this module stays importable by
    the rig without dragging the Ledger in.
    """
    if call_llm is None:
        from .extraction import groq_json as call_llm  # type: ignore[assignment]

    user = (
        f"A: [{getattr(a, 'speaker_role', '?')}] {getattr(a, 'text', '')}\n"
        f"B: [{getattr(b, 'speaker_role', '?')}] {getattr(b, 'text', '')}\n"
        f"Entity: {getattr(a, 'entity', None) or 'unspecified'}"
    )

    bench, referee = personas()

    # Concurrently, so the panel costs one round-trip of latency rather than
    # N. §12.2 gives the Slow Loop 4s and a serial panel would spend it all.
    positions = list(await asyncio.gather(*(_ask(p, user, call_llm) for p in bench)))

    voted = [p for p in positions if p.relation != "ABSTAIN"]
    if not voted:
        # Everyone failed. Silence is the safe default, exactly as before.
        return PanelVerdict("INDEPENDENT", 0.0, "panel unavailable", positions=positions)

    if len(voted) == 1:
        # A single surviving voice is the old single-judge behaviour, and it
        # should not gain confidence from being alone in the room.
        only = voted[0]
        return PanelVerdict(
            relation=only.relation,
            confidence=max(0.0, only.confidence - DISSENT_PENALTY),
            why=only.why,
            positions=positions,
            dissent=False,
        )

    agreed = len({p.relation for p in voted}) == 1

    if agreed:
        # Unanimous. Confidence is the mean rather than the max — two judges
        # agreeing at 0.6 is not the same as one judge certain at 0.95.
        mean = sum(p.confidence for p in voted) / len(voted)
        best = max(voted, key=lambda p: p.confidence)
        log.info("panel: unanimous %s @%.2f", best.relation, mean)
        return PanelVerdict(
            relation=best.relation,
            confidence=mean,
            why=best.why,
            positions=positions,
            dissent=False,
        )

    # ---- they disagree: this is the case the panel exists for --------------
    log.info(
        "panel: split — %s",
        ", ".join(f"{p.persona}={p.relation}@{p.confidence:.2f}" for p in voted),
    )

    ruling = await _ask(referee, user + "\n\nANALYSTS DISAGREED:\n" + "\n".join(
        f"- {p.persona} said {p.relation} ({p.confidence:.2f}): {p.why}" for p in voted
    ), call_llm)

    if ruling.relation == "ABSTAIN":
        # No tie-breaker available. Fall back to the SKEPTIC — defaulting to
        # the quieter reading keeps a failed panel from interrupting the room.
        skeptic = next((p for p in voted if p.persona == "SKEPTIC"), voted[0])
        return PanelVerdict(
            relation=skeptic.relation,
            confidence=max(0.0, skeptic.confidence - DISSENT_PENALTY),
            why=skeptic.why,
            positions=positions,
            dissent=True,
        )

    return PanelVerdict(
        relation=ruling.relation,
        confidence=max(0.0, ruling.confidence - DISSENT_PENALTY),
        why=ruling.why,
        positions=[*positions, ruling],
        dissent=True,
        why_other_failed=ruling.why_other_failed,
    )
