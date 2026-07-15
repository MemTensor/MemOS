"""Regression tests for GitHub issue #2103.

`SingleCubeView.search_memories` used to `logger.info(f"Search memories
result: {memories_result}")`, which — when `dedup` is `mmr` or `sim`
(the default is `mmr`) — leaks full embedding vectors into INFO logs.

These tests verify:
  1. The pure redaction helper `_redact_embeddings_for_log` replaces
     `metadata.embedding` lists with a `<embedding len=N>` placeholder,
     across every memory partition (text_mem / pref_mem / tool_mem /
     skill_mem), while preserving every other field.
  2. `search_memories` never prints the raw embedding values into
     the INFO log, even when `dedup=mmr` (the default).

NOTE: heavy mocking mirrors `tests/test_add_stage_logging.py`; the
`SingleCubeView` is imported lazily to work around a circular import in
`memos.api.handlers.__init__`.
"""

from __future__ import annotations

import logging

from typing import Any
from unittest.mock import MagicMock

import pytest

# Prime the `memos.api.handlers` package before any test tries to import
# `memos.multi_mem_cube.single_cube` — this side-steps the known circular
# import path (`api.handlers.__init__` → `add_handler` → `single_cube`)
# by ensuring the handlers package finishes initializing before the
# single_cube module is pulled in on-demand from a test fixture.
import memos.api.handlers  # noqa: F401


# ---------------------------------------------------------------------------
# _redact_embeddings_for_log — pure helper unit tests
# ---------------------------------------------------------------------------


class TestRedactEmbeddingsForLog:
    def test_replaces_embedding_in_text_mem(self):
        from memos.multi_mem_cube.single_cube import _redact_embeddings_for_log

        result = {
            "text_mem": [
                {
                    "cube_id": "c1",
                    "memories": [
                        {
                            "id": "m1",
                            "memory": "hello",
                            "metadata": {
                                "embedding": [0.1, 0.2, 0.3, 0.4],
                                "relativity": 0.9,
                            },
                        }
                    ],
                    "total_nodes": 1,
                }
            ],
            "act_mem": [],
            "para_mem": [],
            "pref_mem": [],
            "tool_mem": [],
            "skill_mem": [],
            "pref_note": "",
        }

        redacted = _redact_embeddings_for_log(result)

        emb = redacted["text_mem"][0]["memories"][0]["metadata"]["embedding"]
        assert emb == "<embedding len=4>"
        # Non-embedding fields preserved verbatim
        assert redacted["text_mem"][0]["memories"][0]["memory"] == "hello"
        assert redacted["text_mem"][0]["memories"][0]["metadata"]["relativity"] == 0.9
        assert redacted["text_mem"][0]["total_nodes"] == 1
        assert redacted["text_mem"][0]["cube_id"] == "c1"

    def test_replaces_embedding_across_all_partitions(self):
        from memos.multi_mem_cube.single_cube import _redact_embeddings_for_log

        def _mk(vec: list[float]) -> dict[str, Any]:
            return {
                "id": "x",
                "memory": "t",
                "metadata": {"embedding": vec, "memory_type": "WorkingMemory"},
            }

        result: dict[str, Any] = {
            "text_mem": [{"cube_id": "c", "memories": [_mk([1.0, 2.0])]}],
            "pref_mem": [{"cube_id": "c", "memories": [_mk([1.0, 2.0, 3.0])]}],
            "tool_mem": [{"cube_id": "c", "memories": [_mk([9.9])]}],
            "skill_mem": [{"cube_id": "c", "memories": [_mk([0.1, 0.2, 0.3, 0.4, 0.5])]}],
            "act_mem": [],
            "para_mem": [],
            "pref_note": "",
        }

        redacted = _redact_embeddings_for_log(result)

        assert (
            redacted["text_mem"][0]["memories"][0]["metadata"]["embedding"] == "<embedding len=2>"
        )
        assert (
            redacted["pref_mem"][0]["memories"][0]["metadata"]["embedding"] == "<embedding len=3>"
        )
        assert (
            redacted["tool_mem"][0]["memories"][0]["metadata"]["embedding"] == "<embedding len=1>"
        )
        assert (
            redacted["skill_mem"][0]["memories"][0]["metadata"]["embedding"] == "<embedding len=5>"
        )

    def test_empty_embedding_reports_zero(self):
        from memos.multi_mem_cube.single_cube import _redact_embeddings_for_log

        result = {
            "text_mem": [
                {
                    "cube_id": "c",
                    "memories": [
                        {"id": "m", "memory": "t", "metadata": {"embedding": []}},
                    ],
                }
            ],
            "pref_mem": [],
            "tool_mem": [],
            "skill_mem": [],
            "act_mem": [],
            "para_mem": [],
            "pref_note": "",
        }

        redacted = _redact_embeddings_for_log(result)
        assert (
            redacted["text_mem"][0]["memories"][0]["metadata"]["embedding"] == "<embedding len=0>"
        )

    def test_missing_metadata_or_embedding_is_untouched(self):
        from memos.multi_mem_cube.single_cube import _redact_embeddings_for_log

        result = {
            "text_mem": [
                {
                    "cube_id": "c",
                    "memories": [
                        {"id": "m1", "memory": "no-meta"},
                        {"id": "m2", "memory": "meta-no-emb", "metadata": {"relativity": 0.5}},
                    ],
                }
            ],
            "pref_mem": [],
            "tool_mem": [],
            "skill_mem": [],
            "act_mem": [],
            "para_mem": [],
            "pref_note": "",
        }

        redacted = _redact_embeddings_for_log(result)
        # First item: no metadata → untouched
        assert "metadata" not in redacted["text_mem"][0]["memories"][0]
        # Second item: has metadata but no embedding → relativity preserved,
        # no accidental embedding key added
        assert redacted["text_mem"][0]["memories"][1]["metadata"] == {"relativity": 0.5}

    def test_does_not_mutate_input(self):
        from memos.multi_mem_cube.single_cube import _redact_embeddings_for_log

        original_vec = [0.1, 0.2, 0.3]
        result = {
            "text_mem": [
                {
                    "cube_id": "c",
                    "memories": [
                        {"id": "m", "memory": "t", "metadata": {"embedding": original_vec}},
                    ],
                }
            ],
            "pref_mem": [],
            "tool_mem": [],
            "skill_mem": [],
            "act_mem": [],
            "para_mem": [],
            "pref_note": "",
        }

        _redact_embeddings_for_log(result)

        # Caller's live dict must still hold the original vector
        assert result["text_mem"][0]["memories"][0]["metadata"]["embedding"] == original_vec
        assert result["text_mem"][0]["memories"][0]["metadata"]["embedding"] is original_vec

    def test_handles_missing_partition_keys(self):
        """`memories_result` in `search_memories` is fully populated, but
        we should still tolerate partial dicts defensively.
        """
        from memos.multi_mem_cube.single_cube import _redact_embeddings_for_log

        result = {
            "text_mem": [
                {
                    "cube_id": "c",
                    "memories": [
                        {"id": "m", "memory": "t", "metadata": {"embedding": [1.0, 2.0]}},
                    ],
                }
            ],
            # Every other partition omitted
        }

        redacted = _redact_embeddings_for_log(result)
        assert (
            redacted["text_mem"][0]["memories"][0]["metadata"]["embedding"] == "<embedding len=2>"
        )


