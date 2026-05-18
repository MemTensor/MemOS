from __future__ import annotations

import json

from memos.dream.contextualization import CONTEXT_MEMORY_TYPE, DreamContextualizer
from memos.dream.types import DreamSignalSnapshot
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata


class FakeGraphDB:
    def __init__(self, nodes: list[dict] | None = None):
        self.nodes = {node["id"]: node for node in nodes or []}
        self.added: list[tuple[str, str, dict, str | None]] = []
        self.updated: list[tuple[str, dict, str | None]] = []

    def get_nodes(self, ids, include_embedding=False, user_name=None):
        return [self.nodes[node_id] for node_id in ids if node_id in self.nodes]

    def get_by_metadata(self, filters, user_name=None, status=None):
        matched = []
        for node_id, node in self.nodes.items():
            metadata = node.get("metadata", {})
            if status and metadata.get("status") != status:
                continue
            ok = True
            for item in filters:
                if item.get("op") == "=" and metadata.get(item.get("field")) != item.get("value"):
                    ok = False
                    break
            if ok:
                matched.append(node_id)
        return matched

    def add_node(self, id, memory, metadata, user_name=None):
        self.added.append((id, memory, metadata, user_name))
        self.nodes[id] = {"id": id, "memory": memory, "metadata": metadata}

    def update_node(self, id, fields, user_name=None):
        self.updated.append((id, fields, user_name))
        node = self.nodes[id]
        memory = fields.pop("memory", node["memory"])
        node["memory"] = memory
        node["metadata"].update(fields)


class FakeEmbedder:
    def embed(self, texts):
        return [[float(len(text)), 0.1] for text in texts]


class FakeLLM:
    def generate(self, messages):
        assert "Return strict JSON only" in messages[0]["content"]
        return json.dumps(
            {
                "key": "MemOS Dream Context",
                "memory": "The user is designing the MemOS Dream Context pipeline.",
                "confidence": 0.91,
            }
        )


class FakeBindingAndSummaryLLM:
    def __init__(self):
        self.calls: list[str] = []

    def generate(self, messages):
        prompt = messages[0]["content"]
        self.calls.append(prompt)
        if '"unassigned_ids"' in prompt:
            assert "ID: m1" in prompt
            assert "ID: m2" in prompt
            assert "ID: m3" in prompt
            assert "real_ids=[" in prompt
            return json.dumps(
                {
                    "contexts": [
                        {
                            "key": "Dream Enricher Design",
                            "ids": ["m1", "m3"],
                            "confidence": 0.88,
                            "reason": "same implementation thread",
                        }
                    ],
                    "unassigned_ids": ["m2"],
                }
            )
        return json.dumps(
            {
                "key": "Summary Key",
                "memory": "Summary text",
                "confidence": 0.8,
            }
        )


def _memory_node(node_id: str, weak_context_id: str | None = "project:memos") -> dict:
    dream = {"weak_context_id": weak_context_id} if weak_context_id else {}
    return {
        "id": node_id,
        "memory": f"Memory {node_id} about Dream Context.",
        "metadata": {
            "memory_type": "LongTermMemory",
            "status": "activated",
            "created_at": f"2026-05-18T00:00:0{node_id[-1]}",
            "internal_info": {"dream": dream},
        },
    }


def _context_node() -> dict:
    return {
        "id": "ctx_existing",
        "memory": "Old summary",
        "metadata": {
            "memory_type": CONTEXT_MEMORY_TYPE,
            "status": "activated",
            "key": "Old Context",
            "created_at": "2026-05-17T00:00:00",
            "internal_info": json.dumps(
                {
                    "dream": {
                        "kind": "context",
                        "memory_ids": ["m0"],
                        "weak_context_ids": ["project:memos"],
                    }
                }
            ),
        },
    }


def test_contextualizer_skips_project_pool_when_binding_llm_unavailable():
    graph = FakeGraphDB(nodes=[_memory_node("m1"), _memory_node("m2")])
    contextualizer = DreamContextualizer(
        enabled=True,
        binding_llm_enabled=False,
        summary_llm_enabled=True,
    )
    contextualizer.bind_context(
        {"shared": {"graph_db": graph, "embedder": FakeEmbedder(), "llm": FakeLLM()}}
    )

    report = contextualizer.run(
        signal_snapshot=DreamSignalSnapshot(mem_cube_id="cube-a", pending_memory_ids=["m1", "m2"]),
        text_mem=None,
        cube_id="cube-a",
    )

    assert report.created_context_count == 0
    assert report.bound_memory_count == 0
    assert report.skipped_memory_count == 2
    assert graph.added == []


