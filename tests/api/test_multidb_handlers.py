from unittest.mock import Mock, patch

from memos.api.handlers.add_handler import AddHandler
from memos.api.handlers.base_handler import HandlerDependencies
from memos.api.handlers.search_handler import SearchHandler
from memos.api.product_models import APIADDRequest, APISearchRequest
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView


def _build_dependencies() -> HandlerDependencies:
    return HandlerDependencies(
        llm=Mock(name="llm"),
        naive_mem_cube=Mock(name="naive_mem_cube"),
        mem_reader=Mock(name="mem_reader"),
        mem_scheduler=Mock(name="mem_scheduler"),
        searcher=Mock(name="searcher"),
        deepsearch_agent=Mock(name="deepsearch_agent"),
        feedback_server=Mock(name="feedback_server"),
        reranker=Mock(name="reranker"),
        embedder=Mock(name="embedder"),
        internet_retriever=Mock(name="internet_retriever"),
        default_cube_config=Mock(name="default_cube_config"),
    )


def test_add_handler_build_cube_view_uses_per_user_components(monkeypatch):
    monkeypatch.setenv("GRAPH_DB_BACKEND", "neo4j")
    monkeypatch.setenv("MOS_NEO4J_SHARED_DB", "false")

    handler = AddHandler(_build_dependencies())
    per_user_naive = Mock(name="per_user_naive")
    per_user_reader = Mock(name="per_user_reader")

    with patch("memos.api.handlers.add_handler.create_per_db_components") as create_components:
        create_components.return_value = {
            "naive_mem_cube": per_user_naive,
            "mem_reader": per_user_reader,
        }
        req = APIADDRequest(user_id="alice", memory_content="hello")

        cube_view = handler._build_cube_view(req)

    assert isinstance(cube_view, SingleCubeView)
    assert cube_view.naive_mem_cube is per_user_naive
    assert cube_view.mem_reader is per_user_reader
    create_components.assert_called_once()
    assert create_components.call_args.kwargs["db_name"] == "alice"


def test_add_handler_per_user_component_cache(monkeypatch):
    monkeypatch.setenv("GRAPH_DB_BACKEND", "neo4j")
    monkeypatch.setenv("MOS_NEO4J_SHARED_DB", "false")

    handler = AddHandler(_build_dependencies())
    with patch("memos.api.handlers.add_handler.create_per_db_components") as create_components:
        create_components.return_value = {
            "naive_mem_cube": Mock(),
            "mem_reader": Mock(),
        }

        first = handler._get_per_user_components("alice")
        second = handler._get_per_user_components("alice")

    assert first is second
    create_components.assert_called_once()


def test_search_handler_build_cube_view_uses_per_db_components(monkeypatch):
    monkeypatch.setenv("GRAPH_DB_BACKEND", "neo4j")
    monkeypatch.setenv("MOS_NEO4J_SHARED_DB", "false")

    handler = SearchHandler(_build_dependencies())

    per_db_components = {
        "cube_a": {
            "naive_mem_cube": Mock(name="naive_a"),
            "mem_reader": Mock(name="reader_a"),
            "searcher": Mock(name="searcher_a"),
            "text_mem": Mock(name="text_mem_a"),
        },
        "cube_b": {
            "naive_mem_cube": Mock(name="naive_b"),
            "mem_reader": Mock(name="reader_b"),
            "searcher": Mock(name="searcher_b"),
            "text_mem": Mock(name="text_mem_b"),
        },
    }

    with (
        patch("memos.api.handlers.search_handler.create_per_db_components") as create_components,
        patch("memos.api.handlers.search_handler.DeepSearchMemAgent") as deepsearch_agent_cls,
    ):
        create_components.side_effect = lambda db_name, base_components: per_db_components[db_name]
        deepsearch_agent_cls.side_effect = [Mock(name="agent_a"), Mock(name="agent_b")]

        req = APISearchRequest(query="hello", user_id="alice", readable_cube_ids=["cube_a", "cube_b"])
        cube_view = handler._build_cube_view(req)

    assert isinstance(cube_view, CompositeCubeView)
    assert len(cube_view.cube_views) == 2
    first, second = cube_view.cube_views
    assert first.cube_id == "cube_a"
    assert first.searcher is per_db_components["cube_a"]["searcher"]
    assert first.deepsearch_agent is per_db_components["cube_a"]["deepsearch_agent"]
    assert second.cube_id == "cube_b"
    assert second.searcher is per_db_components["cube_b"]["searcher"]
    assert second.deepsearch_agent is per_db_components["cube_b"]["deepsearch_agent"]


def test_search_handler_per_db_component_cache(monkeypatch):
    monkeypatch.setenv("GRAPH_DB_BACKEND", "neo4j")
    monkeypatch.setenv("MOS_NEO4J_SHARED_DB", "false")

    handler = SearchHandler(_build_dependencies())

    with (
        patch("memos.api.handlers.search_handler.create_per_db_components") as create_components,
        patch("memos.api.handlers.search_handler.DeepSearchMemAgent") as deepsearch_agent_cls,
    ):
        create_components.return_value = {
            "naive_mem_cube": Mock(),
            "mem_reader": Mock(),
            "searcher": Mock(),
            "text_mem": Mock(),
        }
        deepsearch_agent_cls.return_value = Mock(name="agent")

        first = handler._get_per_db_components("cube_a")
        second = handler._get_per_db_components("cube_a")

    assert first is second
    create_components.assert_called_once()
    deepsearch_agent_cls.assert_called_once()
