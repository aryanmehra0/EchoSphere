"""
The HTTP and WebSocket surface — one module per concern.

Handlers here do transport work only: read the body, resolve the current
session, call a service, shape the response. The rule is that a handler holds
no incident logic, because logic in a route handler cannot be tested without
standing up the app — which is exactly how a 178-line pipeline ended up inside
`main.py`.

    ingest.py    /observer/transcript — the adapter seam
    tools.py     /tools/* — what Agora's servers call mid-turn
    agent.py     /agent/* — Cloud Agent lifecycle, driven by Zone 2
    bridge.py    /bridge/* — Echo's proactive voice
    approval.py  /approval/*, /audit — the Authorization Gate
    ops.py       /health, /health/model, /incident/reset, /privacy/*
    deltas.py    /ws/deltas — the dashboard's live feed
"""
