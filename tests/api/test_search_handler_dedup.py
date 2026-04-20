"""
Unit tests for SearchHandler dedup modes.

Validates that `_dedup_text_memories` (sim), `_mmr_dedup_text_memories` (mmr),
and `_strip_embeddings` (used by the "no" branch) behave per the acceptance
criteria in TASK.md: on a corpus of near-duplicates + distinct items, sim
collapses the dupe cluster, mmr keeps more diversity than a raw selection,
and repeated calls are deterministic.
"""

import copy

from unittest.mock import Mock

import pytest

from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.search_handler import SearchHandler


# Embedding dimensions chosen so near-dupes share a dominant axis (cosine ~0.999)
# and distincts live on orthogonal unit basis vectors (cosine 0 to everything
# else). This makes the test independent of any real embedder.
def _near_dupe_embedding(k: int) -> list[float]:
    # All near-dupes share e_0 as the dominant direction with a tiny e_1 jitter.
    vec = [1.0, 0.001 * k, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
    norm = sum(v * v for v in vec) ** 0.5
    return [v / norm for v in vec]


def _distinct_embedding(k: int) -> list[float]:
    # e_{k+2}: orthogonal to near-dupes and to each other.
    vec = [0.0] * 8
    vec[k + 2] = 1.0
    return vec


def _make_memory(mem_id: str, text: str, embedding: list[float], relativity: float) -> dict:
    return {
        "id": mem_id,
        "memory": text,
        "metadata": {
            "embedding": embedding,
            "relativity": relativity,
        },
    }


def _make_results() -> dict:
    """Build a results payload with 5 near-dupes (high relativity) + 5 distincts.

    Near-dupes get higher relativity so sim/mmr both see them as preferred
    candidates — this exercises the filtering logic rather than masking the
    bug by ordering distincts first.
    """
    near_dupes = [
        _make_memory(
            f"near-{k}",
            f"The Pacific Ocean covers approximately 46% of Earth's water (variant {k}).",
            _near_dupe_embedding(k),
            relativity=0.9 - 0.01 * k,
        )
        for k in range(5)
    ]
    distincts = [
        _make_memory(
            f"dist-{k}",
            f"Distinct fact number {k}.",
            _distinct_embedding(k),
            relativity=0.5 - 0.01 * k,
        )
        for k in range(5)
    ]
    return {
        "text_mem": [
            {
                "cube_id": "test-cube",
                "memories": near_dupes + distincts,
            }
        ],
        "pref_mem": [],
    }


@pytest.fixture
def handler():
    deps = HandlerDependencies(
        naive_mem_cube=Mock(),
        mem_scheduler=Mock(),
        searcher=Mock(),
        deepsearch_agent=Mock(),
    )
    return SearchHandler(deps)


def _text_ids(results: dict) -> list[str]:
    ids: list[str] = []
    for bucket in results.get("text_mem", []):
        for mem in bucket["memories"]:
            ids.append(mem["id"])
    return ids


class TestSimDedup:
    def test_collapses_near_dupe_cluster(self, handler, monkeypatch):
        monkeypatch.setenv("MOS_MMR_TEXT_THRESHOLD", "0.85")
        results = _make_results()
        out = handler._dedup_text_memories(results, target_top_k=10)

        ids = _text_ids(out)
        near_kept = [i for i in ids if i.startswith("near-")]
        distinct_kept = [i for i in ids if i.startswith("dist-")]

        assert len(ids) <= 6, f"sim should drop dupes; got {ids}"
        assert len(near_kept) == 1, (
            f"exactly one near-dupe survives the sim filter; got {near_kept}"
        )
        assert set(distinct_kept) == {f"dist-{k}" for k in range(5)}

    def test_deterministic(self, handler, monkeypatch):
        monkeypatch.setenv("MOS_MMR_TEXT_THRESHOLD", "0.85")
        r1 = handler._dedup_text_memories(_make_results(), target_top_k=10)
        r2 = handler._dedup_text_memories(_make_results(), target_top_k=10)
        assert _text_ids(r1) == _text_ids(r2)

    def test_respects_threshold_env(self, handler, monkeypatch):
        # With threshold >= 1.0 nothing should be filtered (no two vectors have
        # cosine >= 1.0 except an item with itself, which is never compared).
        monkeypatch.setenv("MOS_MMR_TEXT_THRESHOLD", "1.01")
        out = handler._dedup_text_memories(_make_results(), target_top_k=10)
        assert len(_text_ids(out)) == 10


class TestMmrDedup:
    def test_caps_below_corpus_size(self, handler, monkeypatch):
        monkeypatch.setenv("MOS_MMR_LAMBDA", "0.7")
        monkeypatch.setenv("MOS_MMR_PENALTY_THRESHOLD", "0.7")
        monkeypatch.setenv("MOS_MMR_STOP_SCORE", "0.0")
        results = _make_results()
        out = handler._mmr_dedup_text_memories(results, text_top_k=10, pref_top_k=6)

        ids = _text_ids(out)
        # TASK acceptance: mmr ≤ 7 on this corpus.
        assert len(ids) <= 7, f"mmr should early-stop on heavy-penalty dupes; got {ids}"
        # Must keep all 5 distincts — they have zero similarity to anything.
        distinct_kept = [i for i in ids if i.startswith("dist-")]
        assert set(distinct_kept) == {f"dist-{k}" for k in range(5)}

    def test_deterministic(self, handler, monkeypatch):
        monkeypatch.setenv("MOS_MMR_LAMBDA", "0.7")
        monkeypatch.setenv("MOS_MMR_PENALTY_THRESHOLD", "0.7")
        r1 = handler._mmr_dedup_text_memories(
            _make_results(), text_top_k=10, pref_top_k=6
        )
        r2 = handler._mmr_dedup_text_memories(
            _make_results(), text_top_k=10, pref_top_k=6
        )
        assert _text_ids(r1) == _text_ids(r2)

    def test_first_pick_is_highest_relevance(self, handler, monkeypatch):
        # The first MMR pick has no competitors so diversity = 0 and the
        # argmax is pure relevance. On our fixture that's near-0 (relativity 0.9).
        monkeypatch.setenv("MOS_MMR_LAMBDA", "0.7")
        monkeypatch.setenv("MOS_MMR_PENALTY_THRESHOLD", "0.7")
        out = handler._mmr_dedup_text_memories(
            _make_results(), text_top_k=10, pref_top_k=6
        )
        ids = _text_ids(out)
        assert "near-0" in ids


class TestNoAndStrip:
    def test_strip_clears_embeddings(self, handler):
        results = _make_results()
        handler._strip_embeddings(results)
        for bucket in results["text_mem"]:
            for mem in bucket["memories"]:
                assert mem["metadata"]["embedding"] == []
        # Full corpus preserved: the "no" path leaves everything in place.
        assert len(_text_ids(results)) == 10

    def test_no_mode_keeps_all_near_dupes(self, handler):
        # Emulate what handle_search_memories does for dedup="no": no filter,
        # just strip. All 5 near-dupes must survive.
        results = _make_results()
        handler._strip_embeddings(results)
        ids = _text_ids(results)
        near_kept = [i for i in ids if i.startswith("near-")]
        assert len(near_kept) == 5


class TestSimVsMmr:
    """Cross-mode sanity: the two dedup modes should not be equivalent."""

    def test_mmr_may_select_different_set_than_sim(self, handler, monkeypatch):
        monkeypatch.setenv("MOS_MMR_TEXT_THRESHOLD", "0.85")
        monkeypatch.setenv("MOS_MMR_LAMBDA", "0.7")
        monkeypatch.setenv("MOS_MMR_PENALTY_THRESHOLD", "0.7")

        sim_out = handler._dedup_text_memories(_make_results(), target_top_k=10)
        mmr_out = handler._mmr_dedup_text_memories(
            _make_results(), text_top_k=10, pref_top_k=6
        )

        sim_ids = set(_text_ids(sim_out))
        mmr_ids = set(_text_ids(mmr_out))

        # Both should keep all distincts.
        assert {f"dist-{k}" for k in range(5)}.issubset(sim_ids)
        assert {f"dist-{k}" for k in range(5)}.issubset(mmr_ids)
        # Both should keep near-0 (highest-relevance near-dupe).
        assert "near-0" in sim_ids
        assert "near-0" in mmr_ids
        # And strictly less than the raw 10 (otherwise dedup did nothing).
        assert len(sim_ids) < 10
        assert len(mmr_ids) < 10


def test_empty_results(handler):
    """Edge case: empty text_mem and pref_mem short-circuit cleanly."""
    empty = {"text_mem": [], "pref_mem": []}
    assert handler._dedup_text_memories(copy.deepcopy(empty), 10) == empty
    assert (
        handler._mmr_dedup_text_memories(copy.deepcopy(empty), 10, 6) == empty
    )
