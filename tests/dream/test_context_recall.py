from __future__ import annotations

from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import APISearchRequest
from memos.dream.search import DreamContextSearchExtension
from memos.plugins.hook_defs import H
from memos.plugins.hooks import _hooks, register_hook


class FakeEmbedder:
    def __init__(self):
        self.calls: list[list[str]] = []

    def embed(self, texts):
        self.calls.append(texts)
        return [[0.1, 0.2, 0.3] for _ in texts]


class FailingEmbedder:
    def embed(self, texts):
        raise RuntimeError("embed failed")


class FakeGraphDB:
    def __init__(self, hits=None):
        self.hits = hits or []
        self.calls: list[dict] = []

    def search_by_embedding(self, vector, **kwargs):
        self.calls.append({"vector": vector, **kwargs})
        return self.hits


class FakeCubeView:
    def __init__(self, results=None):
        self.results = results or _empty_results()

    def search_memories(self, search_req):
        return self.results


def _empty_results():
    return {
        "text_mem": [],
        "act_mem": [],
        "para_mem": [],
        "pref_mem": [],
        "pref_note": "",
        "tool_mem": [],
        "skill_mem": [],
    }


def _handler(*, graph_db=None, embedder=None, cube_view=None) -> SearchHandler:
    embedder = embedder or FakeEmbedder()
    handler = SearchHandler(
        HandlerDependencies(
            naive_mem_cube=object(),
            mem_scheduler=object(),
            searcher=type("FakeSearcher", (), {"embedder": embedder})(),
            deepsearch_agent=object(),
            graph_db=graph_db,
            embedder=embedder,
        )
    )
    handler._build_cube_view = lambda _search_req: cube_view or FakeCubeView()
    return handler


def _search_req():
    return APISearchRequest(
        query="what is the user designing?",
        user_id="user-a",
        readable_cube_ids=["cube-a"],
        top_k=5,
        relativity=0,
        dedup="no",
    )


def setup_function():
    _hooks.clear()


def test_context_recall_disabled_without_dream_search_hook():
    graph = FakeGraphDB(
        hits=[
            {
                "id": "ctx_1",
                "memory": "Context summary",
                "score": 0.9,
            }
        ]
    )
    handler = _handler(graph_db=graph)

    response = handler.handle_search_memories(_search_req())

    assert graph.calls == []
    assert response.data["text_mem"] == []


def test_context_recall_searches_context_scope_and_returns_summary():
    register_hook(
        H.SEARCH_MEMORY_RESULTS,
        DreamContextSearchExtension(top_k=1).merge_context_recall,
    )
    graph = FakeGraphDB(
        hits=[
            {
                "id": "ctx_1",
                "memory": "The user is designing Dream Context recall.",
                "score": 0.93,
                "key": "Dream context recall",
                "source": "system",
                "internal_info": {"dream": {"memory_ids": ["m1", "m2"]}},
            }
        ]
    )
    handler = _handler(graph_db=graph)

    response = handler.handle_search_memories(_search_req())

    assert graph.calls
    assert graph.calls[0]["scope"] == "Context"
    assert graph.calls[0]["status"] == "activated"
    assert graph.calls[0]["top_k"] == 1
    assert graph.calls[0]["user_name"] == "cube-a"
    assert graph.calls[0]["return_fields"] == [
        "memory",
        "key",
        "created_at",
        "updated_at",
        "source",
        "internal_info",
    ]

    text_mem = response.data["text_mem"]
    assert len(text_mem) == 1
    memories = text_mem[0]["memories"]
    assert len(memories) == 1
    assert memories[0]["id"] == "ctx_1"
    assert memories[0]["memory"] == "The user is designing Dream Context recall."
    assert memories[0]["metadata"]["memory_type"] == "Context"
    assert memories[0]["metadata"]["key"] == "Dream context recall"
    assert memories[0]["metadata"]["relativity"] == 0.93
    assert memories[0]["metadata"]["internal_info"] == {"dream": {"memory_ids": ["m1", "m2"]}}


def test_context_recall_gracefully_skips_without_graph_db():
    register_hook(
        H.SEARCH_MEMORY_RESULTS,
        DreamContextSearchExtension(top_k=1).merge_context_recall,
    )
    handler = _handler(graph_db=None)

    response = handler.handle_search_memories(_search_req())

    assert response.data["text_mem"] == []


def test_context_recall_gracefully_skips_on_embedding_failure():
    register_hook(
        H.SEARCH_MEMORY_RESULTS,
        DreamContextSearchExtension(top_k=1).merge_context_recall,
    )
    graph = FakeGraphDB()
    handler = _handler(graph_db=graph, embedder=FailingEmbedder())

    response = handler.handle_search_memories(_search_req())

    assert graph.calls == []
    assert response.data["text_mem"] == []
