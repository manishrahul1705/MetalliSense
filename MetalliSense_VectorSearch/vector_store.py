"""
Vector store adapter for the PEC Hacks 4.0 x Actian VectorAI DB integration.

This talks to a REAL, locally-running Actian VectorAI DB instance when the
`actian_vectorai` SDK is installed and its server is reachable (this is the
actual hackathon integration point -- get the Community Edition from
https://www.actian.com/databases/vectorai-db/ and run it locally).

If it isn't installed/running, this automatically falls back to a small
in-memory numpy cosine-similarity store with the EXACT SAME interface, so
the rest of the app (and your demo) never breaks. Swapping in the real
VectorAI DB is then just: pip install the SDK + start it locally -- no code
changes needed anywhere else in this project.
"""
import os
import numpy as np

VECTORAI_HOST = os.environ.get("VECTORAI_HOST", "localhost:50051")

_client = None
_use_real_vectorai = False

try:
    from actian_vectorai import VectorAIClient, VectorParams, Distance, PointStruct  # type: ignore

    try:
        _client = VectorAIClient(VECTORAI_HOST)
        # Cheap call to confirm the server is actually reachable, not just
        # that the SDK imported.
        _client.collections.list()
        _use_real_vectorai = True
        print(f"[OK] Connected to real Actian VectorAI DB at {VECTORAI_HOST}")
    except Exception as e:
        print(f"[WARN]  actian_vectorai SDK installed but server unreachable at {VECTORAI_HOST} ({e})")
        print("   Falling back to local in-memory vector store.")
        _client = None
except ImportError:
    print("[INFO]  actian_vectorai SDK not installed -- using local in-memory vector store.")
    print("   To use the real Actian VectorAI DB: pip install the SDK from")
    print("   https://www.actian.com/databases/vectorai-db/ and set VECTORAI_HOST.")


class _LocalFallbackStore:
    """Same interface shape as the real client, backed by plain numpy."""

    def __init__(self):
        self.collections_data = {}  # name -> {"vectors": np.ndarray, "payloads": [...], "ids": [...]}

    def ensure_collection(self, name, dim):
        if name not in self.collections_data:
            self.collections_data[name] = {
                "vectors": np.zeros((0, dim), dtype=np.float32),
                "payloads": [],
                "ids": [],
            }

    def upsert(self, name, ids, vectors, payloads):
        col = self.collections_data[name]
        vecs = np.array(vectors, dtype=np.float32)
        col["vectors"] = np.vstack([col["vectors"], vecs]) if col["vectors"].shape[0] else vecs
        col["payloads"].extend(payloads)
        col["ids"].extend(ids)

    def search(self, name, query_vector, limit=5):
        col = self.collections_data.get(name)
        if not col or col["vectors"].shape[0] == 0:
            return []
        q = np.array(query_vector, dtype=np.float32)
        q_norm = q / (np.linalg.norm(q) + 1e-9)
        v_norms = col["vectors"] / (np.linalg.norm(col["vectors"], axis=1, keepdims=True) + 1e-9)
        scores = v_norms @ q_norm
        top_idx = np.argsort(-scores)[:limit]
        return [
            {"id": col["ids"][i], "score": float(scores[i]), "payload": col["payloads"][i]}
            for i in top_idx
        ]

    def count(self, name):
        col = self.collections_data.get(name)
        return col["vectors"].shape[0] if col else 0


_fallback = _LocalFallbackStore()


def is_using_real_vectorai():
    return _use_real_vectorai


def ensure_collection(name: str, dim: int):
    if _use_real_vectorai:
        try:
            existing = [c.name for c in _client.collections.list()]
            if name not in existing:
                _client.collections.create(name, vectors_config=VectorParams(size=dim, distance=Distance.Cosine))
            return
        except Exception as e:
            print(f"VectorAI DB ensure_collection failed, using fallback: {e}")
    _fallback.ensure_collection(name, dim)


def upsert(name: str, ids: list, vectors: list, payloads: list):
    if _use_real_vectorai:
        try:
            points = [
                PointStruct(id=ids[i], vector=vectors[i], payload=payloads[i])
                for i in range(len(ids))
            ]
            _client.points.upsert(name, points)
            return
        except Exception as e:
            print(f"VectorAI DB upsert failed, using fallback: {e}")
    _fallback.upsert(name, ids, vectors, payloads)


def search(name: str, query_vector: list, limit: int = 5):
    if _use_real_vectorai:
        try:
            results = _client.points.search(name, vector=query_vector, limit=limit)
            return [{"id": r.id, "score": r.score, "payload": r.payload} for r in results]
        except Exception as e:
            print(f"VectorAI DB search failed, using fallback: {e}")
    return _fallback.search(name, query_vector, limit)


def count(name: str):
    if _use_real_vectorai:
        try:
            return _client.collections.get(name).points_count
        except Exception:
            pass
    return _fallback.count(name)


def backend_name():
    return "Actian VectorAI DB (real)" if _use_real_vectorai else "Local in-memory fallback (Actian VectorAI DB not connected)"
