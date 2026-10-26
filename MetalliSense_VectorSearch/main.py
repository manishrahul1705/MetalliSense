"""
MetalliSense — Semantic Search Service (PEC Hacks 4.0 x Actian VectorAI DB)

Runs as a standalone FastAPI service on port 8002. It:
  1. Reads dataset.csv (training data readings) and derives grade specs.
  2. Turns each record into a short natural-language description.
  3. Embeds those descriptions with a local sentence-transformer model.
  4. Stores the embeddings via vector_store.py, which talks to a REAL
     Actian VectorAI DB if the `actian_vectorai` SDK is installed and
     reachable, and transparently falls back to a local in-memory
     numpy cosine-similarity store otherwise — same interface either way,
     so nothing else in this file needs to know which one is active.
  5. Exposes /semantic-search: given a free-text query, embed it the same
     way and return the most semantically similar readings/grades.

Prerequisites on your machine:
  - pip install -r requirements.txt
  - (optional) Actian VectorAI DB running locally via Docker, see README.md.
    Without it, this still works fully via the local fallback store.
"""
import os
import csv
import json
from pathlib import Path
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None

import vector_store

BASE_DIR = Path(__file__).parent
CSV_PATH = os.environ.get("TRAINING_DATA_CSV", str(BASE_DIR / "dataset.csv"))
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
EMBEDDING_DIM = 384  # all-MiniLM-L6-v2 output size

TRAINING_COLLECTION = "metallisense_training_data"
GRADE_COLLECTION = "metallisense_grades"




state = {"model": None, "indexed_count": 0}


def classify_severity(total_composition: float, is_deviated: bool) -> str:
    if not is_deviated:
        return "none"
    diff = abs(100 - total_composition)
    if diff > 5:
        return "severe"
    if diff > 2:
        return "moderate"
    return "mild"


def row_to_text(row: dict) -> str:
    status = "deviated / out of spec" if str(row.get("is_deviated")).strip().lower() == "true" else "within normal spec"
    return (
        f"Grade {row['grade']} reading, {status}. "
        f"Composition: Fe {row['Fe']}%, C {row['C']}%, Si {row['Si']}%, "
        f"Mn {row['Mn']}%, P {row['P']}%, S {row['S']}%, "
        f"total composition {row['total_composition']}%."
    )


def grade_to_text(grade: str, ranges: dict) -> str:
    parts = ", ".join(f"{el} {lo}-{hi}%" for el, (lo, hi) in ranges.items())
    return f"Grade {grade} specification. Composition ranges: {parts}."


def compute_grade_ranges(rows):
    by_grade = {}
    for row in rows:
        by_grade.setdefault(row["grade"], []).append(row)
    ranges_by_grade = {}
    for grade, group in by_grade.items():
        ranges = {}
        for el in ["Fe", "C", "Si", "Mn", "P", "S"]:
            values = [float(r[el]) for r in group]
            ranges[el] = [min(values), max(values)]
        ranges_by_grade[grade] = ranges
    return ranges_by_grade


