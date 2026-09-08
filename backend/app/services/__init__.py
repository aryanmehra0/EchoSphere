"""
Orchestration — the layer between the HTTP surface and the domain modules.

Nothing here imports FastAPI. That is the rule that makes this layer testable:
the Rehearsal Rig can drive the pipeline directly, and a unit test can build an
`IncidentSession` without standing up a web app.

    session.py    one incident's live state; the reset seam
    pipeline.py   window -> extract -> Ledger -> deltas -> contradiction
    speech.py     the single path from a composed sentence to audio
    budget.py     whether the analysis model has any quota left
"""
