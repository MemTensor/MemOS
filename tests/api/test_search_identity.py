"""Cross-Cube identity, stable fan-out and required storage failure propagation."""

from copy import deepcopy
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.api.handlers.formatters_handler import rerank_knowledge_mem
from memos.api.product_models import APISearchRequest
from memos.exceptions import GraphDBError
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.types.general_types import UserContext


def item(key, text, source=None, score=0.5):
    return {
        "id": key,
        "memory": text,
        "metadata": {
            "memory_type": "LongTermMemory",
            "relativity": score,
            "sources": [] if source is None else [{"type": "file", "content": source}],
        },
    }


@pytest.mark.parametrize("query,prefix", [("question", "Memory: "), ("是什么记忆", "记忆：")])
@pytest.mark.parametrize("strip", [False, True])
def test_formatter_preserves_original_cube_per_record(query, prefix, strip):
    groups = [
        {
            "cube_id": "A",
            "memories": [item("same", "alpha", "source alpha", 0.9), item("chat", "chat A")],
        },
        {
            "cube_id": "B",
            "memories": [item("same", "beta", "source beta", 0.8), item("chat", "chat B")],
        },
        {"cube_id": "C", "memories": [item("duplicate", "alpha", "source alpha", 0.7)]},
    ]
    result = rerank_knowledge_mem(None, query, groups, top_k=4, strip_conversation_sources=strip)
    assert [(b["cube_id"], [m["id"] for m in b["memories"]]) for b in result] == [
        ("A", ["same", "chat"]),
        ("B", ["same", "chat"]),
    ]
    assert result[0]["memories"][0]["memory"].startswith(prefix + "alpha")
    assert result[1]["memories"][0]["metadata"]["relativity"] == 0.8
    assert result[0]["memories"][0]["metadata"]["sources"] == []


def test_formatter_empty_and_quota():
    assert rerank_knowledge_mem(None, "query", [], 3) == []
    groups = [
        {
            "cube_id": "A",
            "memories": [
                item("one", "one", "file"),
                item("two", "two", "file"),
                item("three", "conversation"),
            ],
        }
    ]
    result = rerank_knowledge_mem(None, "query", groups, 2)
    assert [m["id"] for m in result[0]["memories"]] == ["one", "three"]


def test_composite_preserves_deduplicated_request_order_when_completion_reverses():
    finished_b = Event()

    def search(owner):
        if owner == "A":
            assert finished_b.wait(3)
        else:
            finished_b.set()
        return {
            "text_mem": [{"cube_id": owner, "memories": [item("same", owner)]}],
            "pref_note": owner,
        }

    views = [
        SimpleNamespace(
            cube_id=owner, search_memories=Mock(side_effect=lambda req, owner=owner: search(owner))
        )
        for owner in ["A", "B", "A"]
    ]
    result = CompositeCubeView(views, Mock()).search_memories(Mock())
    assert [b["cube_id"] for b in result["text_mem"]] == ["A", "B"]
    assert result["pref_note"] == "A | B"
    views[2].search_memories.assert_not_called()
    assert CompositeCubeView([], Mock()).search_memories(Mock())["text_mem"] == []
    empty = SimpleNamespace(cube_id="E", search_memories=lambda req: {})
    assert CompositeCubeView([empty], Mock()).search_memories(Mock())["pref_note"] == ""


def view():
    return SingleCubeView("A", Mock(), Mock(), Mock(), Mock(), Mock())


@pytest.mark.parametrize(
    "mode,method", [("fast", "_fast_search"), ("fine", "_fine_search"), ("mixture", "_mix_search")]
)
@pytest.mark.parametrize("error_type", [GraphDBError, ValueError])
def test_required_search_failure_reaches_composite(mode, method, error_type):
    one = view()
    failure = error_type("required Cube failed")
    failure.__cause__ = OSError("database cause")
    setattr(one, method, Mock(side_effect=failure))
    request = APISearchRequest(query="query", user_id="u", readable_cube_ids=["A"], mode=mode)
    with pytest.raises(error_type) as caught:
        CompositeCubeView([one], Mock()).search_memories(request)
    assert caught.value is failure and caught.value.__cause__.args == ("database cause",)


