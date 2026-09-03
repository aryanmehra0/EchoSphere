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
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable

from . import config
from .models import Transcript, now_ms
from .redaction import redact

# How many PII spans have been replaced this session. A COUNT, never the
# values — the whole point of §10.4 is that those never leave this process, so
# the audit surface has to be a number. Read by /privacy/inventory, which
# exists so "we redact PII" can be checked rather than believed.
_redaction_total = 0


def redaction_count() -> int:
    return _redaction_total

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

ENTITY IDS ARE STABLE. The Compacted State lists entities already on the
record. If a claim is about one of them, REUSE ITS EXACT id — do not invent a
second id for a system that already has one, and do not rename it. "Redis",
"the cache" and "the shard" in one incident are usually THE SAME ENTITY, so
give them the same id.

For each entity also emit "aliases": every other word the room uses for that
same thing. If people call the Redis datastore "the cache", "the shard" or
"redis", list all of them. This is how a later sentence that says only "the
cache" is matched back to the right system.

Every claim MUST carry an "entity" id. If a sentence omits the subject
("Memory is at 40 percent"), use the entity the surrounding utterance was
about. A claim with no entity cannot be compared against anything and is
effectively lost.

Every claim MUST carry speakerRole copied from the transcript line it came
from. A claim without a source is unusable downstream.

Return JSON with exactly these keys:
{
  "entities":  [{"id","label","kind","status","detail","metric","aliases"}],
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

    # Message ids already accepted this incident. Bounded by `drain`, which
    # trims it — an incident that ran for hours would otherwise grow this
    # without limit.
    _seen: set[str] = field(default_factory=set)

    def add(self, frame: Transcript) -> bool:
        """
        Returns False when the frame was a duplicate and therefore ignored.

        ── WHY DEDUP LIVES HERE ────────────────────────────────────────────
        The same utterance can reach this window more than once:

          - RTM does not guarantee once-only delivery
          - a browser reconnecting can replay recent messages
          - and until it was fixed, EVERY browser on the channel forwarded
            EVERY speaker's transcript, so a two-machine demo doubled each
            sentence

        The client-side rule (each participant forwards only their own speech)
        is the primary fix. This is the backstop, because a duplicate here is
        not harmless: the window extracts twice, the Ledger gets two claims
        with different ids for one sentence, and the contradiction engine can
        then adjudicate a sentence against ITSELF.
        ────────────────────────────────────────────────────────────────────
        """
        if not frame.is_final:
            # Only final frames enter the window. Partials are for the
            # transcript feed's benefit; extracting from a half-spoken sentence
            # produces claims that are wrong and then have to be superseded.
            return False

        if frame.message_id in self._seen:
            log.info("window: dropped duplicate transcript %s", frame.message_id)
            return False

        if not self.frames:
            self.opened_at = time.monotonic()

        self._seen.add(frame.message_id)
        self.frames.append(frame)
        self.last_final_at = time.monotonic()
        return True

    def requeue(self, frame: Transcript) -> None:
        """
        Put a drained frame back after a failed extraction.

        The frame is appended directly rather than through `add`, because
        `add` would reject it: `drain` does NOT clear `_seen`, so the message
        id is still there from the first time round.

        And it STAYS there. Dropping the id to "let it back in" was the first
        version, and a test caught it immediately — the transport can redeliver
        an utterance, and with the id forgotten that redelivery would sit in
        the window alongside the requeued copy, extracting one sentence twice.
        Requeueing is OUR retry; the dedup set is about the transport's.

        Restores the window's timers too: a requeued frame that kept an old
        `last_final_at` would be considered stale and flushed instantly,
        straight back into the failure it just came from.
        """
        if not self.frames:
            self.opened_at = time.monotonic()
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

        # Keep the dedup set from growing without bound on a long incident.
        # A duplicate arriving thousands of utterances later is not a
        # duplicate in any meaningful sense.
        if len(self._seen) > 2000:
            self._seen.clear()
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
        # ── HEDGE GUARD — the fact/assumption split, enforced in code ──────
        #
        # A live run filed BOTH of these, from one sentence:
        #
        #   "Datadog indicates Redis might be evicting keys"  -> OBSERVED, 100%
        #   "Redis might be evicting keys"                    -> HYPOTHESIS
        #
        # The same guess, recorded simultaneously as a measured fact and as an
        # open question. Naming a tool ("Datadog indicates") was enough to make
        # the model read a hedge as an observation.
        #
        # This is the single worst failure available to this product: the whole
        # claim is that it separates what is known from what is assumed, and a
        # judge reading that dashboard sees it do both at once. So the rule is
        # structural, not a prompt instruction: text that hedges CANNOT be a
        # fact, whatever the model called it and whatever tool it cites.
        if status in ("OBSERVED", "TOOL_RESULT"):
            hedge = _HEDGE.search(str(claim.get("text", "")))
            if hedge:
                log.warning(
                    "extraction: %r hedges (%r) — OBSERVED downgraded to HYPOTHESIS",
                    claim.get("text"), hedge.group(0),
                )
                status = "HYPOTHESIS"
                # A downgraded claim must not keep a fact's confidence. 100%
                # certainty about a guess is a contradiction in terms, and the
                # dashboard prints that number next to the row.
                claim["confidence"] = min(float(claim.get("confidence", 0.8) or 0.8), 0.8)

        claim["epistemicStatus"] = status
        claim.setdefault("confidence", 0.8)
        kept.append(claim)

    out["claims"] = _dedupe_claims(kept)

    return out


# Hedging language. If any of these appear, the speaker is not reporting a
# measurement — they are proposing something, however confidently they say it.
#
# Deliberately does NOT include bare "may" (matches "may be" but also mangles
# nothing else here) beyond the explicit forms below, and does not include
# "appears to be" style phrasing used about measurements ("the graph appears
# flat" is an observation). Kept to words that mark a PROPOSED CAUSE.
_HEDGE = re.compile(
    r"\b("
    r"might(\s+be)?|may\s+be|could\s+be|maybe|perhaps|possibly|probably"
    r"|likely|seems?\s+(to|like)|looks?\s+like|suspect(ing)?|suspicion"
    r"|i\s+think|i\s+reckon|my\s+guess|guessing|presumably"
    r"|indicates?\s+.{0,30}\bmight\b|pretty\s+sure|fairly\s+sure"
    r")\b",
    re.I,
)


def _claim_tokens(text: str) -> set[str]:
    """Content words only, for near-duplicate detection."""
    stop = {
        "the", "a", "an", "is", "are", "was", "were", "at", "on", "in", "of",
        "to", "and", "or", "it", "we", "i", "that", "this", "for", "with",
        "has", "have", "be", "been", "indicates", "shows", "showing", "looks",
    }
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if w not in stop and len(w) > 1}


