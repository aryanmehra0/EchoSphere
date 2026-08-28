"""
Echo's mouth — v6 §6.2, enforced in code rather than requested in a prompt.

────────────────────────────────────────────────────────────────────────────
WHY THIS MODULE EXISTS AT ALL

v6 planned for Echo's proactive speech to come from Custom Instruction
Injection: the Slow Loop sends an *instruction*, and the Fast Loop LLM decides
what to say. §6.2 admits the weakness openly — "Rules 1 and 2 are
prompt-enforced and could be violated by a creative model."

Live testing found that injection does not reliably produce speech at all, and
that Agora exposes `POST /agents/{id}/speak`, which drives the TTS module with
a literal string. That turned a workaround into an upgrade:

    the Slow Loop now composes Echo's EXACT words.

So Rules 1 and 2 stop being a hope about model behaviour and become a property
of this file, which is unit-tested. A sentence that lacks attribution, or that
asserts causation in the indicative, cannot be constructed — `compose()` raises
before a single byte reaches the channel.

Rule 3 (INFERRED never spoken) is enforced one layer up, in the Bridge
Controller, which filters inferred claims out of every payload.
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import re

from .models import Claim, Unchecked

# ---------------------------------------------------------------------------
# The tripwires
# ---------------------------------------------------------------------------

# Causal assertions in the indicative mood. Echo may say two observations
# conflict, or that nobody has checked something; it may never say X caused Y.
#
# NOTE the negative lookahead on "root cause is/was": the close-out is REQUIRED
# to say "root cause is not established", and without the exemption this fires
# on the one sentence the architecture insists on. The frontend's Tier 1
# tripwire has the identical carve-out; they must stay in sync.
_CAUSAL_INDICATIVE = [
    re.compile(r"\bthat points to\b", re.I),
    re.compile(r"\broot cause (is|was)(?!\s+not\b)", re.I),
    # All four copulas. The first version of this list had only `is`/`was` and a
    # test caught "the timeouts ARE caused by packet loss" sailing through —
    # which is precisely the sentence shape v6 §6.3 forbids.
    re.compile(r"\b(is|was|are|were)\s+caused by\b", re.I),
    re.compile(r"\b(is|are)\s+causing\b", re.I),
    re.compile(r"\bdue to\b", re.I),
    re.compile(r"\bbecause of\b", re.I),
    re.compile(r"\brather than a\b", re.I),
    re.compile(r"\bthis (means|proves|confirms|indicates) that\b", re.I),
    re.compile(r"\bthe problem is\b", re.I),
    re.compile(r"\bthe issue is\b", re.I),
]

# A finding must name who established it. These are the forms our composers
# produce plus the vocabulary a human source is referred to by.
_ATTRIBUTION = re.compile(
    r"\b(DevOps|Support|DBA|Database Admin|reported by|measured by|"
    r"returned by|observed by|according to|the .{0,20}query returned)\b",
    re.I,
)

# Turns that carry no claim need no attribution — an acknowledgement is not a
# finding. Kept deliberately narrow so it cannot become a loophole.
_NO_CLAIM = re.compile(r"^(filed as|pausing for|nobody has|no one has|i have prepared)", re.I)


class EpistemicViolation(ValueError):
    """
    Raised when a composed sentence breaks §6.

    This is deliberately fatal rather than a warning. The problem statement's
    final clause is the grading rubric; emitting a diagnosing sentence is a
    correctness defect, not a style slip.
    """


def validate(text: str) -> str:
    """
    Gate every sentence before it can be spoken. Returns the text unchanged so
    it can be used inline: `return validate(sentence)`.
    """
    for pattern in _CAUSAL_INDICATIVE:
        if pattern.search(text):
            raise EpistemicViolation(
                f"Rule 2 violation — causal assertion {pattern.pattern!r} in: {text!r}"
            )

    if not _NO_CLAIM.match(text.strip()) and not _ATTRIBUTION.search(text):
        raise EpistemicViolation(
            f"Rule 1 violation — no attributed source in: {text!r}"
        )

    return text


# ---------------------------------------------------------------------------
# Composers
# ---------------------------------------------------------------------------

def _short_role(role: str) -> str:
    """'DevOps Lead' -> 'DevOps'. Spoken attribution should be brief."""
    return {
        "DevOps Lead": "DevOps",
        "Support Engineer": "Support",
        "Database Admin": "the DBA",
    }.get(role, role)


def _sentence_case(text: str) -> str:
    """
    Uppercase the first character and leave the rest alone.

    NOT `str.capitalize()`, which lowercases everything after the first letter
    and turns "DevOps" into "Devops" — mangling the very attribution Rule 1
    exists to preserve. A test caught this; keep it caught.
    """
    return text[:1].upper() + text[1:] if text else text


def _attribute(claim: Claim) -> str:
    """One attributed observation, with its source. Rule 1 in its smallest form."""
    if claim.epistemic_status == "TOOL_RESULT":
        return f"a query returned {claim.text.rstrip('.')}"
    return f"{_short_role(claim.speaker_role)} reported {claim.text.rstrip('.')}"


def contradiction_intervention(
    claim_a: Claim,
    claim_b: Claim,
    *,
    relation: str,
    gap: Unchecked | None = None,
) -> str:
    """
    W3's utterance — the headline moment.

    Note what it does NOT do: propose a cause, or pick a winner. It states both
    observations with their sources, says what the adjudicator found about
    their relationship, names the unchecked gap, and hands ownership back to
    the room as a question.
    """
    parts = [
        f"Two observations on the same system. {_sentence_case(_attribute(claim_a))}.",
        f"{_sentence_case(_attribute(claim_b))}.",
    ]

    if relation == "OPPOSED":
        parts.append("Those two cannot both be true. Which one is being measured?")
    else:
        # The INDEPENDENT case is the more interesting one: people arguing past
        # each other with different evidence (§7.1 design note).
        parts.append("Those are different properties, so both can be true.")

    if gap is not None:
        # Phrased as a colon rather than "nobody has checked <description>",
        # because extraction writes descriptions as complete sentences and the
        # naive splice produced "Nobody has checked the network path ... is
        # unverified."
        parts.append(
            f"One thing nobody has established: {_sentence_case(gap.description.rstrip('.'))}. "
            "Who owns that?"
        )

    return validate(" ".join(parts))


def tension_intervention(established: list[Claim], gap: Unchecked | None) -> str:
    """
    W6's utterance — a re-grounding in the record, not a reprimand (§8.3).

    Restating attributed facts and naming the unowned gap is the intervention.
    It works because it is what a good human incident commander does.
    """
    if not established:
        raise ValueError("a tension intervention with nothing established says nothing")

    facts = "; ".join(_attribute(c) for c in established[:3])
    text = f"Pausing for ten seconds. Confirmed so far: {facts}."

    if gap is not None:
        owner = gap.suggested_owner or "someone"
        text += f" Open and unowned: {gap.description.rstrip('.')}. {owner}, do you want that?"

    return validate(text)


def close_out(
    established: list[Claim],
    open_hypotheses: list[Claim],
    unchecked: list[Unchecked],
    *,
    minutes: int,
    timeline_count: int,
) -> str:
    """
    W9's close-out — where the whole architecture pays off.

    The mandatory final sentence is "Root cause is not established." The
    tripwire's negative lookahead exists precisely so this line survives
    validation; if that carve-out is ever "simplified" away, this raises.
    """
    facts = "; ".join(_attribute(c) for c in established) or "nothing was established"
    # Spoken aloud, "1 events recorded" is audibly wrong and undercuts an agent
    # whose entire pitch is precision about the record.
    events = f"{timeline_count} event" + ("" if timeline_count == 1 else "s")
    text = f"Open {minutes} minutes, {events} recorded. Established: {facts}. "

    outstanding = [h.text.rstrip(".") for h in open_hypotheses] + [
        u.description.rstrip(".") for u in unchecked
    ]
    if outstanding:
        listed = "; ".join(f"{i}, {item.lower()}" for i, item in enumerate(outstanding, 1))
        noun = "item" if len(outstanding) == 1 else "items"
        text += f"Unresolved, {len(outstanding)} {noun} — {listed}. "

    # The line the entire product exists to be able to say honestly.
    text += "Root cause is not established. "
    text += "I have drafted the post-mortem with every claim, its source and its timestamp attached."

    return validate(text)
