from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.api.config import APIConfig
from memos.exceptions import GraphDBError
from memos.mem_cube.general import GeneralMemCube
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.simple_tree import SimpleTreeTextMemory
from memos.memories.textual.tree import TreeTextMemory


@pytest.fixture
def tree_config(monkeypatch):
    monkeypatch.setenv("GRAPH_DB_BACKEND", "neo4j-community")
    monkeypatch.setenv("MOS_ENABLE_DEFAULT_CUBE_CONFIG", "true")
    monkeypatch.setenv("ENABLE_INTERNET", "false")
    monkeypatch.setenv("ENABLE_ACTIVATION_MEMORY", "false")
    monkeypatch.setenv("ENABLE_PREFERENCE_MEMORY", "false")
    return APIConfig.get_default_cube_config().text_mem.config


@pytest.fixture
def tree_factories(monkeypatch):
    import memos.memories.textual.tree as module

    for name in (
        "LLMFactory",
        "EmbedderFactory",
        "GraphStoreFactory",
        "RerankerFactory",
        "InternetRetrieverFactory",
    ):
        monkeypatch.setattr(getattr(module, name), "from_config", Mock(return_value=Mock()))
    monkeypatch.setattr(module, "MemoryManager", Mock())
    return module


def test_tree_owns_graph_and_retries_close(tree_config, tree_factories):
    tree = TreeTextMemory(tree_config)
    tree.graph_store.close.side_effect = [GraphDBError("close"), None]
    with pytest.raises(GraphDBError):
        tree.close()
    tree.close()
    tree.close()
    assert tree.graph_store.close.call_count == 2


@pytest.mark.parametrize("stage", ["RerankerFactory", "MemoryManager"])
def test_tree_construction_failure_releases_graph(tree_config, tree_factories, stage):
    target = getattr(tree_factories, stage)
    if stage.endswith("Factory"):
        target = target.from_config
    error = ValueError("consumer failed")
    target.side_effect = error
    with pytest.raises(ValueError) as raised:
        TreeTextMemory(tree_config)
    assert raised.value is error
    tree_factories.GraphStoreFactory.from_config.return_value.close.assert_called_once_with()


def test_simple_tree_borrows_graph(tree_config):
    graph = Mock()
    tree = SimpleTreeTextMemory(Mock(), Mock(), Mock(), graph, Mock(), Mock(), tree_config)
    tree.close()
    tree.close()
    graph.close.assert_not_called()


def cube_config(*backends):
    return SimpleNamespace(
        **{
            name: SimpleNamespace(backend=backend)
            for name, backend in zip(
                ("text_mem", "act_mem", "para_mem", "pref_mem"), backends, strict=True
            )
        }
    )


def test_cube_keeps_replaced_owned_memory_and_deduplicates(monkeypatch):
    owned = Mock(spec=BaseTextMemory)
    owned.close = Mock()
    borrowed = Mock(spec=BaseTextMemory)
    borrowed.close = Mock()
    monkeypatch.setattr(
        "memos.mem_cube.general.MemoryFactory.from_config", Mock(return_value=owned)
    )
    cube = GeneralMemCube(cube_config("tree_text", "uninitialized", "uninitialized", "tree_text"))
    cube.text_mem = borrowed
    cube.close()
    cube.close()
    owned.close.assert_called_once_with()
    borrowed.close.assert_not_called()


def test_cube_partial_construction_closes_created_memory(monkeypatch):
    first = Mock()
    error = ValueError("second failed")
    monkeypatch.setattr(
        "memos.mem_cube.general.MemoryFactory.from_config", Mock(side_effect=[first, error])
    )
    with pytest.raises(ValueError) as raised:
        GeneralMemCube(cube_config("tree_text", "kv_cache", "uninitialized", "uninitialized"))
    assert raised.value is error
    first.close.assert_called_once_with()


