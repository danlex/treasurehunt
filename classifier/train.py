"""Train the binary taste classifier.

Ports nanolearn's PrototypeTextMahalanobis (experiments/banking77.py:529)
to a 2-class problem: liked (posts.json) vs disliked (rejected.json).

Streaming Welford mean per class + pooled within-class scatter, plus
shrinkage-regularized covariance inverse. Same algorithm as nanolearn,
same storage model, specialized to n_classes=2.

Output: classifier/model.npz with {zero_point, mu, precision, counts,
feature_dim, encoder_name}. Embeddings cached in embeddings_cache.npz
keyed by item id so retrains on Like/Dislike are incremental.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer
from sklearn.covariance import LedoitWolf

ROOT = Path(__file__).resolve().parent.parent
CLASSIFIER_DIR = Path(__file__).resolve().parent
MODEL_PATH = CLASSIFIER_DIR / "model.npz"
CACHE_PATH = CLASSIFIER_DIR / "embeddings_cache.npz"

POSTS = ROOT / "posts.json"
REJECTED = ROOT / "rejected.json"

ENCODER_NAME = "sentence-transformers/all-MiniLM-L6-v2"


def item_text(item: dict) -> str:
    """Canonical text representation of a queue/post item.

    Keep it stable — the embedding cache is keyed on (id, text_hash)
    implicitly via the id alone, so changing this invalidates cache
    entries only if upstream item content also changed.
    """
    parts = [
        item.get("title", ""),
        item.get("summary", ""),
        item.get("category", ""),
        item.get("source", ""),
        " ".join(item.get("tags", []) or []),
    ]
    return " \u2014 ".join(p for p in parts if p).strip()


def load_cache() -> dict[str, np.ndarray]:
    if not CACHE_PATH.exists():
        return {}
    data = np.load(CACHE_PATH, allow_pickle=True)
    ids = data["ids"]
    vecs = data["vecs"]
    return {str(i): vecs[k] for k, i in enumerate(ids)}


def save_cache(cache: dict[str, np.ndarray]) -> None:
    ids = np.array(list(cache.keys()))
    vecs = np.stack([cache[i] for i in ids]) if ids.size else np.zeros((0, 0))
    np.savez(CACHE_PATH, ids=ids, vecs=vecs)


def encode_items(
    encoder: SentenceTransformer,
    items: list[dict],
    cache: dict[str, np.ndarray],
) -> np.ndarray:
    """Encode items using cache where possible. Returns (n, d) float32."""
    missing_idx = [k for k, it in enumerate(items) if it["id"] not in cache]
    if missing_idx:
        texts = [item_text(items[k]) for k in missing_idx]
        new_vecs = encoder.encode(
            texts,
            convert_to_numpy=True,
            normalize_embeddings=False,
            show_progress_bar=False,
        ).astype(np.float32)
        for k, vec in zip(missing_idx, new_vecs):
            cache[items[k]["id"]] = vec
    return np.stack([cache[it["id"]] for it in items])


def main() -> int:
    t0 = time.perf_counter()
    liked = json.loads(POSTS.read_text()) if POSTS.exists() else []
    disliked = json.loads(REJECTED.read_text()) if REJECTED.exists() else []

    if len(liked) < 3 or len(disliked) < 3:
        msg = f"Not enough data: {len(liked)} liked, {len(disliked)} disliked (need >=3 each)."
        print(msg, file=sys.stderr)
        return 2

    encoder = SentenceTransformer(ENCODER_NAME)
    feat_dim = encoder.get_sentence_embedding_dimension()

    cache = load_cache()
    # Drop cache entries that are no longer in either bucket — keeps file small.
    live_ids = {it["id"] for it in liked} | {it["id"] for it in disliked}
    cache = {i: v for i, v in cache.items() if i in live_ids}

    X_liked = encode_items(encoder, liked, cache)
    X_disliked = encode_items(encoder, disliked, cache)
    save_cache(cache)

    X = np.concatenate([X_liked, X_disliked], axis=0)
    y = np.array([1] * len(X_liked) + [0] * len(X_disliked), dtype=np.int64)

    # Zero-point: mean of a random subset (or all, if n is small).
    rng = np.random.default_rng(0)
    calib_n = min(200, len(X))
    calib_idx = rng.permutation(len(X))[:calib_n]
    zero_point = X[calib_idx].mean(axis=0).astype(np.float32)

    # Welford streaming means + pooled within-class scatter (same as
    # nanolearn's banking77.py, just n_classes=2).
    n_classes = 2
    mu = np.zeros((n_classes, feat_dim), dtype=np.float64)
    count = np.zeros(n_classes, dtype=np.int64)
    scatter = np.zeros((feat_dim, feat_dim), dtype=np.float64)
    Xc = X - zero_point

    for z, yi in zip(Xc, y):
        count[yi] += 1
        delta_before = z - mu[yi]
        mu[yi] += delta_before / count[yi]
        delta_after = z - mu[yi]
        scatter += np.outer(delta_before, delta_after)

    # Ledoit-Wolf optimal shrinkage on within-class-centered observations.
    # For small n vs large d (82 vs 384), a fixed shrinkage is brittle.
    centered = Xc - mu[y]
    lw = LedoitWolf(assume_centered=True, store_precision=False)
    lw.fit(centered)
    cov = lw.covariance_.astype(np.float64)
    shrinkage_chosen = float(lw.shrinkage_)
    try:
        precision = np.linalg.inv(cov)
    except np.linalg.LinAlgError:
        precision = np.linalg.pinv(cov)

    np.savez(
        MODEL_PATH,
        zero_point=zero_point,
        mu=mu.astype(np.float32),
        precision=precision.astype(np.float32),
        counts=count,
        feature_dim=np.int64(feat_dim),
        encoder_name=np.array(ENCODER_NAME),
        shrinkage=np.float32(shrinkage_chosen),
    )

    elapsed = time.perf_counter() - t0
    report = {
        "liked": int(count[1]),
        "disliked": int(count[0]),
        "feature_dim": feat_dim,
        "shrinkage": round(shrinkage_chosen, 4),
        "elapsed_sec": round(elapsed, 2),
        "model_path": str(MODEL_PATH.relative_to(ROOT)),
    }
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
