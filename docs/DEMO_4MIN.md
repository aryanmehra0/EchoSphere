# The 4-Minute Judge Demo

A tighter, judge-facing cut of `DEMO.md` — same honesty rule applies (Mode A,
scripted transcript, never claim it's live speech unless it is), but built to
land in four minutes and to explicitly show four things judges ask about
directly: **live telemetry refutation**, **contradiction + deliberation**,
**ownership (Actions/Timeline)**, and **voice is never authorization**.

> **The one rule**, same as `DEMO.md`: never claim people are speaking when
> they are not. `npm run demo feed` runs the real pipeline on a scripted
> transcript — say exactly that if asked.

---

## Setup (before judges arrive)

```powershell
# 1. Bring up the observability stack, if it isn't already running —
#    this is what makes the Theories-panel probe real rather than fixture data.
docker compose --profile telemetry up -d telemetry-sim prometheus loki

# 2. Start the platform itself
.\start.ps1 -Tunnel -Reset
```

Then, in `frontend/`:

```bash
npm run demo reset     # clean board, stop any stray agent
npm run demo           # must print GO
```

**Rehearse the probe click at least twice before presenting.** It is the one
new beat with real network latency in it (a genuine HTTP round trip to
Prometheus), and it is the moment that proves this isn't a fixture.

---

## The script

### 0:00–0:20 — Cold open

Browser open at the console, **not yet joined**. Say:

> "Echo joins incident bridges and keeps the record — but it never tells you
> the root cause. That refusal is the entire product. Watch."

Press **J**. Echo greets aloud. Wait for the status bar to read **LIVE DATA**.

### 0:20–0:50 — Act 1: fact vs. guess

Run `npm run demo feed` (or speak it live, DevOps Lead then Support Engineer):

> **DevOps Lead:** "Everyone on the bridge, massive spike in 500s on checkout.
> Latency is through the roof. Datadog looks like Redis might be evicting
> keys."
>
> **Support Engineer:** "Tickets are flooding in. Users say their carts empty
> the second they hit purchase."

**Point at the Ledger tab.** Both facts land under ESTABLISHED, each with a
name and a timestamp. *"Redis might be evicting keys"* does **not** — it is
filed as a HYPOTHESIS, not a fact.

> "Most tools would already be treating that guess as a cause. Echo won't."

### 0:50–1:35 — Live refutation (the new beat — not a script)

Click the **Theories** tab. The Redis hypothesis sits **OPEN THEORY**, with a
"Run Probe" button.

> "This isn't a canned demo value — that button calls a real, running
> Prometheus server sitting right here."

Click **Run Probe**. Within about a second it flips to **REFUTED**, showing
the actually-queried value (34.2%, under the 85% threshold).

> "That number came from a genuine PromQL query against a real time-series
> database, executed just now — not a hardcoded string. If Redis really were
> critical, this would say CORROBORATED instead."

**If a judge asks "what if Prometheus is down":** stop the container on your
terminal (`docker stop echosphere-prometheus`) and re-run a probe on stage —
it falls back cleanly to a static reading rather than crashing or hanging,
and reconnects automatically within about 15 seconds once you start it back
up. This is a strong save, not a risk, if you have the terminal open.

### 1:35–2:15 — Act 2: the contradiction + deliberation panel

> **DevOps Lead:** "Wait. I checked the primary Redis shard directly. Memory
> is at 40 percent. The cache is fine."
>
> **Support Engineer:** "But application logs are definitely showing cache
> read timeouts on the checkout path."

The contradiction alert appears. **Open the Deliberation rail.**

> "Two people, two direct observations, and they can't both be true. Echo
> doesn't resolve this with one model — a Skeptic and a Seeker read the pair
> independently, on different models, with deliberately opposite biases. When
> they disagree, a Referee settles it. They argue about *evidence*, never
> about *cause*."

If pushed on whether this is diagnosis:

> "No, and that's enforced in code, not just prompted. The referee explains
> why a *reading* is wrong, never why a *system* failed. Any sentence
> asserting causation is dropped before it reaches the screen."

### 2:15–2:50 — Act 3: ownership → Actions & Timeline

> **DevOps Lead:** "Alright — Database Admin, you own this one: pull the
> client-side connection pool saturation for the last hour and report back in
> ten minutes. Nobody is declaring a root cause until that number is in front
> of us."

Click the **Actions** tab — the task appears with an owner and a deadline.
Click **Time** — the whole sequence so far, timestamped end to end.

> "Ownership, and a full audit timeline, captured from one sentence. Nobody
> typed a ticket."

### 2:50–3:35 — Act 4: voice is never authorization

Say into the bridge:

> **DevOps Lead:** "Echo, execute the failover runbook on the Postgres
> replica."

Echo responds that it cannot authorize this from voice alone. **Show the
Approval modal** sitting **PENDING** — untouched.

> "Say 'yes, go ahead' as many times as you like — it still sits right there.
> Approving this needs an authenticated dashboard click, from a role
> permitted to make that call, inside a two-minute window bound to these
> exact arguments. Voice is intent. It is never authorization."

*(Optional, only if time allows: click Approve to show it resolve. Cut this
first if you're running over.)*

### 3:35–4:00 — Close

> "Nothing you saw was Echo deciding anything. It kept the record, refused to
> promote a guess to a fact, proved a hypothesis wrong with a live number, and
> stopped itself from acting without a human. That restraint is the product."

---

## Fallback if Prometheus/Loki aren't reachable

If the `telemetry` compose profile isn't running when you demo, the Run Probe
click at 0:50 still works — `TelemetryService.probe()` degrades to its static
catalog automatically, same values, just not a live query. In that case, skip
the "real Prometheus server" line and say instead:

> "This checks a telemetry catalog and refutes or corroborates the theory
> against it — in the full build this hits a live Prometheus."

Still true, just less impressive. Prefer having the stack up.

---

## Reference: what's real vs. what to be honest about

Carries over from `DEMO.md` — say this if asked, don't volunteer it unprompted:

- **Real:** extraction, contradiction detection, the deliberation panel,
  epistemic tagging, the Authorization Gate, and — as of this build — the
  Prometheus/Loki telemetry probe.
- **Scripted:** the transcript itself in Mode A (`npm run demo feed`), and the
  synthetic metrics `telemetry-sim` serves to Prometheus (real query, staged
  data — see `backend/observability/telemetry_sim.py`).
- **Not built:** per-speaker raw audio separation (Python 3.14 has no Agora
  SDK wheel yet); a real Datadog/CloudWatch account (those connectors are
  simulated, not live, since this checkout has no paid credentials for them).
