"""Regression tests for search_memories log sanitization (issue #2103).

Bug summary:
    ``SingleCubeView.search_memories`` used to log the full ``memories_result``
    at INFO level via ``logger.info(f"Search memories result: {memories_result}")``.
    Under the default ``APISearchRequest`` (``dedup="mmr"``),
    ``format_memory_item(..., include_embedding=True)`` retains each memory's
    high-dimensional ``metadata.embedding`` list, producing multi-MB log lines
    per request and leaking vector content into logs (privacy risk).

This suite pins that:
    1. A helper ``_summarize_search_result_for_log`` exists and produces a
       compact, embedding-free summary.
    2. The INFO log emitted by ``search_memories`` never contains embedding
       vector floats, for both ``dedup="mmr"`` (embeddings populated) and
       ``dedup="no"`` (embeddings empty) branches.
    3. The summary still surfaces useful debug signal (per-bucket counts,
       memory IDs, memory types, whether an embedding was attached).
"""

from __future__ import annotations

import logging

from typing import Any
from unittest.mock import MagicMock

import pytest


# Force ``memos.api.handlers`` to finish initializing before any test imports
# ``memos.multi_mem_cube.single_cube``. Without this the SingleCubeView symbol
# lookup inside ``add_handler`` races with our test's import and raises an
# ImportError. See tests/test_add_stage_logging.py for the same workaround.
import memos.api.handlers  # noqa: F401  isort: skip


# ---------------------------------------------------------------------------
# Sample data helpers
# ---------------------------------------------------------------------------


def _make_memory_dict(
    memory_id: str,
    embedding: list[float] | None,
    memory_type: str = "WorkingMemory",
) -> dict[str, Any]:
    """Build a memory dict that matches ``format_memory_item`` output shape."""
    ref_id = f"[{memory_id.split('-')[0]}]"
    return {
        "id": memory_id,
        "memory": f"content-{memory_id}",
        "ref_id": ref_id,
        "metadata": {
            "memory_type": memory_type,
            "embedding": embedding if embedding is not None else [],
            "relativity": 0.87,
            "sources": [],
            "usage": [],
            "ref_id": ref_id,
            "id": memory_id,
            "memory": f"content-{memory_id}",
        },
    }


def _make_search_result(with_embeddings: bool) -> dict[str, Any]:
    embedding = [0.12345, -0.6789, 0.42, -0.99] * 256 if with_embeddings else []
    return {
        "text_mem": [
            {
                "cube_id": "cube_test",
                "memories": [
                    _make_memory_dict("aaaaaa-1", embedding),
                    _make_memory_dict("bbbbbb-2", embedding),
                ],
                "total_nodes": 2,
            }
        ],
        "act_mem": [],
        "para_mem": [],
        "pref_mem": [{"cube_id": "cube_test", "memories": [], "total_nodes": 0}],
        "pref_note": "",
        "tool_mem": [{"cube_id": "cube_test", "memories": [], "total_nodes": 0}],
        "skill_mem": [{"cube_id": "cube_test", "memories": [], "total_nodes": 0}],
    }


# ---------------------------------------------------------------------------
# _summarize_search_result_for_log
# ---------------------------------------------------------------------------


