"""
The Analytics Pipeline — v6 §4.4 and §14.2.

Transcript frames do not go straight to the extraction LLM. They pass through a
Turn Window that batches on turn boundaries, which keeps the LLM call count
bounded and gives the model coherent units of meaning rather than fragments.

    frames -> Turn Window -> PII redaction -> extraction LLM -> validate -> Ledger

The 1.5 s hold is the difference between the model seeing
"Customer tickets are flooding in, carts empty on purchase" and seeing two
fragments. Coherent units produce coherent extraction, and 1.5 s is invisible to
someone watching a dashboard.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from . import config
from .models import Transcript, now_ms
from .redaction import redact

log = logging.getLogger("echo.extraction")

# §4.4 flush triggers.
SILENCE_FLUSH_SECONDS = 1.5
MAX_WINDOW_SECONDS = 8.0
MAX_WINDOW_CHARS = 1600  # ~400 tokens


# ---------------------------------------------------------------------------
# The prompt — v6 §14.2, verbatim in intent
# ---------------------------------------------------------------------------

EXTRACTION_PROMPT = """You are an extraction engine for a live IT incident bridge. You receive a
window of diarized, role-attributed transcript plus the Compacted State of
the incident so far.

Extract ONLY what the transcript supports. Output valid JSON, no markdown.

EPISTEMIC TAGGING — the most important part of this task.
Tag every claim with exactly one epistemicStatus:
  OBSERVED     a human reported a direct measurement or observation
  TOOL_RESULT  a tool returned this value
  HYPOTHESIS   a human proposed a cause or explanation ("might be", "I think")
  INFERRED     YOU derived this; no human said it

Be aggressive about HYPOTHESIS. "The cache might be evicting keys" is a
HYPOTHESIS, not a fact, even when a senior engineer says it confidently.
Hedges — might, probably, looks like, I bet, seems, could be, must be — all
indicate HYPOTHESIS.

Be conservative about INFERRED. Only use it for links you construct that
nobody stated. INFERRED claims never reach the voice agent.

ALSO EXTRACT "unchecked": things the conversation reveals nobody has
verified. If two people argue about a cache and neither mentions the
network path between the service and that cache, the network path is
unchecked. This field is as valuable as the facts.

NEVER invent entity names. If someone says "the database", emit
"database-unspecified" rather than guessing "postgres-primary".

Every claim MUST carry speakerRole copied from the transcript line it came
from. A claim without a source is unusable downstream.

Return JSON with exactly these keys:
{
  "entities":  [{"id","label","kind","status","detail","metric"}],
  "links":     [{"id","source","target","label","kind"}],
  "claims":    [{"id","text","entity","epistemicStatus","speakerRole","confidence"}],
  "tasks":     [{"id","assigneeRole","description","status","evidence"}],
  "timeline":  [{"id","kind","text","actor"}],
  "unchecked": [{"id","description","suggestedOwner"}]
}

kind for entities: service|datastore|network|gateway|region|client
status for entities: CRITICAL|WARNING|OK|UNKNOWN
kind for links: causal|suspected|depends
status for tasks: OPEN|IN_PROGRESS|BLOCKED|DONE
kind for timeline: signal|decision|action|contradiction|resolution