# ---------------------------------------------------------------------------
# Integration — SingleCubeView.search_memories INFO log must not leak
# ---------------------------------------------------------------------------


@pytest.fixture()
def search_view_with_embedding():
    """Build a SingleCubeView whose _search_text returns memories with
    populated embedding vectors (matching the `dedup=mmr` code path).
    """
    from memos.multi_mem_cube.single_cube import SingleCubeView

    view = SingleCubeView(
        cube_id="cube_test",
        naive_mem_cube=MagicMock(),
        mem_reader=MagicMock(),
        mem_scheduler=MagicMock(),
        logger=logging.getLogger("test.search_log_redaction"),
        searcher=MagicMock(),
    )

    fake_embedding = [0.12345, -0.6789, 0.999888, -0.111222]

    def _fake_search_text(_req, _ctx, _mode):
        return [
            {
                "id": "mem-1",
                "memory": "user likes dark mode",
                "ref_id": "[mem]",
                "metadata": {
                    "memory_type": "WorkingMemory",
                    "embedding": fake_embedding,
                    "relativity": 0.87,
                    "ref_id": "[mem]",
                    "id": "mem-1",
                    "memory": "user likes dark mode",
                    "usage": [],
                },
            }
        ]

    view._search_text = _fake_search_text  # type: ignore[method-assign]
    return view, fake_embedding


def _make_search_req(**overrides):
    from memos.api.product_models import APISearchRequest

    defaults = {"user_id": "u1", "query": "test query"}
    defaults.update(overrides)
    return APISearchRequest(**defaults)


class TestSearchMemoriesLoggingRedaction:
    def test_default_dedup_mmr_does_not_leak_embedding(self, search_view_with_embedding, caplog):
        """Default `APISearchRequest.dedup = "mmr"` → embedding stays in
        the returned result, but MUST NOT appear in the INFO log."""
        view, fake_embedding = search_view_with_embedding
        req = _make_search_req()  # defaults: mode=fast, dedup=mmr

        with caplog.at_level(logging.INFO, logger="test.search_log_redaction"):
            result = view.search_memories(req)

        # Sanity: business result still contains the embedding untouched
        assert result["text_mem"][0]["memories"][0]["metadata"]["embedding"] == fake_embedding

        # The 'Search memories result:' INFO line must NOT include any of
        # the embedding float digits.
        search_log_lines = [
            r.message for r in caplog.records if "Search memories result" in r.message
        ]
        assert len(search_log_lines) == 1, (
            f"expected exactly one summary log line, got: {search_log_lines}"
        )
        summary = search_log_lines[0]

        for val in fake_embedding:
            # Each float, formatted straight into a Python list repr,
            # would embed its digits into the log. None must appear.
            assert str(val) not in summary, (
                f"embedding value {val!r} leaked into INFO log: {summary}"
            )

        # And the redaction placeholder should be present
        assert "<embedding len=4>" in summary, (
            f"expected redacted placeholder in log, got: {summary}"
        )

    def test_summary_still_includes_useful_fields(self, search_view_with_embedding, caplog):
        view, _ = search_view_with_embedding
        req = _make_search_req()

        with caplog.at_level(logging.INFO, logger="test.search_log_redaction"):
            view.search_memories(req)

        summary = next(r.message for r in caplog.records if "Search memories result" in r.message)
        # Useful fields still logged — this is a log hygiene fix, not a log removal.
        assert "mem-1" in summary
        assert "user likes dark mode" in summary
        assert "0.87" in summary  # relativity preserved

    def test_count_log_still_emitted(self, search_view_with_embedding, caplog):
        view, _ = search_view_with_embedding
        req = _make_search_req()

        with caplog.at_level(logging.INFO, logger="test.search_log_redaction"):
            view.search_memories(req)

        count_lines = [
            r.message
            for r in caplog.records
            if r.message.startswith("Search ") and "memories." in r.message
        ]
        assert count_lines, "expected 'Search N memories.' count log to remain"
