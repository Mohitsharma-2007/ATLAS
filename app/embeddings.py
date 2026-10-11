"""Small deterministic embeddings for a no-local-model MVP.

The vector is a signed feature-hash representation of word and word-pair features.
It is deliberately deterministic, fast, and dependency-free. It is useful for
lexical/near-topic retrieval and can later be replaced by a remote embedding model
without changing the Paper schema or API.
"""

from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Iterable


TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_-]*")
STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "their",
    "this",
    "to",
    "what",
    "which",
    "with",
}


def _features(text: str) -> list[str]:
    tokens = [token for token in TOKEN_RE.findall(text.lower()) if token not in STOP_WORDS]
    bigrams = [f"{left}__{right}" for left, right in zip(tokens, tokens[1:])]
    return tokens + bigrams


def embed_text(text: str, dimensions: int = 384) -> list[float]:
    if dimensions < 8:
        raise ValueError("Embedding dimensions must be at least 8")
    vector = [0.0] * dimensions
    for feature in _features(text):
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[bucket] += sign
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return vector
    return [value / norm for value in vector]


def cosine_similarity(left: Iterable[float], right: Iterable[float]) -> float:
    left_values = list(left)
    right_values = list(right)
    if not left_values or len(left_values) != len(right_values):
        return 0.0
    left_norm = math.sqrt(sum(value * value for value in left_values))
    right_norm = math.sqrt(sum(value * value for value in right_values))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return sum(a * b for a, b in zip(left_values, right_values)) / (left_norm * right_norm)
