"""
Regression tests for the sanitized ``search_memories`` INFO log emitted by
:mod:`memos.multi_mem_cube.single_cube`.

Issue #2103: the previous implementation printed the full ``MOSSearchResult``
dict, which under the default ``dedup="mmr"`` (or ``dedup="sim"``) branch keeps
``metadata.embedding`` as a high-dimensional float list. That leaks the raw
vectors into the INFO log stream, causing log explosion and privacy risk.

The fix introduces :func:`_summarize_search_result_for_log` which produces a
bounded, embedding-free summary. These tests pin its contract so any regression
that re-enables the leak fails fast.

NOTE: ``_summarize_search_result_for_log`` is imported lazily inside each test
to work around a known circular import in ``memos.api.handlers.__init__`` (see
``tests/test_add_stage_logging.py`` for the same workaround).
"""

from __future__ import annotations

import json

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _import_helper():
    # Preload memos.api.handlers first — importing single_cube directly would
    # trigger a partially-initialised module during its own re-entrant import
    # chain (see the circular-import workaround in tests/test_add_stage_logging.py).
    import memos.api.handlers  # noqa: F401

    from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

    return _summarize_search_result_for_log


def _make_memory(
    mem_id: str,
    memory_type: str,
    *,
    embedding: list[float] | None = None,
    relativity: float = 0.5,
    cube_id: str = "cube-A",
) -> dict:
    """Construct a single formatted memory dict matching what
    ``format_memory_item`` produces downstream."""
    return {
        "id": mem_id,
        "memory": f"memory text for {mem_id}",
        "ref_id": f"[{mem_id[:8]}]",
        "metadata": {
            "id": mem_id,
            "memory_type": memory_type,
            "relativity": relativity,
            "embedding": embedding if embedding is not None else [],
            "sources": [],
            "usage": [],
        },
        "cube_id": cube_id,
    }


def _make_result(
    text_mems: list[dict] | None = None,
    pref_mems: list[dict] | None = None,
    tool_mems: list[dict] | None = None,
    skill_mems: list[dict] | None = None,
    cube_id: str = "cube-A",
) -> dict:
    """Build a ``MOSSearchResult``-shaped dict for a single cube."""
    return {
        "text_mem": [
            {
                "cube_id": cube_id,
                "memories": text_mems or [],
                "total_nodes": len(text_mems or []),
            }
        ],
        "act_mem": [],
        "para_mem": [],
        "pref_mem": [
            {
                "cube_id": cube_id,
                "memories": pref_mems or [],
                "total_nodes": len(pref_mems or []),
            }
        ],
        "pref_note": "",
        "tool_mem": [
            {
                "cube_id": cube_id,
                "memories": tool_mems or [],
                "total_nodes": len(tool_mems or []),
            }
        ],
        "skill_mem": [
            {
                "cube_id": cube_id,
                "memories": skill_mems or [],
                "total_nodes": len(skill_mems or []),
            }
        ],
    }


# ---------------------------------------------------------------------------
# Core sanitization contract
# ---------------------------------------------------------------------------


class TestNoEmbeddingLeak:
    def test_embedding_floats_are_stripped_from_summary(self):
        """The raw embedding float list must never appear in the summary."""
        summarize = _import_helper()
        big_vector = [0.0123, -0.0456, 0.7890, -0.1234, 0.5678] * 50  # 250 floats
        result = _make_result(
            text_mems=[
                _make_memory("id-1", "UserMemory", embedding=big_vector),
                _make_memory("id-2", "LongTermMemory", embedding=big_vector),
            ]
        )

        summary = summarize(result)
        rendered = json.dumps(summary, default=str)

        # None of the vector components may appear in the rendered log payload.
        for value in (0.0123, -0.0456, 0.7890, 0.5678):
            assert str(value) not in rendered, (
                f"Embedding float {value} leaked into log summary: {rendered!r}"
            )

    def test_summary_flags_embedding_presence_as_boolean(self):
        """We still want to know *whether* embeddings were populated, but only
        as a bool — not the vector itself."""
        summarize = _import_helper()
        big_vector = [0.11, 0.22, 0.33]
        result = _make_result(text_mems=[_make_memory("a", "UserMemory", embedding=big_vector)])

        summary = summarize(result)

        assert summary["has_embedding"] is True

    def test_summary_marks_absent_embedding(self):
        summarize = _import_helper()
        result = _make_result(text_mems=[_make_memory("a", "UserMemory", embedding=[])])

        summary = summarize(result)

        assert summary["has_embedding"] is False


# ---------------------------------------------------------------------------
# Debug value preservation
# ---------------------------------------------------------------------------


