# Demonstrating Echo

Three ways to run the demo, ordered by how much can go wrong. Pick one
**before** you start, say which one you are doing, and do not switch mid-demo.

> **The one rule.** Never claim people are speaking when they are not. Mode A
> runs the real analysis pipeline on a scripted transcript — that is a strong,
> honest thing to say. Claiming it is live speech is the only way this demo can
> actually fail you, and a judge who spots it stops believing the rest.

---

## Do you need three people on three accounts?

**No.** Two things people assume here are both wrong.

**There are no accounts.** Agora has no per-person login. Everyone joins the
same *channel* with the same App ID and a short-lived token; what separates
people is the **UID**, and the Roster maps each UID to a role — DevOps Lead,
Support Engineer, Database Admin. Two browsers on one channel are already two
different participants.

**Two people is the maximum the demo needs.** Demo Script v2 has exactly two
speakers, and the contradiction lives between them. A third role exists and
works, but a third person adds a way to fail without adding anything to the
story.

### What you cannot do: two tabs on one laptop

This looks like it should work and it destroys the demo. One laptop has one
microphone, so both tabs hear the same voice, and both would forward the same
sentence under two different roles. Echo would then compare a person to
themselves and attribute their words to someone else — which is precisely the
bug that per-UID separation exists to prevent.

If you go live, it is **two machines, two roles, and headsets on both.** Not
speakers — headsets. Speakers let each laptop's microphone pick up the other
laptop's audio, and you get the same crossed attribution by a slower route.

---

## Mode A — one laptop, no microphone *(recommended for a first demo)*

The full product: real extraction, real deliberation, real contradiction, and
Echo speaking aloud. The only scripted part is the transcript.

Nothing here depends on your accent, your wifi, a second person, or Agora's
speech recognition having a good day.

### Before the mentor joins

From the repository root, in **PowerShell**:

```powershell
.\start.ps1 -Reset
```

That starts both services, waits until each genuinely answers, clears the
board, and runs the pre-flight. It exists because the two-terminal version was
written with `&&`, which Windows PowerShell 5.1 treats as a **parse error** —
the command does not run and does not say why, ninety seconds before a demo.

Doing it by hand instead, two terminals:

```powershell
cd backend
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```
```powershell
cd frontend
npm run dev
```

Then run the pre-flight from `frontend/`. It checks the six things that have
each gone wrong before and none of which announce themselves:

```bash
npm run demo reset     # clean board, stop any agent left from last time
npm run demo           # pre-flight — must print GO
```

### The demo, about two minutes

1. Open `http://localhost:3000`, press **`J`**. Echo is invited into the
   channel automatically. Wait for the status bar to read **LIVE DATA**.
2. Run `npm run demo feed`. Four utterances arrive at conversational pace.
3. Talk over it — the script below.

### Afterwards

Press **`J`** again to leave. That stops the Agora agent. **This matters:** the
Cloud Agent is a separate process that keeps running, and billing, until Agora
times it out. Ten rehearsals without leaving properly leaves ten Echoes in the
channel talking over each other, and the tenth demo looks broken.

---

## Mode B — two machines, real voice

Everything in Mode A, plus real speech and real per-speaker separation. More
convincing, materially more fragile.

**Both machines:** same channel name, **different roles**, headsets on.

| Machine | Role | Speaks |
|---|---|---|
| 1 | DevOps Lead | lines 1 and 3 |
| 2 | Support Engineer | lines 2 and 4 |

Both press `J`. Only one Echo joins — the invite is idempotent per channel, so
the second console reuses the first one's agent rather than summoning a rival.

Then just have the conversation. Speak the lines below in your own words; the
extraction does not need them verbatim.

**If speech recognition drifts,** do not fight it. Say "let me show you the
same thing from the recorded transcript", switch to Mode A, and carry on. A
presenter who moves on smoothly reads as prepared; one who repeats a sentence
four times reads as broken.

---

## Mode C — the fallback that always works

If the Slow Loop is down, the console falls back to a scripted replay on its
own and the status bar says **REHEARSAL** rather than LIVE DATA. That is
deliberate — a replay must never be mistaken for a live incident.

You do not need to do anything to enable this. It is what happens if Python
is not running, and it still tells the whole story.

---

## The script, and what to say over it

### Act 1 — the room floods

> **DevOps Lead:** Everyone on the bridge, massive spike in 500s on checkout.
> Latency is through the roof. Datadog looks like Redis might be evicting keys.
>
> **Support Engineer:** Tickets are flooding in. Users say their carts empty
> the second they hit purchase.