class TestSummarizeSearchResultForLog:
    def test_helper_is_importable(self):
        from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

        assert callable(_summarize_search_result_for_log)

    def test_summary_never_contains_embedding_floats(self):
        from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

        result = _make_search_result(with_embeddings=True)
        summary = _summarize_search_result_for_log(result)

        rendered = str(summary)
        # The distinctive first embedding value must not leak into the summary.
        assert "0.12345" not in rendered
        assert "-0.6789" not in rendered
        # And no giant float-list should appear anywhere in the summary tree.
        for bucket in ("text_mem", "pref_mem", "tool_mem", "skill_mem"):
            for sample in summary[bucket]["samples"]:
                assert "embedding" not in sample, (
                    f"Raw embedding key must never appear in log sample: {list(sample.keys())}"
                )
                assert isinstance(sample.get("has_embedding"), bool)
                # The full embedding value must NEVER be in the sample dict.
                assert 0.12345 not in list(sample.values())

    def test_summary_reports_counts_and_totals(self):
        from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

        result = _make_search_result(with_embeddings=True)
        summary = _summarize_search_result_for_log(result)

        assert summary["text_mem"]["count"] == 2
        assert summary["pref_mem"]["count"] == 0
        assert summary["tool_mem"]["count"] == 0
        assert summary["skill_mem"]["count"] == 0
        assert summary["total_memories"] == 2

    def test_summary_flags_embeddings_when_present(self):
        from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

        result = _make_search_result(with_embeddings=True)
        summary = _summarize_search_result_for_log(result)

        samples = summary["text_mem"]["samples"]
        assert len(samples) == 2
        assert all(s["has_embedding"] is True for s in samples)
        assert all(s["embedding_len"] > 0 for s in samples)
        # useful debug signals still present
        assert {s["id"] for s in samples} == {"aaaaaa-1", "bbbbbb-2"}
        assert all(s["memory_type"] == "WorkingMemory" for s in samples)
        assert all(s["relativity"] == 0.87 for s in samples)

    def test_summary_flags_no_embedding_when_dedup_no(self):
        from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

        result = _make_search_result(with_embeddings=False)
        summary = _summarize_search_result_for_log(result)

        samples = summary["text_mem"]["samples"]
        assert len(samples) == 2
        assert all(s["has_embedding"] is False for s in samples)
        assert all(s["embedding_len"] == 0 for s in samples)

    def test_samples_are_bounded(self):
        """Even at large top_k the summary stays a fixed size."""
        from memos.multi_mem_cube.single_cube import (
            _LOG_SAMPLE_PER_BUCKET,
            _summarize_search_result_for_log,
        )

        large_embedding = [0.1] * 1024
        many_memories = [_make_memory_dict(f"mem-{i}", large_embedding) for i in range(50)]
        result = {
            "text_mem": [{"cube_id": "cube_test", "memories": many_memories, "total_nodes": 50}],
            "act_mem": [],
            "para_mem": [],
            "pref_mem": [],
            "pref_note": "",
            "tool_mem": [],
            "skill_mem": [],
        }

        summary = _summarize_search_result_for_log(result)

        assert summary["text_mem"]["count"] == 50
        assert len(summary["text_mem"]["samples"]) == _LOG_SAMPLE_PER_BUCKET
        # Even the full string form stays small (bounded, no embeddings).
        assert len(str(summary)) < 2000

    def test_count_is_accurate_across_groups_after_sample_cap(self):
        """Regression: bucket_count must aggregate every group's memories, even
        the groups visited after ``samples`` reaches ``_LOG_SAMPLE_PER_BUCKET``.

        Multi-cube deployments produce one ``group`` per cube inside the same
        bucket (e.g. ``text_mem``); the old code broke out of the outer
        ``for group in groups`` loop the moment sampling capped, so
        ``bucket_count`` and ``total_memories`` silently undercounted the
        real number of matched memories. This test pins the correct
        behaviour: sampling is bounded, counting is not.
        """
        from memos.multi_mem_cube.single_cube import (
            _LOG_SAMPLE_PER_BUCKET,
            _summarize_search_result_for_log,
        )

        embedding = [0.1] * 32
        # Two cubes, 10 memories each. First group already exceeds the sample cap.
        group_a = [_make_memory_dict(f"a-{i}", embedding) for i in range(10)]
        group_b = [_make_memory_dict(f"b-{i}", embedding) for i in range(10)]
        result = {
            "text_mem": [
                {"cube_id": "cube_a", "memories": group_a, "total_nodes": 10},
                {"cube_id": "cube_b", "memories": group_b, "total_nodes": 10},
            ],
            "act_mem": [],
            "para_mem": [],
            "pref_mem": [],
            "pref_note": "",
            "tool_mem": [],
            "skill_mem": [],
        }

        summary = _summarize_search_result_for_log(result)

        # bucket_count must include memories from both cubes' groups.
        assert summary["text_mem"]["count"] == 20, (
            f"bucket_count undercounted: expected 20, got {summary['text_mem']['count']}"
        )
        assert summary["total_memories"] == 20, (
            f"total_memories undercounted: expected 20, got {summary['total_memories']}"
        )
        # Sampling is still bounded.
        assert len(summary["text_mem"]["samples"]) == _LOG_SAMPLE_PER_BUCKET

    def test_handles_missing_or_malformed_input(self):
        from memos.multi_mem_cube.single_cube import _summarize_search_result_for_log

        # Empty dict — must not raise.
        summary = _summarize_search_result_for_log({})
        assert summary["total_memories"] == 0
        for bucket in ("text_mem", "pref_mem", "tool_mem", "skill_mem"):
            assert summary[bucket]["count"] == 0
            assert summary[bucket]["samples"] == []

        # None or garbage in the bucket — must not raise.
        summary = _summarize_search_result_for_log(
            {
                "text_mem": None,
                "pref_mem": ["not-a-dict"],
                "tool_mem": [{"memories": [None, "junk"]}],
            }
        )
        assert summary["total_memories"] >= 0