class TestSummaryContent:
    def test_per_bucket_counts_are_reported(self):
        summarize = _import_helper()
        result = _make_result(
            text_mems=[
                _make_memory("t1", "UserMemory"),
                _make_memory("t2", "LongTermMemory"),
                _make_memory("t3", "WorkingMemory"),
            ],
            pref_mems=[_make_memory("p1", "PreferenceMemory")],
            tool_mems=[
                _make_memory("tool1", "ToolSchemaMemory"),
                _make_memory("tool2", "ToolTrajectoryMemory"),
            ],
            skill_mems=[_make_memory("s1", "SkillMemory")],
        )

        summary = summarize(result)
        counts = summary["counts"]

        assert counts["text_mem"] == 3
        assert counts["pref_mem"] == 1
        assert counts["tool_mem"] == 2
        assert counts["skill_mem"] == 1

    def test_total_count_is_reported(self):
        summarize = _import_helper()
        result = _make_result(
            text_mems=[_make_memory(f"t{i}", "UserMemory") for i in range(4)],
            pref_mems=[_make_memory("p1", "PreferenceMemory")],
        )

        summary = summarize(result)

        # total should be sum across all four buckets
        assert summary["total"] == 5

    def test_sample_memory_ids_are_included_for_debug(self):
        summarize = _import_helper()
        result = _make_result(
            text_mems=[
                _make_memory("id-alpha", "UserMemory", relativity=0.9),
                _make_memory("id-beta", "LongTermMemory", relativity=0.8),
            ]
        )

        summary = summarize(result)

        # We expect the per-bucket sample to expose ids + memory_type + relativity
        text_samples = summary["samples"]["text_mem"]
        assert len(text_samples) == 2
        ids = {item["id"] for item in text_samples}
        assert ids == {"id-alpha", "id-beta"}
        types = {item["memory_type"] for item in text_samples}
        assert types == {"UserMemory", "LongTermMemory"}

    def test_sample_size_is_bounded(self):
        """Samples must be capped to keep the log line small even when top_k
        is large. The cap value itself is an implementation detail; here we
        just assert it is bounded to <= 5 per bucket."""
        summarize = _import_helper()
        text_mems = [_make_memory(f"id-{i}", "UserMemory") for i in range(20)]
        result = _make_result(text_mems=text_mems)

        summary = summarize(result)
        text_samples = summary["samples"]["text_mem"]

        assert len(text_samples) <= 5
        # But bucket count still reports the true value.
        assert summary["counts"]["text_mem"] == 20


# ---------------------------------------------------------------------------
# Dedup branches — regression coverage for issue #2103
# ---------------------------------------------------------------------------


class TestDedupBranches:
    @pytest.mark.parametrize(
        "embedding_value",
        [
            [0.001, 0.002, 0.003, 0.004, 0.005],  # dedup="mmr" / "sim"
            [],  # dedup="no" (or anything else that drops embeddings)
        ],
    )
    def test_both_branches_produce_safe_output(self, embedding_value):
        """Whether embeddings are populated (mmr/sim) or empty (no), the log
        summary must remain safe and structurally identical."""
        summarize = _import_helper()
        result = _make_result(
            text_mems=[_make_memory("m1", "UserMemory", embedding=embedding_value)]
        )

        summary = summarize(result)
        rendered = json.dumps(summary, default=str)

        # These specific floats must not leak.
        for value in embedding_value:
            assert str(value) not in rendered

        # Both branches must expose the same top-level keys.
        assert set(summary.keys()) >= {"counts", "total", "samples", "has_embedding"}


# ---------------------------------------------------------------------------
# Robustness
# ---------------------------------------------------------------------------


class TestRobustness:
    def test_missing_bucket_keys_do_not_raise(self):
        """The helper must tolerate partially-populated results — e.g. when a
        bucket is missing entirely (older callers, edge cases)."""
        summarize = _import_helper()
        result = {"text_mem": [], "pref_mem": []}
        summary = summarize(result)

        assert summary["counts"]["text_mem"] == 0
        assert summary["counts"]["pref_mem"] == 0
        assert summary["counts"]["tool_mem"] == 0
        assert summary["counts"]["skill_mem"] == 0
        assert summary["total"] == 0

    def test_non_dict_memory_items_do_not_raise(self):
        """The helper should degrade gracefully rather than crash the whole
        search path if a memory item is not the expected shape."""
        summarize = _import_helper()
        result = _make_result()
        # inject a malformed memory
        result["text_mem"][0]["memories"] = [
            {"id": "ok", "metadata": {"memory_type": "UserMemory", "relativity": 0.1}},
            "not-a-dict",
            None,
        ]

        # Must not raise
        summary = summarize(result)

        # The valid item is still counted
        assert summary["counts"]["text_mem"] == 3
