"""
EchoSphere Backend — Domain-Driven Design & Clean Hexagonal Architecture.

Layers:
- `domain`: Pure enterprise models, aggregates (Ledger), and policies.
- `application`: Use cases, ports, services, and pipes-and-filters pipeline.
- `infrastructure`: External adapters (PostgreSQL store, WebSocket deltas, Agora bridge, config).
- `web`: Presentation layer (FastAPI routers, middleware, deps).
"""

from __future__ import annotations

import sys

# 1. Import new canonical layers
from . import application, domain, infrastructure, web
from .domain import ledger, models
from .domain.policies import (
    authorization,
    contradiction,
    degradation,
    privacy,
    proxy,
    reconciliation,
    redaction,
    utterance,
)
from .infrastructure import (
    agora_agent,
    agora_bridge,
    config,
    deltas,
    gemma,
    store,
)
from .application import pipeline, ports, services
from .application.services import budget, extraction, panel, session, speech
from .web import deps, middleware, routers

# 2. Register transparent compatibility aliases in sys.modules
# This guarantees that existing imports (e.g. `from app.models import Claim`,
# `from app.extraction import extract`, `from app.config import ...`) continue
# to resolve seamlessly with 0 breakages across all tests and external harnesses.
_ALIASES = {
    # Legacy root modules
    "app.models": models,
    "app.ledger": ledger,
    "app.authorization": authorization,
    "app.privacy": privacy,
    "app.proxy": proxy,
    "app.redaction": redaction,
    "app.utterance": utterance,
    "app.contradiction": contradiction,
    "app.degradation": degradation,
    "app.reconciliation": reconciliation,
    "app.extraction": extraction,
    "app.panel": panel,
    "app.store": store,
    "app.deltas": deltas,
    "app.config": config,
    "app.deps": deps,
    "app.middleware": middleware,

    # Legacy adapters -> infrastructure
    "app.adapters": infrastructure,
    "app.adapters.agora_agent": agora_agent,
    "app.adapters.agora_bridge": agora_bridge,
    "app.adapters.config": config,
    "app.adapters.deltas": deltas,
    "app.adapters.gemma": gemma,
    "app.adapters.store": store,

    # Legacy services -> application.services
    "app.services": services,
    "app.services.budget": budget,
    "app.services.extraction": extraction,
    "app.services.panel": panel,
    "app.services.pipeline": services.pipeline,
    "app.services.session": session,
    "app.services.speech": speech,

    # Legacy pipeline -> application.pipeline
    "app.pipeline": pipeline,
    "app.pipeline.context": pipeline.context,
    "app.pipeline.runner": pipeline.runner,
    "app.pipeline.steps": pipeline.steps,
    "app.pipeline.steps.deliberate": pipeline.steps.deliberate,
    "app.pipeline.steps.drain": pipeline.steps.drain,
    "app.pipeline.steps.extract": pipeline.steps.extract,
    "app.pipeline.steps.ingest": pipeline.steps.ingest,
    "app.pipeline.steps.publish": pipeline.steps.publish,

    # Legacy ports -> application.ports
    "app.ports": ports,
    "app.ports.inbound": ports.inbound,
    "app.ports.outbound": ports.outbound,

    # Legacy routers -> web.routers
    "app.routers": routers,
    "app.routers.agent": routers.agent,
    "app.routers.approval": routers.approval,
    "app.routers.bridge": routers.bridge,
    "app.routers.deltas": routers.deltas,
    "app.routers.ingest": routers.ingest,
    "app.routers.ops": routers.ops,
    "app.routers.tools": routers.tools,

    # Legacy core -> domain
    "app.core": domain,
    "app.core.models": models,
    "app.core.ledger": ledger,
    "app.core.policies": domain.policies,
    "app.core.policies.authorization": authorization,
    "app.core.policies.contradiction": contradiction,
    "app.core.policies.degradation": degradation,
    "app.core.policies.privacy": privacy,
    "app.core.policies.proxy": proxy,
    "app.core.policies.reconciliation": reconciliation,
    "app.core.policies.redaction": redaction,
    "app.core.policies.utterance": utterance,
}

for name, mod in _ALIASES.items():
    sys.modules[name] = mod

__all__ = [
    "application",
    "domain",
    "infrastructure",
    "web",
]

