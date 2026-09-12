"""
Vector Database Adapter (Qdrant) — v6 §7 & §10.4.

Stores a dense vector per claim/postmortem and ranks candidates by cosine
similarity for contradiction detection and cross-incident search.

── WHAT "VECTOR" MEANS HERE, HONESTLY ──────────────────────────────────────
`_lexical_fingerprint` (below) is NOT a trained embedding model — there is
no model, no network call, no learned semantics. It hashes unigrams,
bigrams, and character trigrams into a fixed-dimension vector. That makes
two texts sharing surface tokens ("redis primary memory" / "redis cache read
timeouts", both containing "redis") score as similar, which is genuinely
useful for this product's bounded incident vocabulary — but it is lexical
overlap wearing a cosine-similarity costume, not the semantic generalization
"embedding" usually implies (it will NOT recognize two texts as related if
they describe the same thing in different words). No embedding-model
provider is wired into this project to replace it with the real thing; this
naming exists so nobody reads "embedding" here and extends more trust to it
than it's earned.

Degrades gracefully to an in-memory cosine store if Qdrant is offline (v6 §13).
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
from typing import Any

from app.infrastructure import config

log = logging.getLogger("echo.vector_store")

VECTOR_DIM = 384
COLLECTION_NAME = "echosphere_claims"
HISTORICAL_COLLECTION_NAME = "echosphere_historical"

_client: Any = None
_enabled: bool = False
_last_error: str | None = None

# In-memory fallback store: list of dict(id, channel, text, vector, payload)
_in_memory_vectors: list[dict[str, Any]] = []
_in_memory_historical: list[dict[str, Any]] = []


def _lexical_fingerprint(text: str, dim: int = VECTOR_DIM) -> list[float]:
    """
    A deterministic, dense, L2-normalized hash of `text`'s unigrams,
    bigrams, and character trigrams — NOT a trained embedding (see this
    module's docstring). Two texts sharing surface tokens score as similar;
    two texts that are semantically related but share no vocabulary do not.
    Zero network latency, 100% deterministic, offline safe — a real
    trade-off worth keeping for a bounded incident vocabulary, just not one
    to mistake for actual semantic understanding.
    """
    cleaned = text.lower().strip()
    words = re.findall(r"\b\w+\b", cleaned)
    vec = [0.0] * dim

    if not words:
        return vec

    # Unigram and bigram projections
    tokens: list[str] = list(words)
    for i in range(len(words) - 1):
        tokens.append(f"{words[i]}_{words[i+1]}")
    # Character trigrams for morphological similarity
    for word in words:
        if len(word) >= 3:
            for j in range(len(word) - 2):
                tokens.append(word[j : j + 3])

    for token in tokens:
        # Hash to index and sign
        h = int(hashlib.md5(token.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        sign = 1.0 if ((h >> 8) & 1) else -1.0
        vec[idx] += sign

    # L2 normalize
    norm = math.sqrt(sum(x * x for x in vec))
    if norm > 1e-9:
        vec = [x / norm for x in vec]
    return vec


def _cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return max(-1.0, min(1.0, dot))


def is_enabled() -> bool:
    return _enabled


async def connect() -> bool:
    """
    Connect to Qdrant and ensure the claims collection exists.
    Never raises; falls back to in-memory store if Qdrant is unavailable.
    """
    global _client, _enabled, _last_error
    try:
        from qdrant_client import AsyncQdrantClient
        from qdrant_client.models import Distance, VectorParams
    except ImportError:
        _last_error = "qdrant_client package not installed"
        log.warning("vector_store: qdrant-client not installed; using in-memory vector store")
        _enabled = False
        return False

    url = config.qdrant_url()
    if not url:
        _enabled = False
        return False

    try:
        client = AsyncQdrantClient(url=url, timeout=4.0, check_compatibility=False)
        collections = await client.get_collections()
        existing = {c.name for c in collections.collections}
        if COLLECTION_NAME not in existing:
            await client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
            )
            log.info("vector_store: created Qdrant collection %s", COLLECTION_NAME)
        if HISTORICAL_COLLECTION_NAME not in existing:
            await client.create_collection(
                collection_name=HISTORICAL_COLLECTION_NAME,
                vectors_config=VectorParams(size=VECTOR_DIM, distance=Distance.COSINE),
            )
            log.info("vector_store: created Qdrant collection %s", HISTORICAL_COLLECTION_NAME)
        _client = client
        _enabled = True
        _last_error = None
        log.info("vector_store: connected successfully to Qdrant at %s", url)
        return True
    except Exception as exc:
        _last_error = str(exc)
        _enabled = False
        _client = None
        log.warning("vector_store: Qdrant at %s unavailable (%s); using in-memory vector store", url, exc)
        return False


async def disconnect() -> None:
    global _client, _enabled
    if _client is not None:
        try:
            await _client.close()
        except Exception:
            pass
        _client = None
    _enabled = False


async def upsert_claim(
    channel: str,
    claim_id: str,
    text: str,
    payload: dict[str, Any] | None = None,
) -> bool:
    """
    Embed and upsert a claim into the vector store.
    """
    vector = _lexical_fingerprint(text)
    meta = {
        "channel": channel,
        "claimId": claim_id,
        "text": text,
        **(payload or {}),
    }

    if _enabled and _client is not None:
        try:
            from qdrant_client.models import PointStruct
            # Use deterministic integer point ID from claim_id hash
            point_id = int(hashlib.md5(claim_id.encode("utf-8")).hexdigest()[:15], 16)
            await _client.upsert(
                collection_name=COLLECTION_NAME,
                points=[PointStruct(id=point_id, vector=vector, payload=meta)],
            )
            return True
        except Exception as exc:
            log.warning("vector_store: upsert failed on Qdrant, mirroring to in-memory: %s", exc)

    # In-memory fallback
    for item in _in_memory_vectors:
        if item["id"] == claim_id:
            item["text"] = text
            item["vector"] = vector
            item["payload"] = meta
            return True
    _in_memory_vectors.append({
        "id": claim_id,
        "channel": channel,
        "text": text,
        "vector": vector,
        "payload": meta,
    })
    return True


async def search_similar_claims(
    channel: str,
    query_text: str,
    top_k: int = 5,
    score_threshold: float = 0.50,
) -> list[dict[str, Any]]:
    """
    Find top-k semantically closest claims in the channel.
    Returns list of dict(claimId, score, text, payload).
    """
    query_vec = _lexical_fingerprint(query_text)

    if _enabled and _client is not None:
        try:
            from qdrant_client.models import FieldCondition, Filter, MatchValue
            channel_filter = Filter(
                must=[FieldCondition(key="channel", match=MatchValue(value=channel))]
            )
            res = await _client.query_points(
                collection_name=COLLECTION_NAME,
                query=query_vec,
                query_filter=channel_filter,
                limit=top_k,
                score_threshold=score_threshold,
            )
            results = res.points if hasattr(res, "points") else res
            return [
                {
                    "claimId": r.payload.get("claimId") if r.payload else str(r.id),
                    "score": float(r.score),
                    "text": (r.payload or {}).get("text", ""),
                    "payload": r.payload or {},
                }
                for r in results
            ]
        except Exception as exc:
            log.warning("vector_store: search failed on Qdrant, falling back to in-memory: %s", exc)

    # In-memory fallback
    candidates = [
        item for item in _in_memory_vectors if item.get("channel") == channel
    ]
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in candidates:
        sim = _cosine_similarity(query_vec, item["vector"])
        if sim >= score_threshold:
            scored.append((sim, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {
            "claimId": item["id"],
            "score": sim,
            "text": item["text"],
            "payload": item["payload"],
        }
        for sim, item in scored[:top_k]
    ]


async def index_postmortem(
    archive_id: str,
    channel: str,
    title: str,
    summary: str,
    markdown: str,
    key_claims: list[str] | None = None,
) -> bool:
    """
    Embed and index a postmortem into the historical Qdrant vector collection.
    Cross-incident postmortems remain permanently indexed across resets.
    """
    searchable_text = f"{title}\n{summary}\n" + "\n".join(key_claims or [])
    vector = _lexical_fingerprint(searchable_text)
    meta = {
        "archiveId": archive_id,
        "channel": channel,
        "title": title,
        "summary": summary,
        "markdown": markdown,
        "keyClaims": key_claims or [],
    }

    if _enabled and _client is not None:
        try:
            from qdrant_client.models import PointStruct
            point_id = int(hashlib.md5(archive_id.encode("utf-8")).hexdigest()[:15], 16)
            await _client.upsert(
                collection_name=HISTORICAL_COLLECTION_NAME,
                points=[PointStruct(id=point_id, vector=vector, payload=meta)],
            )
            log.info("vector_store: indexed postmortem %s in Qdrant (%s)", archive_id, HISTORICAL_COLLECTION_NAME)
            return True
        except Exception as exc:
            log.warning("vector_store: postmortem index failed on Qdrant, mirroring in-memory: %s", exc)

    # In-memory fallback
    for item in _in_memory_historical:
        if item["archiveId"] == archive_id:
            item.update(meta)
            item["vector"] = vector
            return True

    _in_memory_historical.append({
        "archiveId": archive_id,
        "vector": vector,
        **meta,
    })
    return True


async def search_historical_postmortems(
    query_text: str,
    top_k: int = 5,
    score_threshold: float = 0.35,
) -> list[dict[str, Any]]:
    """
    Search past incident postmortems using semantic vector similarity.
    Returns list of dict(archiveId, channel, title, summary, markdown, keyClaims, score).
    """
    query_vec = _lexical_fingerprint(query_text)

    if _enabled and _client is not None:
        try:
            res = await _client.query_points(
                collection_name=HISTORICAL_COLLECTION_NAME,
                query=query_vec,
                limit=top_k,
                score_threshold=score_threshold,
            )
            results = res.points if hasattr(res, "points") else res
            return [
                {
                    "archiveId": r.payload.get("archiveId") if r.payload else str(r.id),
                    "channel": (r.payload or {}).get("channel", "unknown"),
                    "title": (r.payload or {}).get("title", ""),
                    "summary": (r.payload or {}).get("summary", ""),
                    "markdown": (r.payload or {}).get("markdown", ""),
                    "keyClaims": (r.payload or {}).get("keyClaims", []),
                    "score": float(r.score),
                }
                for r in results
            ]
        except Exception as exc:
            log.warning("vector_store: historical search failed on Qdrant, using in-memory: %s", exc)

    # In-memory fallback
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in _in_memory_historical:
        sim = _cosine_similarity(query_vec, item["vector"])
        if sim >= score_threshold:
            scored.append((sim, item))

    scored.sort(key=lambda x: x[0], reverse=True)
    return [
        {
            "archiveId": item["archiveId"],
            "channel": item["channel"],
            "title": item["title"],
            "summary": item["summary"],
            "markdown": item["markdown"],
            "keyClaims": item["keyClaims"],
            "score": sim,
        }
        for sim, item in scored[:top_k]
    ]


async def backfill_historical() -> int:
    """
    Push any postmortem that fell back to `_in_memory_historical` (indexed
    while Qdrant was unreachable) into Qdrant now that it's back.

    Without this, `search_historical_postmortems` stops looking at
    `_in_memory_historical` entirely the moment `_client` is set (see its
    Qdrant-first branch above) — a postmortem archived during a brief Qdrant
    outage would be indexed in memory, then become invisible to every search
    the instant Qdrant reconnects, and gone for good on the next process
    restart. Called from `main.py`'s maintenance ticker right after a
    reconnect succeeds.

    Entries that make it into Qdrant are removed from the in-memory list —
    both so a long-running process doesn't keep it growing forever, and so a
    repeat call (the ticker runs this on every tick, not just once) does not
    redundantly re-upsert what already succeeded.
    """
    if not (_enabled and _client is not None) or not _in_memory_historical:
        return 0

    from qdrant_client.models import PointStruct

    backfilled: list[dict[str, Any]] = []
    for item in _in_memory_historical:
        try:
            point_id = int(hashlib.md5(item["archiveId"].encode("utf-8")).hexdigest()[:15], 16)
            await _client.upsert(
                collection_name=HISTORICAL_COLLECTION_NAME,
                points=[PointStruct(
                    id=point_id,
                    vector=item["vector"],
                    payload={
                        "archiveId": item["archiveId"],
                        "channel": item["channel"],
                        "title": item["title"],
                        "summary": item["summary"],
                        "markdown": item["markdown"],
                        "keyClaims": item["keyClaims"],
                    },
                )],
            )
            backfilled.append(item)
        except Exception as exc:
            log.warning("vector_store: backfill of postmortem %s failed: %s", item.get("archiveId"), exc)

    for item in backfilled:
        _in_memory_historical.remove(item)
    if backfilled:
        log.info("vector_store: backfilled %d postmortem(s) into Qdrant", len(backfilled))
    return len(backfilled)


async def purge_channel(channel: str) -> None:
    """
    Purge all vector entries for an incident channel on closeout/reset (v6 §10.4).
    Active session claims in echosphere_claims are cleared; historical postmortems
    in echosphere_historical are preserved for cross-incident postmortem RAG.
    """
    global _in_memory_vectors
    _in_memory_vectors = [i for i in _in_memory_vectors if i.get("channel") != channel]

    if _enabled and _client is not None:
        try:
            from qdrant_client.models import FieldCondition, Filter, MatchValue
            channel_filter = Filter(
                must=[FieldCondition(key="channel", match=MatchValue(value=channel))]
            )
            await _client.delete(
                collection_name=COLLECTION_NAME,
                points_selector=channel_filter,
            )
            log.info("vector_store: purged Qdrant vectors for channel %s", channel)
        except Exception as exc:
            log.warning("vector_store: failed to purge channel %s: %s", channel, exc)


async def status() -> dict[str, Any]:
    return {
        "enabled": _enabled,
        "connected": _client is not None,
        "error": _last_error,
        "collection": COLLECTION_NAME,
        "historicalCollection": HISTORICAL_COLLECTION_NAME,
        "inMemoryCount": len(_in_memory_vectors),
        "inMemoryHistoricalCount": len(_in_memory_historical),
    }
