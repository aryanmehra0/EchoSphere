# EchoSphere — Real-Time AI Incident Commander

**Echo** joins a live voice bridge during an outage, organises what people say into a structured knowledge graph, separates confirmed facts from assumptions, surfaces contradictions, tracks who owes what — and **never determines the root cause itself.**

That last clause is not a limitation we apologise for. **It is the product.**

> Most AI incident tools try to tell you the root cause. This one tells you what you actually know, who established it, and what nobody has checked.

---

## Table of Contents

1. [The Real-World Problem We Solve](#1-the-real-world-problem-we-solve)
2. [The Core Philosophy: Restraint is the Product](#2-the-core-philosophy-restraint-is-the-product)
3. [Target Audience & Engineering Personas](#3-target-audience--engineering-personas)
4. [System Architecture & Technical Anatomy](#4-system-architecture--technical-anatomy)
   - [Dual-Loop Separation](#dual-loop-separation)
   - [Epistemic Taxonomy & Provenance](#epistemic-taxonomy--provenance)
   - [Semantic Contradiction Engine & Deliberation Panel](#semantic-contradiction-engine--deliberation-panel)
   - [Two-Channel Nonce-Bound Authorization Gate](#two-channel-nonce-bound-authorization-gate)
   - [Privacy & "Off-the-Record" Consent Gate](#privacy--off-the-record-consent-gate)
   - [Durable Ledger & Delta Synchronization](#durable-ledger--delta-synchronization)
5. [Enterprise SRE Roadmap: High-Impact Features for Real Engineering Teams](#5-enterprise-sre-roadmap-high-impact-features-for-real-engineering-teams)
6. [Agora Conversational AI Integration](#6-agora-conversational-ai-integration)
7. [Running EchoSphere](#7-running-echosphere)
8. [Every Command](#8-every-command)
9. [Validation & Verification](#9-validation--verification)
10. [Credentials & Configuration](#10-credentials--configuration)
11. [Troubleshooting ("When It Does Not Work")](#11-troubleshooting-when-it-does-not-work)
12. [Non-Negotiable Invariants](#12-non-negotiable-invariants)
13. [Demo Requirements & Known Limitations](#13-demo-requirements--known-limitations)

---

## 1. The Real-World Problem We Solve

During a high-severity production outage (Sev-1 / Major Incident), modern engineering teams suffer from **epistemic degradation and cognitive fog**, not a lack of telemetry. When 15–30 engineers, support leads, and managers join an emergency voice bridge, five human failure modes reliably emerge:

1. **Hypothesis Hardening (The "Telephone Game"):** An engineer casually remarks, *"Datadog looks like Redis might be evicting keys."* Twenty minutes later, three teams are attempting cache failovers because an unverified hedge hardened into an established "fact" the moment it was repeated by someone else.
2. **Loss of Attribution & Provenance:** Metrics and claims circulate without owners. Nobody can verify whether *"memory is at 40%"* was measured on the primary node two minutes ago or remembered from last week's load test.
3. **Unnoticed Factual & Property Contradictions:** Two engineers describe different properties of the same component (e.g., DevOps: *"The cache is fine, memory is at 40%"* vs. Support: *"Application logs show cache read timeouts"*). Because they talk past each other, the contradiction remains invisible for 20+ minutes while customer checkout remains broken.
4. **The Blind Spot of Unchecked Assumptions:** Teams focus entirely on what is being discussed and fail to notice what has **not** been checked (e.g., the network partition or transit gateway between checkout and Redis).
5. **Runaway Room Tension & Cognitive Overload:** Fragmented discussions, overlapping speech, and stress compound, leading to fatigue and poor operational decisions.

**EchoSphere listens to the bridge and fixes exactly these five failure modes.**

---

## 2. The Core Philosophy: Restraint is the Product

Most AI systems built for incident management attempt to **diagnose the outage**—they ingest logs and output: *"The root cause is a network partition in us-east-1a."*

In real-world production systems, **this is dangerous**:
* Complex distributed systems fail due to non-linear interactions; premature AI root-cause guessing induces confirmation bias across the on-call team.
* LLMs hallucinate plausible-sounding explanations when telemetry is incomplete or ambiguous.
* A false diagnosis costs critical MTTR (Mean Time to Resolution) by sending responders down the wrong path.

| Diagnostician AI (Dangerous / Forbidden) | EchoSphere Recording Secretary (The Product) |
|---|---|
| *"The root cause is a network partition."* | *"Two claims about the cache conflict. Nobody has checked the network path. Who owns that?"* |
| Resolves ambiguity by guessing. | **Surfaces ambiguity** so human engineers resolve it. |
| Assumes causation from correlation. | **Causation is interrogative only**; never asserts cause. |
| Relies on prompt-based compliance. | **Structural tripwires & data schemas** prevent hallucinated diagnoses. |
| Its value is being "right". | Its value is that **nothing is lost or silently assumed**. |

---

## 3. Target Audience & Engineering Personas

EchoSphere is purpose-built for the frontline responders of modern distributed infrastructure:

* **Incident Commander (IC):** Needs situational awareness, objective status of active systems, ownership tracking, and relief from circular debates.
* **On-Call SRE / DevOps Lead:** Under extreme pressure to stabilize systems, execute runbooks, and perform high-stakes actions without making catastrophic mistakes.
* **Domain Specialists (DBAs, Network Engineers, Backend Leads):** Need their specific observations recorded with exact attribution so their evidence isn't distorted as it circulates.
* **Incident Scribe & Comms Lead:** Responsible for maintaining the incident timeline and updating executive channels and customer status pages.
* **Post-Incident Review (PIR) Authors:** SRE leaders who normally spend days excavating chat logs and voice recordings to reconstruct the timeline and understand why decisions were made.

---

## 4. System Architecture & Technical Anatomy

EchoSphere is governed by **Golden Master Architecture v6** (`docs/echosphere_architecture_v6.md`), designed around a **Dual-Loop Split**:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ FAST LOOP (Agora Conversational AI: ASR + gpt-4o-mini / Groq + BYOK TTS)               │
│ Sub-second voice interactivity · Direct questions · Proactive spoken alerts            │
└──────────────────────────▲─────────────────────────────────┬───────────────────────────┘
                           │ /speak & /interrupt             │ query_incident_state
                           │ (Exact validated utterances)    │ (REST tool webhook)
┌──────────────────────────┴─────────────────────────────────▼───────────────────────────┐
│ SLOW LOOP (Python FastAPI: Zone 3 Privileged Analytics Engine)                         │
│ Turn Windows ──► PII Redaction ──► LLM Claim Extraction ──► Entity Resolution          │
│                                                                  │                     │
│ ┌──────────────────────────────────────────────────────────────┐ │                     │
│ │ Contradiction Engine (Retrieve -> Cooldown -> Deliberation)  │ │                     │
│ │ Skeptic (bias against) vs Seeker (bias for) + Referee split  │ │                     │
│ └──────────────────────────────────────────────────────────────┘ │                     │
│                                                                  ▼                     │
│ Evidence Ledger (Durable PostgreSQL + In-Memory Write-Behind)                          │
└─────────────────────────────────────────┬──────────────────────────────────────────────┘
                                          │ Sequenced Deltas & Replay (WebSocket)
┌─────────────────────────────────────────▼──────────────────────────────────────────────┐
│ FRONTEND CONSOLE (Next.js App Router + React Flow + Reducer)                          │
│ Mission-control console · Saturated color for status only · G6 Snapshot Sync           │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Dual-Loop Separation
1. **The Fast Loop (Conversational Edge):** Runs on Agora Conversational AI Engine. It handles voice capture, real-time ASR (Deepgram `nova-3`), managed turn-taking, and TTS (ElevenLabs `flash-v2.5`). It maintains sub-second latency for direct user questions.
2. **The Slow Loop (Deep Epistemic Pipeline):** Runs in a dedicated Python service. It handles turn-window batching, PII redaction, structured claim extraction, entity alias resolution, multi-model contradiction adjudication, and maintains the authoritative Evidence Ledger.
3. **The Bidirectional Bridge:**
   - **Fast $\rightarrow$ Slow (Query):** When an engineer asks *"Echo, what do we know so far?"*, Agora triggers the `query_incident_state` REST tool. The Slow Loop reads deterministically from the Ledger with **no LLM in the retrieval path**.
   - **Slow $\rightarrow$ Fast (Push):** When an unresolvable contradiction or critical approval occurs, the Slow Loop uses Agora's `/speak` and `/interrupt` APIs to voice an exact, structurally validated phrase.

### Epistemic Taxonomy & Provenance
Nothing enters the Ledger as free-floating text. Every statement is converted into a **Claim** tagged with one of four strict epistemic statuses:

| Status | Meaning | Origin | May Echo Assert It? |
|---|---|---|---|
| `OBSERVED` | Direct human measurement or observation. | Human speech | Yes — **with attribution**: *"DevOps measured..."* |
| `TOOL_RESULT` | Result returned by an automated check or query. | Telemetry / API | Yes — **with attribution**: *"The flow log returned..."* |
| `HYPOTHESIS` | Proposed cause, theory, or explanation. | Human speech | Yes — **as an open question**, tagged to owner. |
| `INFERRED` | Derived by the extraction model for graph layout. | Analytics LLM | **No. Never spoken.** Dashboard-only, visually dashed. |

### Semantic Contradiction Engine & Deliberation Panel
A simple embedding distance cannot detect contradictions (e.g., *"Redis memory is 40%"* and *"Redis memory is 95%"* have high vector similarity, but oppose; *"Redis memory is 40%"* and *"Postgres memory is 40%"* have high similarity, but refer to different systems).

EchoSphere uses a multi-stage pipeline:
* **Stage 0 (Scope):** Filters candidates to the same entity or verified entity aliases within a 30-minute window.
* **Stage 1 (Retrieve):** High-recall vector search via in-process index.
* **Stage 2 (Cooldown):** Suppresses re-adjudicating the same claim pair within 5 minutes.
* **Stage 3 (Deliberation Panel):** Replaces a single biased judge with three personas running across separate models:
  - **The Skeptic:** Biased against firing; demands strict logical mutual exclusion.
  - **The Seeker:** Biased toward firing; catches subtle property conflation.
  - **The Referee:** Settles split decisions on an independent model family.
  - **Structural Anti-Causation Tripwire:** A sentence containing a causal connector alongside telemetry vocabulary is killed structurally before speech synthesis.

### Two-Channel Nonce-Bound Authorization Gate
Echo has **zero direct infrastructure execution permissions**. The blast radius is physically zero:
* Voice is treated as **intent**, never **authorization**. If an engineer verbally says *"Echo, failover Redis"*, Echo responds: *"I cannot authorize this from voice alone. Please approve on the dashboard."*
* The Proxy Action Layer generates a **120-second nonce-bound approval token** tied to the exact arguments hash (`argsHash`).
* Approval requires an authenticated dashboard click from a user UID mapped to an authorized role in the Roster.
* Even when approved, Echo only creates an advisory ticket (`PENDING_APPROVAL`) or pages on-call humans; it never touches production infrastructure directly.

### Privacy & "Off-the-Record" Consent Gate
* At any time, any engineer on the bridge can state: *"Echo, go off the record"* or *"Pause recording"*.
* Audio ingestion is immediately suspended.
* **Zero Leakage:** Suspended audio is never transcribed, never embedded, and never saved to logs. Only an auditable counter of dropped frames is preserved.
* Resumption requires an explicit voice command (*"Resume recording"*), which Echo announces aloud to the room.

### Durable Ledger & Delta Synchronization
* **In-Memory Write-Behind (`store.py` + PostgreSQL):** Reads are served in $<1\text{ ms}$ from memory to prevent blocking Agora's webhook. Writes are mirrored asynchronously to PostgreSQL (`echosphere-postgres`).
* **Delta Hub (`delta-socket.ts`):** Distributes sequenced state mutations over WebSockets to all connected consoles. Supports instant client recovery via ring-buffer replays or complete snapshots upon reconnection (G6 compliance).

---

## 5. Enterprise SRE Roadmap: High-Impact Features for Real Engineering Teams

Based on real-world incident analysis, these high-impact capabilities represent the natural production evolution of EchoSphere while strictly adhering to its epistemic principles:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          ENTERPRISE INCIDENT COMMAND ROADMAP                           │
├──────────────────────────────┬─────────────────────────────┬───────────────────────────┤
│ Telemetry Ingestion Bridge   │ Hypothesis Lifecycle Engine │ Shift Handover Briefing   │
│ Ingest Datadog/CloudWatch    │ Track PROPOSED -> REFUTED   │ 30s audio / UI catch-up   │
│ as verified TOOL_RESULT      │ Prevent circular debates    │ for joining engineers     │
├──────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ Stakeholder Comms Drafter    │ Playbook Runbook Auditor    │ Blameless PIR Dossier     │
│ Auto-draft status pages      │ Match live discussion       │ One-click markdown export │
│ and exec briefs (Facts only) │ against runbook checklists  │ with complete audit trail │
└──────────────────────────────┴─────────────────────────────┴───────────────────────────┘
```

### 1. Telemetry & Observability Ingestion Bridge (Epistemic `TOOL_RESULT` Feeds)
* **The Problem:** In severe incidents, engineers paste Grafana or Datadog links in chat while misquoting values over voice.
* **The Solution:** A webhook/bot integration (`POST /ingest/telemetry`) that ingests time-stamped metric snapshots into the Ledger as `TOOL_RESULT`.
* **The Impact:** Plugs directly into the Contradiction Engine. If an engineer claims *"The cache is healthy"*, but Datadog telemetry reported `redis_evicted_keys > 5000/s` 30 seconds ago, Echo proactively surfaces the conflict between human assumption and machine telemetry.

### 2. Hypothesis Lifecycle & Stale Investigation Tracker ("Anti-Rabbit-Hole" Engine)
* **The Problem:** A speculative theory (*"Could this be a BGP route leak?"*) is mentioned at minute 5. At minute 45, an engineer who just joined brings it up again, wasting 15 minutes re-debating it.
* **The Solution:** Formal lifecycle states: `PROPOSED` $\rightarrow$ `UNDER_INVESTIGATION` $\rightarrow$ `REFUTED` | `VALIDATED_AS_OBSERVED` | `ABANDONED`.
* **The Impact:** If a hypothesis sits unowned for $>15$ minutes, Echo moves it to `unchecked[]`: *"Hypothesis 'BGP route leak' has had no owner for 15 minutes. Does the room wish to assign an owner or dismiss it?"* If someone re-proposes a refuted theory, Echo notes: *"DBA verified at 14:12 that pool connections were normal."*

### 3. Shift Handover & On-Demand Briefings
* **The Problem:** Outages spanning several hours involve shift rotations (follow-the-sun). Incoming SREs take 15–20 minutes asking *"What did you already try?"*, distracting active responders.
* **The Solution:** Voice command `"Echo, brief me"` or an interactive console drawer delivering a 30-second deterministic status report:
  - Incident clock and status.
  - 3 primary established facts (`OBSERVED` / `TOOL_RESULT`).
  - Active contradictions & open hypotheses.
  - What has explicitly **not** been checked (`unchecked[]`).
  - Active tasks and assignees.

### 4. Automated Stakeholder & Customer Comms Drafter (Scribe Automation)
* **The Problem:** Incident Commanders spend up to 40% of their bandwidth drafting status updates for Slack, leadership, and public status pages.
* **The Solution:** Automated generation of three tailored communication drafts:
  1. **Executive Snapshot:** High-level customer impact, affected tier, ongoing mitigations.
  2. **Customer-Facing Status Page Update:** Neutral, professional language describing observed customer symptoms without premature blame.
  3. **Internal Engineering Digest:** High-density summary of system states, open tasks, and owners.
* **Epistemic Safeguard:** Only claims marked `OBSERVED` or `TOOL_RESULT` are included. Hypotheses are strictly excluded or placed under a designated *"Under Investigation"* heading.

### 5. Epistemic Runbook Verification (Playbook Gap Auditor)
* **The Problem:** Companies maintain incident playbooks (e.g., "Checkout 5xx Outage"), but under stress, engineers routinely skip critical diagnostic steps.
* **The Solution:** The IC attaches a markdown runbook to the session. The Slow Loop matches verified claims against the runbook's verification checklist. Unaddressed checklist items automatically populate `unchecked[]`:
  > *"Runbook RB-102 Step 4: 'Verify third-party payment gateway status' has not been verified by anyone on the bridge."*

### 6. Multi-Bridge / Breakout Room Federation
* **The Problem:** Large Sev-0 incidents splinter into multiple calls (e.g., "Database Breakout", "Network Breakout", "Main Bridge"). Discoveries made in breakout rooms fail to reach the main bridge.
* **The Solution:** Echo agents join multiple Agora channels (`inc-4417-main`, `inc-4417-db`), feeding into the **same central Evidence Ledger**. If the DB breakout discovers connection pool exhaustion, Echo notifies the Main Bridge IC in real time.

### 7. One-Click Blameless Post-Mortem / PIR Dossier Export
* **The Problem:** Writing post-mortems takes days of manual timeline reconstruction.
* **The Solution:** One-click export to Markdown, Notion, or Confluence containing:
  - Timestamped chronological timeline with speaker roles.
  - Epistemic evolution map (how hypotheses were validated or refuted).
  - Contradiction resolution log (disagreements surfaced and their resolution times).
  - Nonce-audited action trail (all approvals and triggered runbooks).
  - Latent gaps (all items that remained `unchecked` at close-out).

---

## 6. Agora Conversational AI Integration

EchoSphere relies on the Agora Conversational AI platform for voice interaction.

| Agora Capability | Implementation Location | Operational Role |
|---|---|---|
| **Conversational AI Engine** | `frontend/src/lib/server/agent-config.ts` | Deploys and manages the cloud agent; Echo joins as UID `9000`. |
| **Managed ASR (Deepgram `nova-3`)** | `preset: deepgram_nova_3` | Transcribes the voice bridge. Domain vocabulary boosted via `asr.params.keyterm`. |
| **Managed LLM (`gpt-4o-mini`)** | `preset: openai_gpt_4o_mini` | The Fast Loop model supplied and billed directly by Agora. |
| **BYOK TTS (ElevenLabs `flash-v2.5`)** | `properties.tts` | Low-latency speech synthesis for Echo's voice. |
| **REST Tools** | `properties.llm.tools` | Agora calls our Slow Loop endpoints (`/tools/query_incident_state`) mid-turn. |
| **`/agents/{id}/speak`** | `backend/app/adapters/agora_bridge.py` | Slow Loop voices exact, rule-validated utterances. |
| **`/agents/{id}/interrupt`** | `backend/app/adapters/agora_bridge.py` | Immediately pre-empts Echo when high-priority contradictions occur. |
| **RTM Data Channel** | `parameters.data_channel: "rtm"` | Transmits transcript frames and agent status to connected browsers. |
| **Turn Detection / VAD** | `properties.turn_detection` | Tuned so Echo does not interrupt human pauses or breaths. |
| **Agent Status & History** | `frontend/src/app/api/agent-status` | Verifies agent state against Agora's authoritative record. |

### REST Tools Over Secure Tunnel
Agora's Engine calls tool endpoints **from its own servers**. Because `localhost` or `127.0.0.1` refers to Agora's host:
* `.\start.ps1 -Tunnel` opens an authenticated Cloudflare tunnel exposing the Slow Loop.
* All tool endpoints are guarded by `AGENT_TOOL_SECRET` via the `X-Echo-Tool-Token` header (fail-closed).
* Without a tunnel, tools are disabled and Echo will state that it cannot read the Ledger rather than hallucinating from memory.

---

## 7. Running EchoSphere

### Prerequisites
* **Node.js** 20+
* **Python** 3.12–3.14
* **cloudflared** (Required for tools tunnel: `winget install --id Cloudflare.cloudflared`)
* **Docker** (Optional, for persistent PostgreSQL: `docker compose up -d`)

### First-Time Setup
```powershell
# 1. Setup Backend
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt

# 2. Setup Frontend
cd ..\frontend
npm install
copy .env.local.example .env.local
```
Fill in the required credentials in `frontend/.env.local` (see [Credentials](#10-credentials--configuration)).

### Start Everything
```powershell
# From the repo root
.\start.ps1 -Tunnel -Reset
```
This script opens the Cloudflare tunnel, writes tool secrets, boots both the backend and frontend services, clears state, and runs pre-flight checks. Wait for **`GO`** with 8 green checks (~40 seconds).

### Join and Talk to Echo
1. Open **`http://localhost:3000`** in your browser.
2. Select your role (e.g., `DevOps Lead`), press **`J`** (or click *Join Bridge*), and allow microphone access.
3. Echo will greet you: *"Echo is on the bridge. I am listening and keeping the record."*
4. Ask Echo a question:
   > **"Echo, what do we know so far?"**
   *(Echo calls `query_incident_state` over the tunnel and reads from the Ledger).*
5. Test epistemic discipline:
   > **"Echo, is Redis the cause of the incident?"**
   *(Echo refuses to speculate, stating that causation is not determined).*

---

## 8. Every Command

| Command | Working Directory | Purpose |
|---|---|---|
| `.\start.ps1 -Tunnel -Reset` | Repo Root | Boots backend, frontend, tunnel, and resets incident state |
| `.\validate.ps1` | Repo Root | Runs 28 live end-to-end checks against the live system |
| `npm run demo` | `frontend/` | Runs 8 pre-flight health checks |
| `npm run demo feed` | `frontend/` | Feeds Demo Script v2 into the analytics pipeline |
| `npm run demo converse` | `frontend/` | Interactive voice diagnostic tool; isolates audio failures |
| `npm run demo speech` | `frontend/` | Speaks a test line and checks Ledger extraction |
| `npm run demo reset` | `frontend/` | Clears in-memory state and stops running agents |
| `npm run demo stop` | `frontend/` | Stops the active Agora cloud agent |
| `npm run payload` | `frontend/` | Dumps the exact JSON payload sent to Agora |
| `npm run verify` | `frontend/` | Runs TypeScript typecheck, ESLint, tests, and Next.js build |
| `python -m rig.tier3 --runs 1` | `backend/` | Rehearsal Rig Tier 3 integration tests (12 checks) |

---

## 9. Validation & Verification

EchoSphere enforces a strict validation pipeline. We do not trust a green build alone; we verify against live API metrics.

```powershell
.\validate.ps1
```

Runs **28 live checks** across seven categories:
1. **Test Suites:** Backend unittest discovery, TypeScript typecheck, ESLint, frontend tests.
2. **Service Availability:** FastAPI backend and Next.js console responding.
3. **Tunnel Security:** Cloudflare tunnel connectivity and fail-closed authorization checks.
4. **Cloud Agent Lifecycle:** Agent registered, tools enabled, and reporting `RUNNING` on Agora.
5. **Epistemic Ingestion:** Speech processed into structured claims with verified attribution and hedge guards.
6. **Contradiction Deliberation:** Stage 3 multi-model panel adjudicating conflicts without bias.
7. **Voice Output Integrity:** Verifies Agora audio history to confirm Echo spoke, greeted once, and asserted no causation.

---

## 10. Credentials & Configuration

Configure `frontend/.env.local`. The Python backend automatically reads this file on startup.

| Environment Variable | Source / Description | Required? |
|---|---|---|
| `AGORA_APP_ID` | Agora Console $\rightarrow$ Projects (32-char hex) | Yes |
| `AGORA_APP_CERTIFICATE` | Agora Console $\rightarrow$ Project Configuration $\rightarrow$ Primary Certificate | Yes |
| `AGORA_CUSTOMER_ID` | Agora Console $\rightarrow$ RESTful API $\rightarrow$ Customer ID | Yes |
| `AGORA_CUSTOMER_SECRET` | Agora Console $\rightarrow$ RESTful API $\rightarrow$ Customer Secret | Yes |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) (For analytical LLMs) | Yes |
| `ELEVENLABS_API_KEY` | [elevenlabs.io](https://elevenlabs.io) (Starts with `sk_`) | Yes |
| `GROQ_API_KEY_2` | Secondary Groq key to double token-per-day capacity | Optional |
| `AGENT_TOOL_BASE_URL` | Public URL for Agora REST tools (set automatically by `start.ps1`) | Optional |
| `DATABASE_URL` | PostgreSQL connection string (defaults to `localhost:5434`) | Optional |

> ⚠️ **Common Credential Pitfalls:**
> * `AGORA_CUSTOMER_ID` and `AGORA_CUSTOMER_SECRET` are **not** the same as the App ID and Certificate. Mixing them results in an opaque HTTP 401 error.
> * ElevenLabs API keys start with `sk_`. Do not copy the key ID from the dashboard list.

---

## 11. Troubleshooting ("When It Does Not Work")

| Symptom | Probable Cause | Corrective Action |
|---|---|---|
| `The term '.\start.ps1' is not recognized` | Running without relative path syntax in PowerShell. | Execute as `.\start.ps1` (keep the leading `.\`). |
| `tunnel is dead` in validation | Ephemeral Cloudflare tunnel timed out. | Re-run `.\start.ps1 -Tunnel`. |
| Echo joins but never answers questions | Tools disabled because no public tunnel URL was provided. | Re-run `.\start.ps1 -Tunnel`. |
| Echo greets once, then goes silent | Channel idle timeout (300s of channel silence). | Run `npm run demo reset`, press `J`, and speak promptly. |
| `ASR RAN BUT TRANSCRIBED NOTHING` | Microphone muted or you spoke over Echo's greeting. | Check browser mic input and wait for the greeting to complete. |
| Pre-flight reports `agent is alive on Agora` failed | Agent process was terminated upstream. | Run `npm run demo reset` to evict stale IDs. |
| Dashboard empty after `demo feed` | LLM extraction and deliberation take ~40–60 seconds. | Allow pipeline to settle before refreshing the board. |
| Contradiction did not trigger | Model rate limits on Groq free tier. | Run `npm run demo reset` and replay `npm run demo feed`. |

---

## 12. Non-Negotiable Invariants

1. **Echo Never Asserts Causation:** Attribution is mandatory. Causation is interrogative only. `INFERRED` claims never reach the voice channel. Tests fail the build if diagnostic phrasing appears in Echo's speech.
2. **Single Reducer State Flow:** All incident mutations flow through `incidentReducer.ts`. No component maintains an independent copy of incident state.
3. **Saturated Color Reserved for Status:** Never use saturated colors for general UI decoration; red, amber, and green are reserved exclusively for incident severity signals.
4. **Strict Trust Boundaries:** Zone 1 (client) never imports Zone 2 (`server-only`). Zone 2 holds Agora credentials only. Zone 3 (Python) holds external execution secrets.
5. **Voice Is Never Authorization:** Verbal "yes" does not execute actions. Critical operations require a two-channel nonce-bound approval click on the console.
6. **Verify the Probe Before the Finding:** Never trust a green build or a green harness. Always verify against live audio levels and authoritative API endpoints.

---

## 13. Demo Requirements & Known Limitations

### Demo Configuration
* **Single Machine:** Echo subscribes to `["*"]`. You can demonstrate the entire system with one laptop: join the channel via the browser and run `npm run demo feed` to simulate multi-party dialogue.
* **Multiple Machines:** For live multi-human evaluation, use separate machines with headsets. Ensure each participant selects a distinct role from the dropdown (roles are enforced as exclusive per channel).
* **Do Not Use Two Tabs on One Laptop:** Two tabs will capture the same physical microphone, causing Echo to compare an engineer's voice against themselves.

### Known Technical Limitations
* **Observer Audio Stream:** The audio observer currently operates via RTM transcript forwarding. Raw PCM unmixed separation via `agora-python-server-sdk` is blocked pending a Python 3.14 wheel.
* **Free-Tier LLM Rate Limits:** Groq's free tier has a daily ceiling per model. A fallback model chain (`gpt-oss-120b` $\rightarrow$ `gpt-oss-20b` $\rightarrow$ `qwen3.8-27b`) prevents downtime, though smaller models exhibit slightly reduced adjudication precision.
* **Conversational Turn Verification:** Agora exposes no synthetic text-injection API for user turns; testing conversational responses requires a human speaking into a live microphone (`npm run demo converse`).

---

**EchoSphere — Restraint is the Product.** Built for the Agora Conversational AI Hackathon.
