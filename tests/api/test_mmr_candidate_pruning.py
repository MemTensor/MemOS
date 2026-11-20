from unittest.mock import Mock

from memos.api.handlers.search_handler import SearchHandler


def _memory(memory_id: str, memory_type: str, score: float) -> dict:
    return {
        "id": memory_id,
        "memory": memory_id,
        "metadata": {"memory_type": memory_type, "relativity": score},
    }


def _bucket(*memories: dict) -> dict:
    return {"cube_id": "cube-a", "memories": list(memories), "total_nodes": len(memories)}


def test_mmr_candidate_pruning_is_disabled_by_default(monkeypatch):
    monkeypatch.delenv("MEMOS_MMR_CANDIDATE_PRUNING_ENABLED", raising=False)
    handler = SearchHandler.__new__(SearchHandler)
    handler.logger = Mock()
    results = {
        "text_mem": [
            _bucket(
                _memory("text-1", "LongTermMemory", 0.9),
                _memory("text-2", "LongTermMemory", 0.8),
                _memory("text-3", "LongTermMemory", 0.7),
            )
        ]
    }

    handler._prune_mmr_candidates_by_bucket(results, text_top_k=1, pref_top_k=1)

    assert [item["id"] for item in results["text_mem"][0]["memories"]] == [
        "text-1",
        "text-2",
        "text-3",
    ]


def test_mmr_candidate_pruning_limits_each_memory_type_and_bucket(monkeypatch):
    monkeypatch.setenv("MEMOS_MMR_CANDIDATE_PRUNING_ENABLED", "true")
    handler = SearchHandler.__new__(SearchHandler)
    handler.logger = Mock()
    results = {
        "text_mem": [
            _bucket(
                _memory("long-1", "LongTermMemory", 0.90),
                _memory("long-2", "LongTermMemory", 0.70),
                _memory("long-3", "LongTermMemory", 0.50),
                _memory("user-1", "UserMemory", 0.85),
                _memory("user-2", "UserMemory", 0.65),
                _memory("user-3", "UserMemory", 0.45),
            )
        ],
        "pref_mem": [
            _bucket(
                _memory("pref-1", "PreferenceMemory", 0.88),
                _memory("pref-2", "PreferenceMemory", 0.68),
                _memory("pref-3", "PreferenceMemory", 0.48),
            )
        ],
    }

    handler._prune_mmr_candidates_by_bucket(results, text_top_k=1, pref_top_k=1)

    assert {item["id"] for item in results["text_mem"][0]["memories"]} == {
        "long-1",
        "long-2",
        "user-1",
        "user-2",
    }
    assert [item["id"] for item in results["pref_mem"][0]["memories"]] == [
        "pref-1",
        "pref-2",
    ]
    assert results["text_mem"][0]["total_nodes"] == 4
    assert results["pref_mem"][0]["total_nodes"] == 2


def test_mmr_dedup_prunes_before_embedding_extraction(monkeypatch):
    monkeypatch.setenv("MEMOS_MMR_CANDIDATE_PRUNING_ENABLED", "true")
    handler = SearchHandler.__new__(SearchHandler)
    handler.logger = Mock()
    handler._extract_embeddings = Mock(return_value=[[1.0, 0.0], [0.0, 1.0]])
    results = {
        "text_mem": [
            _bucket(
                _memory("text-1", "LongTermMemory", 0.9),
                _memory("text-2", "LongTermMemory", 0.8),
                _memory("text-3", "LongTermMemory", 0.7),
            )
        ],
        "pref_mem": [],
    }

    handler._mmr_dedup_text_memories(results, text_top_k=1, pref_top_k=1)

    embedded_memories = handler._extract_embeddings.call_args.args[0]
    assert [item["id"] for item in embedded_memories] == ["text-1", "text-2"]
