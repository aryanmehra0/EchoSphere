"""
Consent and retention — §10.5.

── WHY THIS EXISTS ─────────────────────────────────────────────────────────
Reviewed at the mentorship round on Aug 31. The question was, roughly: this
thing listens to everything on a bridge and builds a permanent record of it —
what happens when two people say something to each other that was never meant
for the record?

The honest answer at the time was that §10.4 already redacts PII before the
LLM and before embedding, and that the Ledger stores structured CLAIMS rather
than the conversation. Both true, and both beside the point. Redaction decides
what a vendor sees. It does not give the people ON the bridge any say in
whether they are being minuted at all.

There was no way to turn Echo off. That is what this module is.

── THE THREE RULES ─────────────────────────────────────────────────────────
1. SPEECH IS THE CONTROL. Nobody on a Sev-1 bridge is going to alt-tab to a
   dashboard to pause recording. It has to be sayable, mid-sentence, by
   whoever needs it — so it is a spoken phrase, checked before anything else
   in the pipeline.

2. SUSPENDED MEANS NOTHING IS KEPT — not the text, not a redacted version,
   not a log line containing it. This module counts suspended turns and
   nothing else. A count is what makes the pause auditable ("14 turns were
   off the record") without making it a leak. Anything richer would recreate
   the exact problem it exists to solve.

3. THE ROOM MUST SEE IT. A recording state nobody can see is worse than no
   control at all, because people will believe whichever state they assumed.
   So the state goes out as a delta and the console shows a banner. The one
   thing worse than recording someone who did not expect it is convincing
   them you stopped when you did not.

── WHAT THIS IS NOT ────────────────────────────────────────────────────────
Not access control, and not a legal compliance feature. Anyone on the bridge
can pause and resume, and there is no attempt to stop a participant from
turning it back on. The threat model here is an accidental record of a side
conversation, not a hostile participant — matching every other consent
control in this system, where voice signals intent and never authority (§11).
────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("echo.privacy")

# Deliberately explicit phrases rather than intent classification.
#
# An LLM deciding whether someone "meant" to go off the record is exactly the
# wrong tool: it is slower than speech, it fails open (recording) when the
# model is rate-limited, and a false negative here is unrecoverable — the words
# are already in the Ledger by the time anyone notices. A fixed phrase list is
# dumb, instant, free, and wrong in the safe direction.
_OFF = re.compile(
    r"\b("
    r"off the record"
    r"|stop recording|pause recording|stop the recording"
    r"|echo,? stop listening|echo,? stand by|echo,? pause"
    r")\b",
    re.I,
)

_ON = re.compile(
    r"\b("
    r"back on the record|back on record|on the record again"
    r"|resume recording|start recording|resume the recording"
    r"|echo,? start listening|echo,? resume|echo,? you can listen"
    r")\b",
    re.I,
)


@dataclass
class PrivacyState:
    """
    Whether the Slow Loop is currently minuting the bridge.

    Lives in memory and dies with the process, like the redaction map it sits
    alongside. Recording is the default because an incident bridge that
    silently failed to record itself would be its own kind of failure — but
    the default is stated here in one place rather than assumed everywhere.
    """

    recording: bool = True
    suspended_turns: int = 0
    """How many utterances were dropped. A COUNT, never the content."""

    since: float | None = None
    """When the current pause began, epoch seconds. None while recording."""

    total_suspended_seconds: float = 0.0
    changed_by: str | None = None
    """The role that last flipped the switch — attribution applies here too."""

    def to_wire(self) -> dict[str, Any]:
        return {
            "recording": self.recording,
            "suspendedTurns": self.suspended_turns,
            "since": int(self.since * 1000) if self.since else None,
            "changedBy": self.changed_by,
        }


@dataclass
class Decision:
    """What the pipeline should do with one utterance."""

    action: str
    """`record` | `drop` | `pause` | `resume`"""

    announce: str = ""
    """What Echo should say, if anything. Empty means stay silent."""

    @property
    def keeps_text(self) -> bool:
        return self.action in ("record", "pause", "resume")


class PrivacyGate:
    """
    The first thing an utterance meets, before redaction or extraction.

    Ordering is the whole design. Redaction happens before the LLM; this
    happens before redaction — because a suspended turn must not be processed
    at all, not merely processed more carefully.
    """

    def __init__(self, state: PrivacyState | None = None) -> None:
        self.state = state or PrivacyState()

    def evaluate(self, text: str, role: str, *, now: float | None = None) -> Decision:
        """
        Classify one utterance. Never stores it.

        The control phrase itself IS recorded, in both directions, and that is
        deliberate: "Priya took the bridge off the record at 14:32" is exactly
        the kind of thing an incident review needs, and it contains no part of
        what was then said in private.
        """
        now = time.time() if now is None else now

        # ON is checked first. "Let's go back on the record" contains neither
        # OFF phrase, but checking the resume path first means that if the
        # lists are ever edited into an overlap, the failure lands on
        # RECORDING — visible and correctable — rather than on a silent pause.
        if _ON.search(text):
            if self.state.recording:
                return Decision("record")
            paused_for = now - (self.state.since or now)
            self.state.total_suspended_seconds += paused_for
            self.state.recording = True
            self.state.since = None
            self.state.changed_by = role
            log.info(
                "privacy: recording RESUMED by %s after %.0fs (%d turns dropped)",
                role, paused_for, self.state.suspended_turns,
            )
            return Decision("resume", announce="Recording resumed.")

        if _OFF.search(text):
            if not self.state.recording:
                return Decision("drop")
            self.state.recording = False
            self.state.since = now
            self.state.changed_by = role
            log.info("privacy: recording SUSPENDED by %s", role)
            return Decision(
                "pause",
                announce="Off the record. I will stop minuting until someone says we are back on.",
            )

        if not self.state.recording:
            # The only thing that happens to this text.
            self.state.suspended_turns += 1
            return Decision("drop")

        return Decision("record")

    # -- inventory ----------------------------------------------------------

    def inventory(self, *, claims: int, entities: int, transcripts: int,
                  redactions: int) -> dict[str, Any]:
        """
        Exactly what is being held, in a form a person can read.

        Built because "we redact PII" is an assurance, and an assurance is not
        evidence. This endpoint lets anyone on the bridge see the actual
        counts, where they live, and when they die — which is a far better
        answer to "what are you keeping about me" than a paragraph of prose.
        """
        return {
            "recording": self.state.recording,
            "held": {
                "claims": claims,
                "entities": entities,
                "transcripts": transcripts,
                "rawAudio": 0,
                "rawAudioNote": "Echo never receives or stores audio. Text only.",
            },
            "suspended": {
                "turnsDropped": self.state.suspended_turns,
                "totalSeconds": round(self.state.total_suspended_seconds, 1),
                "note": "Dropped turns are counted, never stored. No text, no redacted copy, no log line.",
            },
            "redaction": {
                "spansReplaced": redactions,
                "note": "PII is replaced with typed placeholders BEFORE the LLM call and BEFORE embedding (§10.4).",
            },
            "retention": {
                "storage": "process memory only",
                "survivesRestart": False,
                "note": "Nothing is written to disk. Ending the process ends the record.",
            },
        }