**Point at the right-hand column.** Facts land under ESTABLISHED, each with a
name and a timestamp. But *"Redis might be evicting keys"* goes to **OPEN
QUESTIONS**, not to the facts.

> "That is somebody's guess, and Echo has filed it as a guess. Most tools would
> have promoted it to a cause by now — and everyone would have spent the next
> forty minutes debugging Redis."

This is the strongest thing you have. Do not rush it.

### Act 2 — the contradiction

> **DevOps Lead:** Wait. I checked the primary Redis shard directly. Memory is
> at 40 percent. The cache is fine.
>
> **Support Engineer:** But application logs are definitely showing cache read
> timeouts on the checkout path.

The alert appears. Two claims, side by side, **equal weight**, no winner.

> "Two people, two direct observations, and they cannot both be true. On a real
> bridge this goes unnoticed for twenty minutes because the two of them are
> talking about different properties of the same component."

**Now open the DELIBERATION rail.** This is the part nobody else will have:

> "Echo does not decide this with one model. Two AI analysts read the pair
> independently, on different models, with deliberately opposite biases — one
> tuned to avoid false alarms, one tuned to catch what the room talked past.
> You can see both verdicts and both confidence scores. When they disagree, a
> third settles it and says what the other one missed."

If a judge asks whether that means Echo is diagnosing:

> "No — and that distinction is enforced in code. They argue about *evidence*,
> never about cause. The referee says why a *reading* is wrong, never why a
> *system* failed. Any sentence that asserts causation about the system is
> dropped before it reaches the screen."

### Act 3 — the privacy control *(30 seconds, and it lands)*

Say into the bridge, or run the console control:

> **DevOps Lead:** Hang on, can we go off the record for a moment.

The banner goes red across the top of the screen. Say something disposable.
Then bring it back:

> **DevOps Lead:** Right, we are back on the record.

> "Everything said between those two moments is gone. Not redacted — never
> stored. Echo counts how many turns it dropped so the pause is auditable, and
> keeps nothing else."

If asked to prove it: `curl 127.0.0.1:8000/privacy/inventory`.

---

## Questions you will be asked

**"Is it doing speech-to-text itself?"**
No. Agora does the transcription. What Echo adds is everything after that —
the epistemic separation, the contradiction detection, and the discipline.

**"How do you know which person said what?"**
Every participant joins with their own UID, and the Roster binds UID to role
before the token is minted, so a claim is attributed at the moment it enters
the system rather than guessed at afterwards. Be honest about the caveat: the
architecture pulls one unmixed audio stream per speaker, and that specific
piece is not built — the Python SDK has no wheel for Python 3.14. Attribution
is still per-speaker today; what is missing is the structural guarantee.

**"What if the AI is wrong?"**
Then a human sees that it is, because Echo shows its evidence, its sources, and
its own internal disagreement. It never marks a contradiction resolved itself —
that button is only ever pressed by a person.

**"Can it take actions?"**
Only through the Authorization Gate, and voice alone is never enough. Saying
"yes, do it" out loud does not authorize anything: approval is a nonce-bound
token, valid for two minutes, redeemed by a click from a role permitted to make
that call. Replaying it fails. Try it on stage — say "yes go ahead" and show
the request still sitting there unapproved.

**"What is the hardest problem you solved?"**
The contradiction engine's precision/recall tradeoff. A single adjudicator with
one prompt could not sit at both ends of it — tuned against false alarms it
missed the headline conflict, tuned toward finding conflicts it interrupted the
room over two symptoms of one fault. That is why there is a panel.

---

## Two minutes before you present

```bash
cd frontend
npm run demo reset     # clean board, stop any stray agent
npm run demo           # must print GO before you present
```

`npm run demo` checks all of the following and refuses to say GO otherwise:
console up with credentials · Slow Loop up · **no leftover agent** · board
clean · recording ON · no degradation banner.

- [ ] Browser at `localhost:3000`, **not yet joined**
- [ ] A terminal open and ready to run `npm run demo feed`
- [ ] Volume up — Echo speaks, and a silent demo of a voice product is a waste
- [ ] Any agent from a previous run stopped (`agent` should be `null` in health)
- [ ] Groq budget checked — a full run costs 15–20k tokens of a 200k daily cap

**Do not** run `npm run verify` right before demoing. `next build` fights the
dev server for the port and you will be restarting things with an audience
watching.