@pytest.mark.parametrize(
    "mode,method", [("fast", "_fast_search"), ("fine", "_fine_search"), ("mixture", "_mix_search")]
)
def test_optional_nonstorage_failure_and_success_keep_existing_behavior(mode, method):
    one = view()
    context = UserContext(user_id="u", mem_cube_id="A", session_id="s")
    setattr(one, method, Mock(return_value=[item("one", "one")]))
    assert one._search_text(Mock(), context, mode)[0]["id"] == "one"
    getattr(one, method).side_effect = RuntimeError("optional external")
    assert one._search_text(Mock(), context, mode) == []
    assert one._search_text(Mock(), context, "unknown") == []


@pytest.mark.parametrize("failure", [GraphDBError("sql"), ValueError("filter")])
def test_keyword_storage_failure_is_not_empty(failure):
    searcher = Searcher.__new__(Searcher)
    searcher.graph_store = Mock(search_by_fulltext=Mock(side_effect=failure))
    searcher._extract_weighted_keyword_terms = Mock(return_value=["alpha"])
    with pytest.raises(type(failure)) as caught:
        searcher._retrieve_from_keyword("query", None, [[1, 0, 0]], 3, "All", user_name="A")
    assert caught.value is failure


@pytest.mark.parametrize(
    "kind,embedding,terms",
    [
        ("WorkingMemory", [[1]], ["x"]),
        ("All", [], ["x"]),
        ("All", [[1]], []),
        ("All", [[1]], ["", " "]),
    ],
)
def test_keyword_early_empty(kind, embedding, terms):
    s = Searcher.__new__(Searcher)
    s.graph_store = Mock()
    s._extract_weighted_keyword_terms = Mock(return_value=terms)
    assert s._retrieve_from_keyword("q", None, embedding, 3, kind, user_name="A") == []
    s.graph_store.search_by_fulltext.assert_not_called()


@pytest.mark.parametrize("hits", [None, [], RuntimeError("optional backend")])
def test_keyword_optional_failure_and_empty(hits):
    s = Searcher.__new__(Searcher)
    s.graph_store = Mock()
    s.graph_store.search_by_fulltext.side_effect = hits if isinstance(hits, Exception) else None
    s.graph_store.search_by_fulltext.return_value = hits
    s._extract_weighted_keyword_terms = Mock(return_value=["x"])
    assert s._retrieve_from_keyword("q", None, [[1]], 3, "LongTermMemory", user_name="A") == []


def test_keyword_merge_and_legacy_decode_shapes(monkeypatch):
    s = Searcher.__new__(Searcher)
    s.graph_store = Mock()
    s._extract_weighted_keyword_terms = Mock(return_value=["o'clock"])
    s.graph_store.search_by_fulltext.side_effect = [
        [{"id": ""}, {"id": "one", "score": 3}, {"id": "two", "score": 2}, {"id": "gone"}],
        [
            {"id": "one", "score": 1},
            {"id": "two", "score": 4},
            {"id": "none", "score": 1},
            {"id": "new", "score": 0.5},
        ],
    ]
    nodes = [
        {"id": "one", "memory": "one", "metadata": {"metadata": {}}},
        {"id": "two", "memory": "two", "metadata": {}},
        {"id": "none", "memory": "none", "metadata": None},
        {"id": "new", "memory": "new"},
    ]
    s.graph_store.get_nodes.return_value = nodes
    original = deepcopy(nodes)
    monkeypatch.setattr(
        "memos.memories.textual.tree_text_memory.retrieve.searcher.TextualMemoryItem.from_dict",
        lambda n: n,
    )
    s._maybe_rerank = Mock(side_effect=lambda *args, **kw: kw["graph_results"])
    result = s._retrieve_from_keyword("q", None, [[1]], 10, "All", user_name="A")
    assert [n["id"] for n in result] == ["two", "one", "none", "new"]
    assert result[0]["metadata"]["keyword_score"] == 4
    assert result[1]["metadata"]["metadata"]["keyword_score"] == 3
    assert nodes == original
    assert s.graph_store.search_by_fulltext.call_args.kwargs["query_words"] == ["'o''clock'"]
    s.graph_store.search_by_fulltext.side_effect = None
    s.graph_store.search_by_fulltext.return_value = [{"id": "gone"}]
    s.graph_store.get_nodes.return_value = None
    assert s._retrieve_from_keyword("q", None, [[1]], 1, "All", user_name="A", rerank=False) == []