def load_rows():
    if not os.path.exists(CSV_PATH):
        print(f"⚠️  CSV not found at {CSV_PATH}. Index will be empty.")
        return []
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def build_index():
    """(Re)index dataset.csv + derived grade specs into the vector store."""
    model = state["model"]

    vector_store.ensure_collection(TRAINING_COLLECTION, EMBEDDING_DIM)
    vector_store.ensure_collection(GRADE_COLLECTION, EMBEDDING_DIM)

    rows = load_rows()
    if not rows:
        state["indexed_count"] = 0
        return 0

    max_rows = int(os.environ.get("MAX_TRAINING_ROWS", "5000"))
    sample = rows[:max_rows]
    texts = [row_to_text(r) for r in sample]
    vectors = model.encode(texts, batch_size=64, show_progress_bar=False)

    payloads = [{"text": texts[i], **sample[i]} for i in range(len(sample))]
    ids = list(range(1, len(sample) + 1))
    vector_store.upsert(TRAINING_COLLECTION, ids, [v.tolist() for v in vectors], payloads)

    grade_ranges = compute_grade_ranges(rows)
    grade_names = list(grade_ranges.keys())
    grade_texts = [grade_to_text(g, grade_ranges[g]) for g in grade_names]
    grade_vectors = model.encode(grade_texts, show_progress_bar=False)
    grade_payloads = [
        {"text": grade_texts[i], "grade": grade_names[i],
         "composition_ranges": json.dumps(grade_ranges[grade_names[i]])}
        for i in range(len(grade_names))
    ]
    grade_ids = list(range(1, len(grade_names) + 1))
    vector_store.upsert(GRADE_COLLECTION, grade_ids, [v.tolist() for v in grade_vectors], grade_payloads)

    state["indexed_count"] = len(sample)
    return len(sample)


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Loading embedding model:", EMBEDDING_MODEL)
    if SentenceTransformer is not None:
        state["model"] = SentenceTransformer(EMBEDDING_MODEL)
    else:
        print("[WARN] sentence_transformers not installed -- running in fallback mode")

    print(f"Vector store backend: {vector_store.backend_name()}")

    try:
        count = build_index()
        print(f"✓ Indexed {count} training-data readings + grade specs")
    except Exception as e:
        print(f"⚠️  Could not build index on startup: {e}")

    yield


app = FastAPI(title="MetalliSense Semantic Search", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Scoped internal service authentication middleware
INTERNAL_SERVICE_KEY = os.getenv("METALLISENSE_INTERNAL_SERVICE_KEY", "metallisense-internal-service-secret-key-2026")

@app.middleware("http")
async def verify_internal_service_auth(request: Request, call_next):
    public_paths = {"/", "/health", "/docs", "/redoc", "/openapi.json"}
    if request.url.path in public_paths or request.method == "OPTIONS":
        return await call_next(request)
    
    token = request.headers.get("X-Internal-Service-Key")
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = token or auth_header[7:].strip()
    
    if not token:
        return JSONResponse(
            status_code=401,
            content={
                "status": "fail",
                "code": "UNAUTHORIZED_SERVICE",
                "message": "Direct access rejected: internal service authentication required."
            }
        )
    if token != INTERNAL_SERVICE_KEY:
        return JSONResponse(
            status_code=403,
            content={
                "status": "fail",
                "code": "FORBIDDEN_SERVICE",
                "message": "Invalid internal service token."
            }
        )
    return await call_next(request)


class SearchRequest(BaseModel):
    query: str
    collection: str = "training_data"  # "training_data" | "grades"
    limit: int = 5


@app.get("/health")
def health():
    return {
        "status": "success",
        "backend": vector_store.backend_name(),
        "using_real_vectorai": vector_store.is_using_real_vectorai(),
        "embedding_model": EMBEDDING_MODEL,
        "indexed_records": state["indexed_count"],
    }


@app.post("/reindex")
def reindex():
    if state["model"] is None:
        raise HTTPException(503, "Service not fully initialized")
    try:
        count = build_index()
        return {"status": "success", "indexed_records": count}
    except Exception as e:
        raise HTTPException(500, f"Reindex failed: {e}")


@app.post("/semantic-search")
def semantic_search(req: SearchRequest):
    if state["model"] is None:
        raise HTTPException(503, "Embedding model not initialized")

    collection = TRAINING_COLLECTION if req.collection == "training_data" else GRADE_COLLECTION
    query_vector = state["model"].encode(req.query).tolist()

    try:
        results = vector_store.search(collection, query_vector, limit=req.limit)
    except Exception as e:
        raise HTTPException(500, f"Search failed: {e}")

    return {
        "status": "success",
        "query": req.query,
        "backend": vector_store.backend_name(),
        "results": [{"score": r["score"], **r["payload"]} for r in results],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=os.getenv("HOST", "127.0.0.1"), port=8002, reload=True)