Emit empty arrays for anything the window does not support. Do not invent."""


# ---------------------------------------------------------------------------
# Turn Window
# ---------------------------------------------------------------------------

@dataclass
class TurnWindow:
    """
    Batches transcript frames until a turn boundary.

    Flushes on the first of:
      - a final frame followed by 1.5 s of silence
      - 8 s elapsed since the window opened
      - 400 tokens of text

    The elapsed and size caps exist so a monologue still produces deltas rather
    than one enormous extraction at the end of it.
    """

    frames: list[Transcript] = field(default_factory=list)
    opened_at: float = 0.0
    last_final_at: float = 0.0

    def add(self, frame: Transcript) -> None:
        if not self.frames:
            self.opened_at = time.monotonic()
        # Only final frames enter the window. Partials are for the transcript
        # feed's benefit; extracting from a half-spoken sentence produces claims
        # that are wrong and then have to be superseded.
        if frame.is_final:
            self.frames.append(frame)
            self.last_final_at = time.monotonic()

    @property
    def chars(self) -> int:
        return sum(len(f.text) for f in self.frames)

    def should_flush(self, *, now: float | None = None) -> bool:
        if not self.frames:
            return False
        t = now if now is not None else time.monotonic()

        if t - self.last_final_at >= SILENCE_FLUSH_SECONDS:
            return True
        if t - self.opened_at >= MAX_WINDOW_SECONDS:
            return True
        if self.chars >= MAX_WINDOW_CHARS:
            return True
        return False

    def drain(self) -> list[Transcript]:
        out = self.frames
        self.frames = []
        self.opened_at = 0.0
        self.last_final_at = 0.0
        return out

    def render(self) -> str:
        """Role-attributed lines, which is what the prompt expects."""
        return "\n".join(f"[{f.role}] {f.text}" for f in self.frames)


# ---------------------------------------------------------------------------
# Schema validation
# ---------------------------------------------------------------------------

_KEYS = ("entities", "links", "claims", "tasks", "timeline", "unchecked")
_VALID_STATUS = {"OBSERVED", "TOOL_RESULT", "HYPOTHESIS", "INFERRED"}


class SchemaError(ValueError):
    pass


def validate_extraction(data: Any) -> dict[str, list[dict[str, Any]]]:
    """
    Coerce the model's output into the shape §9.4 promises.

    Deliberately forgiving about MISSING keys (an empty window legitimately
    yields nothing) and strict about MALFORMED ones. A claim without a
    speakerRole is dropped rather than defaulted, because §6.2 Rule 1 makes an
    unsourced claim unusable — inventing "unknown" would launder that.
    """
    if not isinstance(data, dict):
        raise SchemaError(f"expected an object, got {type(data).__name__}")

    out: dict[str, list[dict[str, Any]]] = {}
    for key in _KEYS:
        value = data.get(key, [])
        if value is None:
            value = []
        if not isinstance(value, list):
            raise SchemaError(f"{key} must be a list, got {type(value).__name__}")
        out[key] = [v for v in value if isinstance(v, dict)]

    kept: list[dict[str, Any]] = []
    for claim in out["claims"]:
        if not str(claim.get("speakerRole", "")).strip():
            log.warning("extraction: dropped an unsourced claim: %r", claim.get("text"))
            continue
        status = str(claim.get("epistemicStatus", "")).upper()
        if status not in _VALID_STATUS:
            # An unrecognised status is treated as the most cautious option
            # rather than discarded — the claim was still said by someone.
            log.warning("extraction: coerced status %r -> HYPOTHESIS", status)
            status = "HYPOTHESIS"
        claim["epistemicStatus"] = status
        claim.setdefault("confidence", 0.8)
        kept.append(claim)
    out["claims"] = kept

    return out


# ---------------------------------------------------------------------------
# Entity resolution — do NOT leave this to the model
# ---------------------------------------------------------------------------

def resolve_entities(
    claims: list[dict[str, Any]],
    entities: list[dict[str, Any]],
    known: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """
    Attach a stable entity id to every claim, in code.

    ── WHY THIS EXISTS ─────────────────────────────────────────────────────
    This was the bug that made the headline feature fire by luck.

    The contradiction engine scopes by `entity` equality (§7 Stage 0). The
    extraction model assigns entity ids inconsistently between windows: one
    pass tagged "cache read timeouts" as `e2` and left "Memory is at 40
    percent" with NO entity at all. Stage 0 then found zero candidates, so the
    one contradiction the whole pitch is built on never fired — silently, with
    every layer reporting success.

    A prompt cannot be relied on for what is really a mechanical join. So the
    model proposes entities, and this function does the matching: claims are
    linked by looking for an entity's id, label, or a word from its label in
    the claim text.

    `known` maps lowercased alias -> canonical id, carried across windows so
    "Redis" in window 3 resolves to the same id it got in window 1. Without
    that, ids drift every flush and scoping breaks again a different way.
    ────────────────────────────────────────────────────────────────────────
    """
    alias_to_id: dict[str, str] = {}

    # This window's proposals go in FIRST...
    for ent in entities:
        eid = str(ent.get("id", "")).strip()
        if not eid:
            continue
        alias_to_id[eid.lower()] = eid
        label = str(ent.get("label", "")).strip()
        if label:
            alias_to_id[label.lower()] = eid
            # Single distinctive words from the label: "Redis Primary" should
            # also match a claim that just says "redis".
            for word in label.split():
                if len(word) > 3:
                    alias_to_id.setdefault(word.lower(), eid)

    # ...and the ALREADY-KNOWN ids overwrite them, because an established id is
    # canonical and a fresh window must not rename it.
    #
    # This ordering was backwards at first, and it cost the headline feature.
    # Window 1 named checkout `e1` and Redis `e2`; window 3 proposed `checkout`
    # and `cache` for the SAME two things. With the window winning, "the cache
    # is fine" resolved to `e2` while "cache read timeouts" resolved to
    # `checkout` — two ids for one system, so Stage 0 found no candidates and
    # the contradiction never fired. Four graph nodes for two real things is
    # the visible symptom; a silent headline feature is the expensive one.
    alias_to_id.update(known or {})

    established = known or {}

    def _text_match(text: str, table: dict[str, str]) -> str | None:
        # Longest alias first, so "redis primary" beats "redis".
        for alias in sorted(table, key=len, reverse=True):
            if alias and alias in text:
                return table[alias]
        return None

    for claim in claims:
        current = str(claim.get("entity", "") or "").strip()
        text = str(claim.get("text", "")).lower()

        # Precedence, strictest first. ESTABLISHED beats FRESH at every step —
        # that is the whole point, and getting it wrong is what split one system
        # across two ids and silently disabled contradiction detection.
        #
        #   1. the model named an id we already know          -> keep it
        #   2. the text names something we already know       -> converge on it
        #   3. the model named an id from THIS window         -> accept it
        #   4. the text names something from this window      -> accept it
        #   5. nothing matched                                -> leave unset
        #
        # Step 2 outranking step 3 is deliberate: a claim tagged with a fresh
        # id like "cache" whose text says "Redis" belongs to the established
        # Redis entity, not to a new node that happens to be named after a
        # synonym.
        resolved = (
            (established.get(current.lower()) if current else None)
            or _text_match(text, established)
            or (alias_to_id.get(current.lower()) if current else None)
            or _text_match(text, alias_to_id)
        )

        if resolved:
            claim["entity"] = resolved
        elif not current:
            # Leave it unset rather than guessing. An unscoped claim is simply
            # never a contradiction candidate, which is the safe failure —
            # guessing would compare claims about different systems.
            claim.pop("entity", None)

    return claims


def entity_aliases(ledger: Any) -> dict[str, str]:
    """Alias table from everything the Ledger already knows, for the next window."""
    aliases: dict[str, str] = {}
    for ent in ledger.entities.values():
        aliases[ent.id.lower()] = ent.id
        if ent.label:
            aliases[ent.label.lower()] = ent.id
            for word in ent.label.split():
                if len(word) > 3:
                    aliases.setdefault(word.lower(), ent.id)
    return aliases


# ---------------------------------------------------------------------------
# The extraction call
# ---------------------------------------------------------------------------

async def extract(
    window_text: str,
    compacted_state: dict[str, Any] | None = None,
    *,
    call_llm: Callable[[str, str], Awaitable[str]] | None = None,
    aliases: dict[str, str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """
    One extraction pass with a single repair retry (§4.4 failure behaviour).

    `call_llm` is injectable so the Rehearsal Rig can drive this deterministically
    without a network call — Tier 2 needs extraction quality measured, not the
    vendor's uptime.

    A second failure drops the window and logs it. That loses one turn of
    extraction; the next window's Compacted State still carries prior context,
    so the system self-heals rather than diverging.
    """
    redacted = redact(window_text)
    if redacted.count:
        log.info("extraction: redacted %d PII spans before the LLM call", redacted.count)

    user = f"TRANSCRIPT WINDOW:\n{redacted.text}"
    if compacted_state:
        user += f"\n\nCOMPACTED STATE:\n{json.dumps(compacted_state, separators=(',', ':'))}"

    llm = call_llm or _groq_json

    def _finish(data: Any) -> dict[str, list[dict[str, Any]]]:
        out = validate_extraction(data)
        # The model proposes entities; we do the join. See resolve_entities().
        out["claims"] = resolve_entities(out["claims"], out["entities"], aliases)
        return out

    raw = await llm(EXTRACTION_PROMPT, user)
    try:
        return _finish(_parse(raw))
    except (SchemaError, json.JSONDecodeError) as first:
        # The message must be captured HERE. Python unbinds an `except ... as`
        # name when the block exits (PEP 3110), so reading `first` below raises
        # UnboundLocalError — masking the real schema failure with a crash.
        first_error = str(first)
        log.warning("extraction: schema failure, retrying with the error appended: %s", first_error)

    repair = (
        f"{user}\n\nYour previous reply was rejected: {first_error}\n"
        "Return ONLY valid JSON matching the schema."
    )
    try:
        raw = await llm(EXTRACTION_PROMPT, repair)
        return _finish(_parse(raw))
    except (SchemaError, json.JSONDecodeError) as second:
        log.error("extraction: dropped a window after two failures: %s", second)
        return {k: [] for k in _KEYS}


def _parse(raw: str) -> Any:
    """
    Tolerate a model that wraps JSON in prose or a fenced block.

    The prompt says "no markdown", but a reasoning model occasionally narrates
    anyway, and dropping a whole window over a stray fence would be a poor
    trade.
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        text = text[start : end + 1]
    return json.loads(text)


