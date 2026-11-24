"""Search result kinds contributed by plugins.

The core search pipeline knows its own result buckets (``text_mem``, ``pref_mem``). A plugin
that serves another kind of memory registers a result key here and adds a bucket under that
key from the ``search.memory_results`` hook. The core then applies the request's relevance
threshold to registered kinds as it does to its own, so every kind follows the same rule;
the plugin turns its bucket into the final response field from ``search.results.after_rerank``.

Buckets use the core layout: ``[{"cube_id": ..., "memories": [{"id", "memory",
"metadata": {"relativity": float, ...}, ...}]}]``.
"""

from __future__ import annotations

from typing import Any


_KINDS: list[str] = []


def register_result_kind(key: str) -> None:
    if key not in _KINDS:
        _KINDS.append(key)


def result_kinds() -> tuple[str, ...]:
    return tuple(_KINDS)


def apply_relativity_to_plugin_kinds(results: dict[str, Any], relativity: float) -> dict[str, Any]:
    """Drop memories below ``relativity`` in plugin-registered buckets (same rule as the core's
    own buckets: a missing score counts as 1.0)."""
    if not relativity or relativity <= 0 or not isinstance(results, dict):
        return results
    for key in _KINDS:
        buckets = results.get(key)
        if not isinstance(buckets, list):
            continue
        for bucket in buckets:
            memories = bucket.get("memories") if isinstance(bucket, dict) else None
            if not isinstance(memories, list):
                continue
            kept = []
            for mem in memories:
                meta = mem.get("metadata") if isinstance(mem, dict) else None
                score = meta.get("relativity", 1.0) if isinstance(meta, dict) else 1.0
                try:
                    value = float(score) if score is not None else 1.0
                except (TypeError, ValueError):
                    value = 1.0
                if value >= relativity:
                    kept.append(mem)
            bucket["memories"] = kept
    return results
