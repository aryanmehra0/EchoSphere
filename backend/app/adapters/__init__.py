"""
Everything that talks to somebody else's server.

Grouped so the network boundary is visible in the directory listing rather
than discovered by reading imports. If a module is in here it makes outbound
HTTP; if it is not, it does not.

    agora_agent.py   create / stop the Agora Cloud Agent (the SDK path)
    agora_bridge.py  /agents/{id}/speak and /interrupt — Echo's mouth
    gemma.py         the analysis LLM over any OpenAI-compatible server

The Groq client still lives in `extraction.py` alongside its measured
key/model rotation and 429 backoff policy — moving the transport without the
policy would have split one decision across two files.
"""
