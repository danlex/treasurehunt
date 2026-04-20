"""Score queue candidates against the trained taste model.

Reads a JSON array of items from stdin, writes a JSON array of
{id, tasteScore, predicted} to stdout. tasteScore is the signed
Mahalanobis margin: d(x, mu_disliked) - d(x, mu_liked). Positive
means the model predicts Like.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer

CLASSIFIER_DIR = Path(__file__).resolve().parent
MODEL_PATH = CLASSIFIER_DIR / "model.npz"

# Must match train.py
from train import item_text, ENCODER_NAME  # noqa: E402


def main() -> int:
    if not MODEL_PATH.exists():
        print(json.dumps({"error": "model not trained"}), file=sys.stderr)
        return 2

    raw = sys.stdin.read().strip()
    if not raw:
        print("[]")
        return 0
    items = json.loads(raw)
    if not items:
        print("[]")
        return 0

    model = np.load(MODEL_PATH, allow_pickle=True)
    zero_point = model["zero_point"]
    mu = model["mu"]
    precision = model["precision"]

    encoder = SentenceTransformer(str(model["encoder_name"]))
    texts = [item_text(it) for it in items]
    X = encoder.encode(
        texts,
        convert_to_numpy=True,
        normalize_embeddings=False,
        show_progress_bar=False,
    ).astype(np.float32)

    Xc = X - zero_point
    # Mahalanobis distance to each class centroid.
    diffs = Xc[:, None, :] - mu[None, :, :]  # (n, 2, d)
    tmp = diffs @ precision
    d2 = (tmp * diffs).sum(axis=-1)  # (n, 2)
    # Signed margin: d(dislike) - d(like). Positive = predict Like.
    margin = (d2[:, 0] - d2[:, 1]).astype(float)

    out = [
        {
            "id": items[i]["id"],
            "tasteScore": round(float(margin[i]), 3),
            "predicted": "like" if margin[i] > 0 else "dislike",
            "distLike": round(float(d2[i, 1]), 3),
            "distDislike": round(float(d2[i, 0]), 3),
        }
        for i in range(len(items))
    ]
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
