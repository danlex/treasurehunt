"""Leave-one-out evaluation of the taste classifier.

Encodes all items once, then for each held-out item rebuilds the
Mahalanobis prototype from the remaining 87 and scores the held-out
example. Reports accuracy, per-class accuracy, and AUROC from the
signed margin.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.covariance import LedoitWolf

from train import ENCODER_NAME, item_text, load_cache, save_cache, encode_items

ROOT = Path(__file__).resolve().parent.parent


def fit_predict(Xc: np.ndarray, y: np.ndarray, x_hold: np.ndarray) -> float:
    feat_dim = Xc.shape[1]
    n_classes = 2
    mu = np.zeros((n_classes, feat_dim), dtype=np.float64)
    count = np.zeros(n_classes, dtype=np.int64)

    for z, yi in zip(Xc, y):
        count[yi] += 1
        mu[yi] += (z - mu[yi]) / count[yi]

    centered = Xc - mu[y]
    lw = LedoitWolf(assume_centered=True, store_precision=False)
    lw.fit(centered)
    try:
        prec = np.linalg.inv(lw.covariance_)
    except np.linalg.LinAlgError:
        prec = np.linalg.pinv(lw.covariance_)

    diff0 = x_hold - mu[0]
    diff1 = x_hold - mu[1]
    d0 = diff0 @ prec @ diff0
    d1 = diff1 @ prec @ diff1
    return float(d0 - d1)  # positive = predict like


def main() -> None:
    liked = json.loads((ROOT / "posts.json").read_text())
    disliked = json.loads((ROOT / "rejected.json").read_text())

    encoder = SentenceTransformer(ENCODER_NAME)
    cache = load_cache()
    live = {it["id"] for it in liked} | {it["id"] for it in disliked}
    cache = {i: v for i, v in cache.items() if i in live}
    X_l = encode_items(encoder, liked, cache)
    X_d = encode_items(encoder, disliked, cache)
    save_cache(cache)

    X = np.concatenate([X_l, X_d], axis=0)
    y = np.array([1] * len(X_l) + [0] * len(X_d), dtype=np.int64)
    items = liked + disliked

    rng = np.random.default_rng(0)
    calib_idx = rng.permutation(len(X))[: min(200, len(X))]
    zero_point = X[calib_idx].mean(axis=0).astype(np.float32)
    Xc_all = X - zero_point

    n = len(X)
    margins = np.zeros(n)
    for i in range(n):
        keep = np.ones(n, dtype=bool)
        keep[i] = False
        margins[i] = fit_predict(Xc_all[keep], y[keep], Xc_all[i])

    preds = (margins > 0).astype(int)
    correct = (preds == y).astype(int)
    acc = correct.mean()
    acc_like = correct[y == 1].mean()
    acc_dis = correct[y == 0].mean()

    # AUROC via rank
    order = np.argsort(-margins)
    y_sorted = y[order]
    n_pos = (y == 1).sum()
    n_neg = (y == 0).sum()
    tp = 0
    fp = 0
    tpr_list = [0.0]
    fpr_list = [0.0]
    for lbl in y_sorted:
        if lbl == 1:
            tp += 1
        else:
            fp += 1
        tpr_list.append(tp / n_pos)
        fpr_list.append(fp / n_neg)
    auroc = 0.0
    for k in range(1, len(tpr_list)):
        auroc += (fpr_list[k] - fpr_list[k - 1]) * 0.5 * (tpr_list[k] + tpr_list[k - 1])

    # Hardest misses
    wrong_idx = np.where(preds != y)[0]
    wrong_idx = sorted(wrong_idx, key=lambda i: abs(margins[i]), reverse=True)[:5]
    worst = [
        {
            "id": items[i]["id"],
            "truth": "like" if y[i] == 1 else "dislike",
            "margin": round(float(margins[i]), 3),
            "title": items[i]["title"][:80],
        }
        for i in wrong_idx
    ]

    report = {
        "n": int(n),
        "liked": int(n_pos),
        "disliked": int(n_neg),
        "accuracy": round(float(acc), 3),
        "acc_on_liked": round(float(acc_like), 3),
        "acc_on_disliked": round(float(acc_dis), 3),
        "auroc": round(float(auroc), 3),
        "margin_mean_liked": round(float(margins[y == 1].mean()), 3),
        "margin_mean_disliked": round(float(margins[y == 0].mean()), 3),
        "worst_errors": worst,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