async def _groq_json(system: str, user: str) -> str:
    """Groq chat completions, forced to JSON."""
    from groq import AsyncGroq

    client = AsyncGroq(api_key=config.groq_api_key())
    resp = await client.chat.completions.create(
        model=config.analysis_model(),
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        # 0.2, and the reason is measured rather than assumed.
        #
        # Extraction is a transcription task, so temperature 0.0 looks obviously
        # correct — and it tested WORSE: three rehearsals at 0.2 surfaced the
        # contradiction twice, three at 0.0 surfaced it zero times. Groq does
        # not guarantee determinism at 0 anyway (node/batch variation), so 0.0
        # buys no reproducibility; it just locks whichever split the model lands
        # on, and a bad split then repeats.
        #
        # n=3 each, so this is weak evidence and NOT a settled answer. It is
        # recorded here so the next person does not "obviously" set it to 0
        # again. Measuring this properly is Rehearsal Rig Tier 2's job: fixed
        # transcript fixtures, N runs, count how often the pair is detected.
        temperature=0.2,
        max_tokens=4096,
    )
    return resp.choices[0].message.content or "{}"


# ---------------------------------------------------------------------------
# Compaction — v6 §4.4
# ---------------------------------------------------------------------------

def compact(ledger: Any) -> dict[str, Any]:
    """
    What keeps a 45-minute incident inside the context window.

    The pinned categories are exactly those the problem statement's requirements
    depend on: entities, open tasks and unresolved contradictions are sent in
    full, every time. **Compaction can drop colour; it can never drop an
    obligation.**
    """
    facts = ledger.established()
    return {
        "phase": ledger.phase,
        # Pinned — the spine of the graph, and small.
        "entities": [
            {"id": e.id, "label": e.label, "status": e.status} for e in ledger.entities.values()
        ],
        # Pinned — requirement 10 depends on nothing being dropped.
        "openTasks": [
            {"id": t.id, "assigneeRole": t.assignee_role, "description": t.description}
            for t in ledger.open_tasks()
        ],
        # Pinned.
        "unresolvedContradictions": [
            {"id": c.id, "claimA": c.claim_a, "claimB": c.claim_b}
            for c in ledger.open_contradictions()
        ],
        # Most recent 40 only — colour, safe to drop.
        "recentFacts": [
            {"id": c.id, "text": c.text, "speakerRole": c.speaker_role} for c in facts[-40:]
        ],
        "openHypotheses": [
            {"id": c.id, "text": c.text} for c in ledger.open_hypotheses()
        ],
        "unchecked": [{"id": u.id, "description": u.description} for u in ledger.open_unchecked()],
        # Transcripts are NEVER sent. The window carries the live text; history
        # lives in the Ledger.
    }