# ---------------------------------------------------------------------------
# SingleCubeView.search_memories log-line assertions
# ---------------------------------------------------------------------------


def _build_view_with_search_result(monkeypatch, memories_result: dict[str, Any]):
    """Instantiate SingleCubeView bypassing all heavy dependencies and stub
    _search_text so post_process_textual_mem produces a controlled result."""
    from memos.api.handlers import formatters_handler
    from memos.multi_mem_cube import single_cube as sc_module

    logger = logging.getLogger("test.single_cube.search")

    view = sc_module.SingleCubeView(
        cube_id="cube_test",
        naive_mem_cube=MagicMock(),
        mem_reader=MagicMock(),
        mem_scheduler=MagicMock(),
        logger=logger,
        searcher=MagicMock(),
        feedback_server=None,
    )

    # Stub _search_text to return already-formatted memory dicts drawn from
    # memories_result so post_process_textual_mem re-appends them.
    formatted = []
    for bucket in ("text_mem",):
        for group in memories_result.get(bucket) or []:
            formatted.extend(group.get("memories") or [])

    monkeypatch.setattr(view, "_search_text", lambda *a, **kw: formatted)

    # Guarantee post_process_textual_mem is the real one (it is, but be explicit).
    assert formatters_handler.post_process_textual_mem is not None

    return view


class TestSearchMemoriesLogSanitization:
    def _run(self, monkeypatch, caplog, dedup: str):
        from memos.api.product_models import APISearchRequest

        with_embeddings = dedup in ("mmr", "sim")
        memories_result = _make_search_result(with_embeddings=with_embeddings)

        view = _build_view_with_search_result(monkeypatch, memories_result)

        req = APISearchRequest(
            query="hello",
            user_id="u1",
            dedup=dedup,  # type: ignore[arg-type]
        )

        with caplog.at_level(logging.INFO, logger="test.single_cube.search"):
            view.search_memories(req)

        return [rec.getMessage() for rec in caplog.records]

    @pytest.mark.parametrize("dedup", ["mmr", "sim"])
    def test_no_embedding_floats_in_log_when_dedup_populates_embeddings(
        self, monkeypatch, caplog, dedup
    ):
        messages = self._run(monkeypatch, caplog, dedup=dedup)
        joined = "\n".join(messages)

        # Distinctive floats from the synthetic embedding must NOT appear.
        assert "0.12345" not in joined, (
            f"Embedding vector leaked into log line (dedup={dedup}): {joined}"
        )
        assert "-0.6789" not in joined, (
            f"Embedding vector leaked into log line (dedup={dedup}): {joined}"
        )

        # The old, bad log line format must not be present.
        assert "Search memories result: {" not in joined

        # But the safe summary must be emitted.
        assert any("Search memories result summary" in m and "text_mem" in m for m in messages), (
            f"No sanitized summary log emitted; got: {messages}"
        )

    def test_summary_log_still_useful_when_dedup_no(self, monkeypatch, caplog):
        messages = self._run(monkeypatch, caplog, dedup="no")
        joined = "\n".join(messages)

        # Even without embeddings, the summary line still fires with counts.
        assert "Search memories result summary" in joined
        assert "'text_mem'" in joined or "text_mem" in joined
        assert "'count': 2" in joined or "count=2" in joined or "'count': 2" in joined

    def test_no_bad_len_call_on_result_dict(self, monkeypatch, caplog):
        """Old code did ``len(memories_result)`` which returned the count of
        top-level keys (~7), not the number of matched memories. The rewritten
        summary log carries ``total_memories`` = real count instead."""
        messages = self._run(monkeypatch, caplog, dedup="no")
        joined = "\n".join(messages)

        assert "'total_memories': 2" in joined
        # And the misleading old line is gone.
        assert not any(m.startswith("Search 7 memories") for m in messages)