# How much two claims must overlap to be treated as the same assertion said
# twice. 0.7 was chosen against the live failure: "Datadog indicates Redis
# might be evicting keys" and "Redis might be evicting keys" share every
# content word of the shorter one, while genuinely different claims about one
# entity ("memory is at 40 percent" vs "the cache is fine") share almost none.
_DUPLICATE_OVERLAP = 0.7


def _dedupe_claims(claims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Collapse one assertion the model emitted twice.

    Extraction splits a sentence into claims, and a sentence like "Datadog
    looks like Redis might be evicting keys" can come back as two overlapping
    rows. Left alone they double-count in the Ledger, and — worse, before the
    hedge guard above — could disagree with each other about their own status.

    When two rows from the same speaker say the same thing, the CAUTIOUS status
    wins. A claim recorded once as a fact and once as a guess is a guess.
    """
    kept: list[dict[str, Any]] = []

    for claim in claims:
        tokens = _claim_tokens(str(claim.get("text", "")))
        if not tokens:
            kept.append(claim)
            continue

        merged = False
        for existing in kept:
            if existing.get("speakerRole") != claim.get("speakerRole"):
                continue
            other = _claim_tokens(str(existing.get("text", "")))
            if not other:
                continue
            # Against the SMALLER set: a short claim fully contained in a
            # longer one is the exact shape of this failure.
            overlap = len(tokens & other) / min(len(tokens), len(other))
            if overlap < _DUPLICATE_OVERLAP:
                continue

            # Same assertion twice. Caution wins, and the more informative
            # wording survives so the dashboard keeps the fuller sentence.
            if "HYPOTHESIS" in (existing.get("epistemicStatus"), claim.get("epistemicStatus")):
                existing["epistemicStatus"] = "HYPOTHESIS"
                existing["confidence"] = min(
                    float(existing.get("confidence", 0.8) or 0.8),
                    float(claim.get("confidence", 0.8) or 0.8),
                )
            if len(str(claim.get("text", ""))) > len(str(existing.get("text", ""))):
                existing["text"] = claim["text"]

            log.info(
                "extraction: merged a duplicate claim from %s: %r",
                claim.get("speakerRole"), claim.get("text"),
            )
            merged = True
            break

        if not merged:
            kept.append(claim)

    return kept


# ---------------------------------------------------------------------------
# Entity resolution — do NOT leave this to the model
# ---------------------------------------------------------------------------

def resolve_entities(
    claims: list[dict[str, Any]],
    entities: list[dict[str, Any]],
    known: dict[str, str] | None = None,
    window_text: str | None = None,
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

        # Synonyms the model declared. This is what lets "the cache" resolve to
        # the Redis entity — a gap that dropped entity convergence to 0% and
        # took the headline feature with it, because "cache read timeouts on
        # the checkout path" then matched only "checkout".
        for alias in ent.get("aliases") or []:
            text_alias = str(alias).strip().lower()
            if len(text_alias) > 2:
                alias_to_id.setdefault(text_alias, eid)

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

    def _window_entity(
        window: str | None,
        fresh: dict[str, str],
        prior: dict[str, str],
    ) -> str | None:
        """
        The entity the surrounding utterance was about.

        ── WHY THIS IS THE DIFFERENCE BETWEEN 20% AND WORKING ──────────────
        Tier 2 measured entity convergence at 20%, and the note was the same
        every run: `'40 percent' -> None`.

        The reason is that extraction splits one spoken sentence into several
        claims and only the FIRST carries the subject:

            "I checked the primary Redis shard. Memory is at 40 percent.
             The cache is fine."
          -> "Redis primary shard checked"     (mentions Redis)
          -> "Memory is at 40 percent."        (mentions nothing)
          -> "The cache is fine."              (mentions nothing)

        Matching on claim text alone can never resolve claims 2 and 3, so they
        landed with no entity, were never contradiction candidates, and the
        headline feature fired one run in five.

        A person hearing that sentence has no difficulty: the whole utterance
        is about Redis. This restores that context.

        ONLY when the window names exactly one entity. If someone mentions two
        systems in one breath, guessing which a subject-less fragment belongs
        to would silently mis-attribute a claim — and a wrongly scoped claim is
        the G4 row-4 false positive, which is worse than an unscoped one.
        ────────────────────────────────────────────────────────────────────
        """
        if not window:
            return None

        haystack = window.lower()
        found = {
            table[alias]
            for table in (prior, fresh)
            for alias in table
            if alias and alias in haystack
        }
        return next(iter(found)) if len(found) == 1 else None

    def _text_match(text: str, table: dict[str, str]) -> str | None:
        """
        EARLIEST mention wins, ties broken by the longer alias.

        Not longest-first. A claim naming two systems —
        "cache read timeouts on the checkout path" — is ABOUT the first one;
        the second is context. Longest-first picked "checkout" there and split
        that claim away from the Redis claims it needed to be compared with,
        which Tier 2 surfaced as an entity split on every run of the 4-line
        scenario.
        """
        best: tuple[int, int, str] | None = None
        for alias, entity_id in table.items():
            if not alias:
                continue
            at = text.find(alias)
            if at == -1:
                continue
            # (position asc, alias length desc) — so "redis primary" still
            # beats "redis" when they start at the same place.
            candidate = (at, -len(alias), entity_id)
            if best is None or candidate < best:
                best = candidate
        return best[2] if best else None

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
            # 5. NOTHING in the claim names an entity — fall back to what the
            #    surrounding utterance was about.
            or _window_entity(window_text, alias_to_id, established)
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
        for alias in getattr(ent, "aliases", []) or []:
            text = str(alias).strip().lower()
            if len(text) > 2:
                aliases.setdefault(text, ent.id)
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
        global _redaction_total
        _redaction_total += redacted.count
        log.info("extraction: redacted %d PII spans before the LLM call", redacted.count)

    user = f"TRANSCRIPT WINDOW:\n{redacted.text}"
    if compacted_state:
        user += f"\n\nCOMPACTED STATE:\n{json.dumps(compacted_state, separators=(',', ':'))}"

    llm = call_llm or groq_json

    def _finish(data: Any) -> dict[str, list[dict[str, Any]]]:
        out = validate_extraction(data)
        # The model proposes entities; we do the join. See resolve_entities().
        out["claims"] = resolve_entities(
            out["claims"], out["entities"], aliases, window_text=window_text
        )
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


async def groq_json(
    system: str,
    user: str,
    *,
    max_tokens: int = 4096,
    models: list[str] | None = None,
) -> str:
    """
    Groq chat completions, forced to JSON, with 429 handling.

    ── WHY THE RETRY IS NOT OPTIONAL ───────────────────────────────────────
    Tier 2 hit this on run 5 of 5:

        429 — Limit 8000, Used 6140, Requested 1903.
              Please try again in 322ms.

    The free tier is 8000 tokens per MINUTE, and a busy incident window sends
    the transcript plus the Compacted State on every flush. Without a retry
    that is a dropped window — silently, since the pipeline is designed to
    survive a failed extraction. On stage it would look like Echo simply
    stopped noticing things partway through the demo.

    Groq tells us how long to wait, so we honour it rather than guessing, and
    back off if it comes back a second time.
    ────────────────────────────────────────────────────────────────────────
    """
    from groq import AsyncGroq

    # `models` lets one caller pin its own model while keeping the rest of the
    # chain as fallback. The Deliberation Panel (§7a) uses this to put each
    # persona on a DIFFERENT model — which buys genuine independence between
    # the personas and, because Groq's daily cap is scoped per model, costs
    # nothing extra in quota. Two problems, one parameter.
    models = models or config.analysis_models()
    keys = config.groq_api_keys()

    # Patient on purpose. The free tier is 8000 TOKENS PER MINUTE, and a busy
    # window sends the transcript plus the Compacted State on every flush — so
    # a burst of speech can exhaust the budget and the only correct response is
    # to wait it out. Six attempts with backoff covers roughly a minute, which
    # is the window the limit is measured over.
    last: Exception | None = None

    """
    ── WHY MODEL IS THE OUTER LOOP AND KEY THE INNER ONE ───────────────────
    Groq's daily cap is per KEY and per MODEL, so a second key is a second
    full budget for every model. That gives two possible orderings, and the
    choice is a quality decision rather than a bookkeeping one.

    Model-outer means: exhaust every key on the BEST model before dropping to
    a weaker one. Key-outer would drop to `gpt-oss-20b` while the strong model
    still had a whole untouched budget on key two — and the smaller models are
    measurably worse here. A demo that quietly degrades to a weaker model
    while budget sits unused is the failure this ordering prevents.
    """
    for model in models:
        # Keys exhausted for the DAY on this model. A per-minute limit clears
        # on its own and must not disqualify a key; a daily one cannot.
        spent: set[int] = set()
        delay = 1.0

        for attempt in range(4):
            """
            EVERY KEY IS TRIED BEFORE ANY SLEEP.

            The previous shape looped keys on the outside and slept on the
            inside, so a per-minute 429 waited on the SAME key while the other
            key's separate per-minute budget sat untouched. Groq's TPM limit is
            per key, exactly like the daily one.

            The cost of getting that wrong was not just latency. Sleeping backs
            the pipeline up, the Turn Window keeps accumulating while it waits,
            and windows MERGE — a Tier 3 run showed "extracting a 3-frame
            window" where there should have been three single-frame ones, and
            extraction silently dropped claims from the middle of the batch.
            The gate failed intermittently on a missing measurement, and this
            was why.
            """
            rate_limited_everywhere = True

            for key_index, api_key in enumerate(keys):
                if key_index in spent:
                    continue
                try:
                    client = AsyncGroq(api_key=api_key)
                    return await _groq_call(client, system, user, max_tokens, model)
                except Exception as exc:  # noqa: BLE001 — the SDK raises several shapes
                    message = str(exc)
                    if "429" not in message and "rate_limit" not in message.lower():
                        raise
                    last = exc

                    if "per day" in message.lower() or "TPD" in message:
                        log.error(
                            "groq: %s daily quota exhausted on key %d/%d",
                            model, key_index + 1, len(keys),
                        )
                        spent.add(key_index)
                        continue

                    # Per-minute. Keep this key in play and try the next one
                    # immediately — its budget is independent.
                    rate_limited_everywhere = True

            if len(spent) == len(keys):
                break  # every key is out for the day; the next model may not be

            if not rate_limited_everywhere:
                break

            wait = _retry_after(str(last)) or delay
            log.warning(
                "groq: %s rate limited on all %d key(s) (attempt %d), waiting %.1fs",
                model, len(keys) - len(spent), attempt + 1, wait,
            )
            await asyncio.sleep(wait)
            delay = min(delay * 2, 20.0)

    raise RuntimeError(
        f"every analysis model is rate limited across "
        f"{len(config.groq_api_keys())} key(s): {last}"
    )


def _retry_after(message: str) -> float | None:
    """Groq's error text carries 'try again in 322.4ms' / 'in 1.2s'."""
    import re as _re

    m = _re.search(r"try again in ([\d.]+)(ms|s)", message)
    if not m:
        return None
    value = float(m.group(1))
    seconds = value / 1000 if m.group(2) == "ms" else value
    # A hair of headroom — retrying at the exact boundary just 429s again.
    return seconds + 0.25


async def _groq_call(client: Any, system: str, user: str, max_tokens: int, model: str) -> str:
    resp = await client.chat.completions.create(
        model=model,
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
        max_tokens=max_tokens,
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
