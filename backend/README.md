# EchoSphere — Zone 3: The Privileged Slow Loop

The privileged Python / FastAPI service (v6 §10.1). Holds the analytical LLM keys, runs the epistemic intelligence pipeline, manages the Evidence Ledger, coordinates with Redis Streams & Qdrant Vector DB, and drives Echo's proactive voice interventions.

Next.js (Zone 2) holds Agora token-minting credentials only; Zone 3 holds all analysis keys and proxy tool integrations. That strict boundary makes the Blast Radius guarantee true by construction.

---

## Quick Start

```powershell
# From the repository root:
.\start.ps1 -Tunnel -Reset
```

Or manually:

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt

# Run the Slow Loop (port 8000)
.venv/Scripts/python -m uvicorn app.main:app --port 8000

# Run all 334 unit tests
.venv/Scripts/python -m unittest discover -s tests -t .
```

Verify service health:

```bash
curl http://127.0.0.1:8000/health
```

Expected output: `{"ready": true, "persistence": {"postgres": true, "sqlite_wal": true}, "redis": {"connected": true}, "vectorStore": {"connected": true}}`.

---

## Directory Structure & DDD Architecture

```
backend/
├── app/
│   ├── application/
│   │   └── services/          # Orchestration layer (no FastAPI dependencies)
│   │       ├── budget.py      # LLM token budget tracking & multi-key rotation
│   │       ├── extraction.py  # Turn-windowed LLM extraction & PII redaction
│   │       ├── pipeline.py    # Ingestion pipeline: window -> extract -> ledger -> deltas
│   │       ├── session.py     # IncidentSession registry (channel-isolated state)
│   │       └── speech.py      # SpeechCoordinator (enforces cooldown & interruption rules)
│   │
│   ├── domain/                # Pure business logic & epistemic governance
│   │   ├── models.py          # Value objects & dataclasses (Claim, Entity, Task, etc.)
│   │   ├── ledger.py          # EvidenceLedger aggregate root (merge, dedupe, query)
│   │   ├── policies/          # Policy gates
│   │   │   ├── authorization.py   # Two-channel nonce-bound authorization gate
│   │   │   ├── contradiction.py   # 2-stage contradiction detection (Lexical + Qdrant Cosine)
│   │   │   ├── degradation.py     # Graceful fallback state machine (v6 §13)
│   │   │   ├── panel.py           # 3-agent Deliberation Panel (Skeptic vs Seeker + Referee)
│   │   │   ├── postmortem.py      # Automated Sev-1 postmortem report generator
│   │   │   ├── privacy.py         # "Off-the-record" consent gate (§10.5)
│   │   │   ├── proxy.py           # Proxy Action Layer (safe tool execution)
│   │   │   ├── reconciliation.py  # Canonical entity alias promotion & resolution
│   │   │   ├── redaction.py       # PII & credential scrubbing before storage
│   │   │   └── utterance.py       # Rule 1 Anti-Causal sentence validator (EpistemicViolation)
│   │   └── services/          # Active domain services
│   │       ├── elimination.py     # Hypothesis Elimination Matrix (falsifies theories with telemetry)
│   │       ├── projects.py        # Enterprise multi-tenant project & war room manager
│   │       └── telemetry.py       # Live telemetry synthesis & metric probing
│   │
│   ├── infrastructure/        # Adapters & storage backends
│   │   ├── agora_agent.py     # Agora Conversational AI SDK client & session manager
│   │   ├── agora_bridge.py    # BridgeController (/speak, /interrupt)
│   │   ├── config.py          # Environment configuration & credential inspection
│   │   ├── deltas.py          # DeltaHub (WebSockets, snapshot ring buffer, Redis mirror)
│   │   ├── event_store.py     # SQLite WAL append-only event store
│   │   ├── groq_client.py     # Groq LLM client with automatic key rotation
│   │   ├── redis_bus.py       # Redis 7 client (Streams XADD/XREAD, distributed locks)
│   │   ├── store.py           # Dual-tier persistence (PostgreSQL 16 on 5434 + SQLite WAL)
│   │   └── vector_store.py    # Qdrant Vector DB (384-d semantic embeddings, cosine retrieval)
│   │
│   └── web/                   # Transport layer (FastAPI routes & middleware)
│       ├── deps.py            # Process-scoped dependencies (HTTP client, session lookup)
│       ├── middleware.py      # Tunnel gate (AGENT_TOOL_SECRET / HMAC-SHA256 verification)
│       └── routers/           # HTTP & WebSocket endpoints
│           ├── agent.py       # Agora agent lifecycle endpoints
│           ├── approval.py    # Critical action approval endpoints
│           ├── bridge.py      # Voice bridge utterance trigger (/bridge/say)
│           ├── deltas.py      # /ws/deltas WebSocket streaming
│           ├── ingest.py      # /observer/transcript speech ingestion
│           ├── ops.py         # /health, /incident/reset, /incident/postmortem
│           ├── projects.py    # /projects multi-incident API
│           ├── telemetry.py   # /telemetry/probe live metrics API
│           └── tools.py       # Agora Cloud Agent tool webhooks (/tools/query_incident_state)
│
└── tests/                     # 334 comprehensive unit and integration tests
```

---

## Key Invariants

1. **Rule 1 Enforced in Code:** Echo never diagnoses or asserts causation. `backend/app/domain/policies/utterance.py` regex-inspects every sentence composed for speech. Any causal language raises `EpistemicViolation` before reaching the audio channel.
2. **Deterministic State via Evidence Ledger:** Factual queries from the voice agent never touch an LLM. Agora calls `POST /tools/query_incident_state`, which reads directly from `ledger.query()`.
3. **Fail-Closed Security Gate:** Requests arriving over public tunnels must present `X-Echo-Tool-Token` matching `AGENT_TOOL_SECRET` or valid HMAC-SHA256 signature.
4. **Resilient Dual-Tier Storage:** If PostgreSQL is offline, SQLite WAL mode ensures zero data loss. If Redis or Qdrant are offline, the engine falls back to in-memory queues and deterministic cosine similarity.