def test_cube_load_failure_closes_new_cube(monkeypatch):
    config = cube_config("tree_text", "uninitialized", "uninitialized", "uninitialized")
    monkeypatch.setattr(
        "memos.mem_cube.general.GeneralMemCubeConfig.from_json_file", lambda _: config
    )
    memory = Mock()
    monkeypatch.setattr(
        "memos.mem_cube.general.MemoryFactory.from_config", Mock(return_value=memory)
    )
    error = GraphDBError("restore failed")
    monkeypatch.setattr(GeneralMemCube, "load", Mock(side_effect=error))
    with pytest.raises(GraphDBError) as raised:
        GeneralMemCube.init_from_dir("unused")
    assert raised.value is error
    memory.close.assert_called_once_with()


def test_cube_close_continues_after_failure_and_retries_only_failed_memory(monkeypatch):
    first, second, legacy = Mock(), Mock(), SimpleNamespace()
    first.close.side_effect = [GraphDBError("close failed"), None]
    monkeypatch.setattr(
        "memos.mem_cube.general.MemoryFactory.from_config",
        Mock(side_effect=[first, second, legacy]),
    )
    cube = GeneralMemCube(cube_config("a", "b", "c", "uninitialized"))
    with pytest.raises(GraphDBError):
        cube.close()
    second.close.assert_called_once_with()
    cube.close()
    second.close.assert_called_once_with()
    assert first.close.call_count == 2


def test_cube_construct_and_restore_keep_primary_error_on_cleanup_failure(monkeypatch):
    memory = Mock(close=Mock(side_effect=GraphDBError("cleanup")))
    failure = ValueError("construct")
    factory = Mock(side_effect=[memory, failure])
    monkeypatch.setattr("memos.mem_cube.general.MemoryFactory.from_config", factory)
    with pytest.raises(ValueError) as raised:
        GeneralMemCube(cube_config("a", "b", "uninitialized", "uninitialized"))
    assert raised.value is failure
    config = cube_config("a", "uninitialized", "uninitialized", "uninitialized")
    monkeypatch.setattr(
        "memos.mem_cube.general.GeneralMemCubeConfig.from_json_file", lambda _: config
    )
    factory.side_effect = None
    factory.return_value = memory
    monkeypatch.setattr(GeneralMemCube, "load", Mock(side_effect=failure))
    with pytest.raises(ValueError) as raised:
        GeneralMemCube.init_from_dir("unused")
    assert raised.value is failure


def test_cube_load_success_and_default_config_merge(monkeypatch):
    config = cube_config("uninitialized", "uninitialized", "uninitialized", "uninitialized")
    config.cube_id = "C"
    monkeypatch.setattr(
        "memos.mem_cube.general.GeneralMemCubeConfig.from_json_file", lambda _: config
    )
    merge = Mock(return_value=config)
    monkeypatch.setattr("memos.mem_cube.general.merge_config_with_default", merge)
    load = Mock()
    monkeypatch.setattr(GeneralMemCube, "load", load)
    cube = GeneralMemCube.init_from_dir("unused", ["text_mem"], default_config=config)
    assert cube.config is config
    merge.assert_called_once_with(config, config)
    load.assert_called_once_with("unused", ["text_mem"])
    cube.close()


def test_tree_optional_internet_and_cleanup_failure(tree_config, tree_factories):
    tree_config.internet_retriever = SimpleNamespace(backend="test")
    tree = TreeTextMemory(tree_config)
    assert (
        tree.internet_retriever is tree_factories.InternetRetrieverFactory.from_config.return_value
    )
    tree.close()
    graph = tree_factories.GraphStoreFactory.from_config.return_value
    graph.close.side_effect = GraphDBError("cleanup")
    primary = ValueError("internet")
    tree_factories.InternetRetrieverFactory.from_config.side_effect = primary
    with pytest.raises(ValueError) as raised:
        TreeTextMemory(tree_config)
    assert raised.value is primary
    borrowed = SimpleTreeTextMemory(
        Mock(), Mock(), Mock(), graph, Mock(), Mock(), tree_config, internet_retriever="existing"
    )
    assert borrowed.internet_retriever == "existing"
    borrowed.close()
