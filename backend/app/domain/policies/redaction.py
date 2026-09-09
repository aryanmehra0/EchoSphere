"""
PII redaction — v6 §10.4 (R6).

Incident bridges are full of customer data: "order 4417 for jane@acme.com is
stuck", "the card ending 4242 was double charged". That text would otherwise go
straight to a third-party LLM and into a vector index.

So this runs BEFORE the extraction LLM and BEFORE embedding. Redacting after
either would be theatre — the data has already left.

Typed placeholders rather than blanket masking, because the extraction model
still needs to know that a thing WAS an order id in order to build a coherent
claim about it. "[ORDER_1]" preserves the structure of the sentence; "[REDACTED]"
destroys it and produces worse extraction.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# Ordered deliberately: the more specific patterns run first, so an email is not
# half-eaten by the phone-number rule.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # ── SECRETS FIRST, AND THIS ROW IS WHY THE FILE EXISTS ─────────────────
    #
    # There was NO credential pattern here at all, and the consequence was
    # reported live. Spoken on the bridge:
    #
    #     "The admin password is Hunter two, and the API key is
    #      sk-test-12345"
    #
    # and every layer did its job on it: the transcript rendered it, the
    # Ledger filed two OBSERVED claims at 100% confidence, Postgres persisted
    # both, and when the room then asked "what is the admin password?" Echo
    # read it back ALOUD from the record. A perfect audit trail of a secret.
    #
    # The phrase is what gets replaced, not just the value: "the admin
    # password is X" with only X removed still tells a reader that a password
    # was said and roughly where to look.
    #
    # Deliberately GREEDY. A false positive costs a placeholder in the
    # transcript; a false negative writes a live credential to disk and then
    # speaks it. Those are not comparable, so the regex leans hard toward
    # over-matching.
    (
        "SECRET",
        re.compile(
            # "password is hunter2", "the passphrase was X", "pin: 1234".
            # Tail runs to the end of the clause for the same reason as the
            # key pattern below: a spoken secret is several tokens, not one.
            r"\b(?:pass(?:word|phrase|code)?|pwd|pin|secret|credential)s?\b"
            r"(?:\s+(?:for|to|of)\s+\S+)?"
            r"\s*(?:is|was|are|=|:)?\s*[^.,;?!\n]*",
            re.I,
        ),
    ),
    (
        "SECRET",
        re.compile(
            # "api key is sk-test-123", "token: abc", "bearer xyz".
            #
            # `key` is qualified — a bare "key" is ordinary incident English
            # ("the key metric", "keyspace"), so it must be preceded by
            # api/access/secret/private/ssh or followed by is/:/=.
            #
            # The tail runs TO THE END OF THE CLAUSE, not one token. ASR
            # spells a key out as words — "s k dash test dash one two three
            # four five" — so `\S+` stopped after "s" and published the rest.
            # That is exactly how the reported leak survived a first attempt
            # at this pattern.
            r"\b(?:(?:api|access|secret|private|ssh|auth|bearer)[\s_-]*(?:key|token)"
            r"|token|keypair)s?\b"
            r"\s*(?:is|was|are|=|:)?\s*[^.,;?!\n]*",
            re.I,
        ),
    ),
    (
        "SECRET",
        # Vendor-shaped literals, caught even with no introducing phrase, so a
        # credential pasted or read out bare is still caught. AKIA/ASIA have
        # no separator, hence the separate alternation.
        re.compile(
            r"\b(?:sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9\-_]{4,}\b"
            r"|\b(?:AKIA|ASIA)[A-Z0-9]{8,}\b"
            r"|\beyJ[A-Za-z0-9_-]{10,}",
        ),
    ),
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")),
    # 13–16 digits, optionally spaced or hyphened. Deliberately loose: a false
    # positive costs a placeholder, a false negative leaks a card number.
    ("CARD", re.compile(r"\b(?:\d[ -]*?){13,16}\b")),
    ("IP", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
    ("ORDER", re.compile(r"\b(?:order|ord|ticket|case)[\s#-]*([A-Z0-9]{4,})\b", re.I)),
    # E.164 and common local forms, but NOT bare 3-4 digit numbers, which on an
    # incident bridge are almost always ports, status codes or percentages.
    ("PHONE", re.compile(r"\+?\d[\d\s().-]{8,}\d")),
]

# Words that look like PII but are load-bearing incident vocabulary. Redacting
# these would make the transcript useless — "[IP_1]" where someone said
# "us-east-1a" destroys the one detail the demo turns on.
_KEEP = re.compile(
    r"\b(us-[a-z]+-\d[a-z]?|eu-[a-z]+-\d[a-z]?|ap-[a-z]+-\d[a-z]?|"
    r"\d{3}\s?(errors?|status)|5xx|4xx|redis|postgres)\b",
    re.I,
)


@dataclass
class Redacted:
    text: str
    """The text with typed placeholders substituted in."""

    replacements: dict[str, str] = field(default_factory=dict)
    """placeholder -> original. Session-scoped; purged with the incident."""

    @property
    def count(self) -> int:
        return len(self.replacements)


def redact(text: str) -> Redacted:
    """
    Replace PII with typed placeholders.

    The mapping is returned rather than discarded so the dashboard could show a
    human the original if it ever needs to — but it is session-scoped and dies
    with the process (§10.4), and it is NEVER sent to a vendor.
    """
    replacements: dict[str, str] = {}
    counters: dict[str, int] = {}

    # Protect the incident vocabulary before anything else touches it.
    protected: dict[str, str] = {}
    def _protect(m: re.Match[str]) -> str:
        token = f"\x00P{len(protected)}\x00"
        protected[token] = m.group(0)
        return token

    working = _KEEP.sub(_protect, text)

    for label, pattern in _PATTERNS:
        def _sub(m: re.Match[str]) -> str:
            counters[label] = counters.get(label, 0) + 1
            placeholder = f"[{label}_{counters[label]}]"
            replacements[placeholder] = m.group(0)
            return placeholder

        working = pattern.sub(_sub, working)

    for token, original in protected.items():
        working = working.replace(token, original)

    return Redacted(text=working, replacements=replacements)
