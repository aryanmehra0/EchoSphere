"""
The HTTP and WebSocket surface — one module per concern.

Handlers here do transport work only: read the body, resolve the current
session, call a service, shape the response. The rule is that a handler holds
no incident logic, because logic in a route handler cannot be tested without
standing up the app — which is exactly how a 178-line pipeline ended up inside
`main.py`.
"""

from . import agent, approval, bridge, deltas, ingest, ops, telemetry, tools

__all__ = [
    "agent",
    "approval",
    "bridge",
    "deltas",
    "ingest",
    "ops",
    "telemetry",
    "tools",
]
