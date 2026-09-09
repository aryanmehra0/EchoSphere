"""
EchoSphere Web / Inbound Presentation Layer.

Contains:
- deps: Dependency injection
- middleware: Security & tunnel middleware
- routers: HTTP and WebSocket endpoints
"""

from . import routers
from .deps import http_client, session, set_http_client, speech
from .middleware import is_local, register

__all__ = [
    "http_client",
    "is_local",
    "register",
    "routers",
    "session",
    "set_http_client",
    "speech",
]