def test_contextualizer_uses_short_ids_for_llm_binding_and_maps_back_to_real_ids():
    graph = FakeGraphDB(
        nodes=[
            _memory_node("uuid-alpha-1", "session:s1"),
            _memory_node("uuid-beta-2", "session:s1"),
            _memory_node("uuid-alpha-3", "session:s1"),
        ]
    )
    llm = FakeBindingAndSummaryLLM()
    contextualizer = DreamContextualizer(
        enabled=True,
        binding_llm_enabled=True,
        summary_llm_enabled=True,
    )
    contextualizer.bind_context(
        {"shared": {"graph_db": graph, "embedder": FakeEmbedder(), "llm": llm}}
    )

    report = contextualizer.run(
        signal_snapshot=DreamSignalSnapshot(
            mem_cube_id="cube-a",
            pending_memory_ids=["uuid-alpha-1", "uuid-beta-2", "uuid-alpha-3"],
        ),
        text_mem=None,
        cube_id="cube-a",
    )

    assert report.created_context_count == 1
    assert report.bound_memory_count == 2
    assert report.skipped_memory_count == 1
    grouped_ids = [
        metadata["internal_info"]["dream"]["memory_ids"] for _, _, metadata, _ in graph.added
    ]
    assert ["uuid-alpha-1", "uuid-alpha-3"] in grouped_ids
    assert ["uuid-beta-2"] not in grouped_ids
    assert any(ctx["strategy"] == "llm" for ctx in report.contexts)
    assert "uuid-alpha-1" in llm.calls[0]
    assert "ids" in llm.calls[0]


def test_contextualizer_persists_batch_memories_without_llm_binding():
    graph = FakeGraphDB(
        nodes=[
            _memory_node("chunk-1", "batch:file-1"),
            _memory_node("chunk-2", "batch:file-1"),
            _memory_node("other-3", "batch:file-1"),
        ]
    )
    contextualizer = DreamContextualizer(
        enabled=True,
        binding_llm_enabled=False,
        summary_llm_enabled=False,
    )
    contextualizer.bind_context({"shared": {"graph_db": graph, "embedder": FakeEmbedder()}})

    report = contextualizer.run(
        signal_snapshot=DreamSignalSnapshot(
            mem_cube_id="cube-a",
            pending_memory_ids=["chunk-1", "chunk-2", "other-3"],
        ),
        text_mem=None,
        cube_id="cube-a",
    )

    assert report.created_context_count == 1
    assert report.bound_memory_count == 3
    assert len(graph.added) == 1
    assert graph.added[0][2]["internal_info"]["dream"]["memory_ids"] == [
        "chunk-1",
        "chunk-2",
        "other-3",
    ]
    assert graph.added[0][2]["internal_info"]["dream"]["binding"]["strategy"] == "batch"


def test_contextualizer_skips_singleton_even_when_existing_context_matches_weak_id():
    graph = FakeGraphDB(nodes=[_memory_node("m1"), _context_node()])
    contextualizer = DreamContextualizer(enabled=True, summary_llm_enabled=False)
    contextualizer.bind_context({"shared": {"graph_db": graph, "embedder": FakeEmbedder()}})

    report = contextualizer.run(
        signal_snapshot=DreamSignalSnapshot(mem_cube_id="cube-a", pending_memory_ids=["m1"]),
        text_mem=None,
        cube_id="cube-a",
    )

    assert report.updated_context_count == 0
    assert report.bound_memory_count == 0
    assert report.skipped_memory_count == 1
    assert not graph.updated
    assert graph.added == []


def test_contextualizer_skips_unbound_memories_instead_of_singletons():
    graph = FakeGraphDB(nodes=[_memory_node("m1", None), _memory_node("m2", None)])
    contextualizer = DreamContextualizer(enabled=True, summary_llm_enabled=False)
    contextualizer.bind_context({"shared": {"graph_db": graph, "embedder": FakeEmbedder()}})

    report = contextualizer.run(
        signal_snapshot=DreamSignalSnapshot(mem_cube_id="cube-a", pending_memory_ids=["m1", "m2"]),
        text_mem=None,
        cube_id="cube-a",
    )

    assert report.created_context_count == 0
    assert report.bound_memory_count == 0
    assert report.skipped_memory_count == 2
    assert graph.added == []


def test_contextualizer_skips_oversized_project_pool_without_fallback_context():
    nodes = [_memory_node(f"m{idx}") for idx in range(1, 5)]
    graph = FakeGraphDB(nodes=nodes)
    contextualizer = DreamContextualizer(
        enabled=True,
        binding_llm_enabled=True,
        summary_llm_enabled=False,
        binding_max_group_size=3,
    )
    contextualizer.bind_context(
        {
            "shared": {
                "graph_db": graph,
                "embedder": FakeEmbedder(),
                "llm": FakeBindingAndSummaryLLM(),
            }
        }
    )

    report = contextualizer.run(
        signal_snapshot=DreamSignalSnapshot(
            mem_cube_id="cube-a",
            pending_memory_ids=[node["id"] for node in nodes],
        ),
        text_mem=None,
        cube_id="cube-a",
    )

    assert report.created_context_count == 0
    assert report.bound_memory_count == 0
    assert report.skipped_memory_count == 4
    assert graph.added == []


def test_context_memory_type_is_valid_textual_metadata():
    metadata = TreeNodeTextualMemoryMetadata(memory_type="Context")
    assert metadata.memory_type == "Context"
