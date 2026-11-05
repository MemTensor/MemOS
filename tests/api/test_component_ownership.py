"""Owned API resources survive failures only until their close can be retried."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from memos.api.handlers import component_init
from memos.api.lifecycle import shutdown_components
from memos.exceptions import GraphDBError, MemOSError
from memos.mem_scheduler.general_modules import init_components_for_scheduler as standalone


@pytest.mark.parametrize("scheduler", [None, SimpleNamespace(), SimpleNamespace(close=None)])
def test_api_closes_graph_without_active_scheduler(scheduler):
    graph = Mock()
    components = {"graph_db": graph, "mem_scheduler": scheduler}
    shutdown_components(components)
    shutdown_components(components)
    graph.close.assert_called_once_with()


def test_api_waits_for_scheduler_and_retries_failed_cleanup():
    calls = []
    failure = GraphDBError("cannot stop")
    scheduler = Mock(close=Mock(side_effect=[failure, None]))
    graph = Mock(close=Mock(side_effect=lambda: calls.append("graph")))
    components = {"graph_db": graph, "mem_scheduler": scheduler}
    with pytest.raises(MemOSError):
        shutdown_components(components)
    graph.close.assert_not_called()
    shutdown_components(components)
    assert calls == ["graph"]
    assert scheduler.close.call_count == 2


def test_api_retries_only_graph_after_scheduler_succeeded():
    graph = Mock(close=Mock(side_effect=[GraphDBError("pool"), None]))
    scheduler = Mock()
    components = {"graph_db": graph, "mem_scheduler": scheduler}
    with pytest.raises(MemOSError):
        shutdown_components(components)
    shutdown_components(components)
    scheduler.close.assert_called_once_with()
    assert graph.close.call_count == 2


@pytest.mark.parametrize("failure", [None, GraphDBError("close failed")])
def test_concurrent_api_close_waits_for_same_result(failure):
    entered, release, joined = Event(), Event(), Event()

    def close():
        entered.set()
        assert release.wait(3)
        if failure:
            raise failure

    graph = Mock(close=Mock(side_effect=close))
    components = {"graph_db": graph}

    def concurrent():
        joined.set()
        shutdown_components(components)

    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(shutdown_components, components)
        assert entered.wait(3)
        second = pool.submit(concurrent)
        assert joined.wait(3)
        assert not second.done()
        release.set()
        for future in (first, second):
            if failure:
                with pytest.raises(MemOSError):
                    future.result(3)
            else:
                future.result(3)
    graph.close.assert_called_once_with()


def prepare_components(monkeypatch, module):
    """Mock model/services at their factories, keep the assembly function real."""
    config = SimpleNamespace(text_mem=SimpleNamespace(config=SimpleNamespace()))
    monkeypatch.setattr(module.APIConfig, "get_default_cube_config", lambda: config)
    monkeypatch.setattr(module.APIConfig, "is_dingding_bot_enabled", lambda: False)
    monkeypatch.setattr(
        module.APIConfig, "get_scheduler_config", lambda: {"backend": "optimized", "config": {}}
    )
    for name in vars(module):
        if name.startswith("build_") and name.endswith("_config"):
            monkeypatch.setattr(module, name, Mock(return_value={}))
    graph = Mock()
    monkeypatch.setattr(module.GraphStoreFactory, "from_config", Mock(return_value=graph))
    for factory in (
        "LLMFactory",
        "EmbedderFactory",
        "MemReaderFactory",
        "RerankerFactory",
        "InternetRetrieverFactory",
    ):
        monkeypatch.setattr(getattr(module, factory), "from_config", Mock(return_value=Mock()))
    for name in (
        "MemoryManager",
        "FastTokenizer",
        "SimpleTreeTextMemory",
        "NaiveMemCube",
        "SimpleMemFeedback",
    ):
        monkeypatch.setattr(module, name, Mock(return_value=Mock()))
    monkeypatch.setattr(module, "build_plugin_context", Mock(return_value={"shared": {}}))
    monkeypatch.setattr(module.plugin_manager, "discover", Mock())
    monkeypatch.setattr(module.plugin_manager, "init_components", Mock())
    monkeypatch.setenv("MEMSCHEDULER_USE_REDIS_QUEUE", "false")
    monkeypatch.setenv("ENABLE_CHAT_API", "false")
    if module is component_init:
        monkeypatch.setattr(module, "SchedulerConfigFactory", Mock())
        monkeypatch.setattr(module.SchedulerFactory, "from_config", Mock(return_value=Mock()))
        monkeypatch.setattr(module.BaseDBManager, "create_default_sqlite_engine", Mock())
        monkeypatch.setattr(module, "DeepSearchMemAgent", Mock())
    else:
        monkeypatch.setattr(
            "memos.mem_scheduler.orm_modules.api_redis_model.APIRedisDBManager.load_redis_engine_from_env",
            Mock(return_value=None),
        )
    return graph


@pytest.mark.parametrize("module", [component_init, standalone])
@pytest.mark.parametrize(
    "stage",
    [
        "LLMFactory",
        "EmbedderFactory",
        "MemReaderFactory",
        "RerankerFactory",
        "InternetRetrieverFactory",
        "MemoryManager",
        "FastTokenizer",
        "SimpleTreeTextMemory",
        "NaiveMemCube",
        "SimpleMemFeedback",
        "plugin_manager",
    ],
)
def test_assembly_failure_closes_owned_graph(monkeypatch, module, stage):
    graph = prepare_components(monkeypatch, module)
    error = ValueError("construction failed")
    target = getattr(module, stage)
    if stage.endswith("Factory"):
        target.from_config.side_effect = error
    elif stage == "plugin_manager":
        target.init_components.side_effect = error
    else:
        target.side_effect = error
    initialize = module.init_server if module is component_init else module.init_components
    with pytest.raises(ValueError) as raised:
        initialize()
    assert raised.value is error
    graph.close.assert_called_once_with()


@pytest.mark.parametrize("module", [component_init, standalone])
def test_successful_assembly_retains_graph_ownership(monkeypatch, module):
    graph = prepare_components(monkeypatch, module)
    initialize = module.init_server if module is component_init else module.init_components
    components = initialize()
    assert components["graph_db"] is graph
    graph.close.assert_not_called()
    shutdown_components(components)
    graph.close.assert_called_once_with()


@pytest.mark.parametrize("stage", ["initialize_modules", "init_mem_cube", "start"])
def test_api_failed_scheduler_is_closed_before_graph(monkeypatch, stage):
    graph = prepare_components(monkeypatch, component_init)
    scheduler = component_init.SchedulerFactory.from_config.return_value
    error = ValueError("scheduler failed")
    getattr(scheduler, stage).side_effect = error
    monkeypatch.setenv("API_SCHEDULER_ON", "true")
    calls = []
    scheduler.close.side_effect = lambda: calls.append("scheduler")
    graph.close.side_effect = lambda: calls.append("graph")
    with pytest.raises(ValueError) as raised:
        component_init.init_server()
    assert raised.value is error
    assert calls == ["scheduler", "graph"]


def test_cleanup_error_does_not_replace_construction_error(monkeypatch):
    graph = prepare_components(monkeypatch, component_init)
    original = ValueError("model failed")
    component_init.LLMFactory.from_config.side_effect = original
    graph.close.side_effect = GraphDBError("cleanup failed")
    with pytest.raises(ValueError) as raised:
        component_init.init_server()
    assert raised.value is original


def test_legacy_graph_without_close_is_compatible():
    shutdown_components({"graph_db": SimpleNamespace()})
    shutdown_components(None)
    shutdown_components({})


@pytest.mark.parametrize("module", [component_init, standalone])
@pytest.mark.parametrize("redis_result", [None, True, ValueError("unavailable")])
def test_redis_initialization_does_not_bypass_graph_cleanup(monkeypatch, module, redis_result):
    graph = prepare_components(monkeypatch, module)
    monkeypatch.setenv("MEMSCHEDULER_USE_REDIS_QUEUE", "true")
    redis = (
        Mock(side_effect=redis_result)
        if isinstance(redis_result, Exception)
        else Mock(return_value=redis_result)
    )
    monkeypatch.setattr(
        "memos.mem_scheduler.orm_modules.api_redis_model.APIRedisDBManager.load_redis_engine_from_env",
        redis,
    )
    initialize = module.init_server if module is component_init else module.init_components
    components = initialize()
    shutdown_components(components)
    graph.close.assert_called_once_with()


@pytest.mark.parametrize("chat", [False, True])
def test_api_optional_components_and_disabled_scheduler(monkeypatch, chat):
    graph = prepare_components(monkeypatch, component_init)
    monkeypatch.setenv("API_SCHEDULER_ON", "false")
    monkeypatch.setenv("ENABLE_CHAT_API", str(chat).lower())
    monkeypatch.setattr(
        component_init,
        "build_chat_llm_config",
        Mock(return_value=[{"config_class": {}, "support_models": ["example"]}]),
    )
    monkeypatch.setattr(component_init.APIConfig, "is_dingding_bot_enabled", lambda: True)
    bot = Mock()
    monkeypatch.setattr(
        "memos.memos_tools.notification_service.get_online_bot_function", lambda: bot
    )
    components = component_init.init_server()
    assert components["online_bot"] is bot
    assert (components["chat_llms"] is not None) == chat
    components["mem_scheduler"].start.assert_not_called()
    shutdown_components(components)
    graph.close.assert_called_once_with()


def test_standalone_preserves_original_error_when_cleanup_fails(monkeypatch):
    graph = prepare_components(monkeypatch, standalone)
    original = ValueError("model failed")
    standalone.LLMFactory.from_config.side_effect = original
    graph.close.side_effect = GraphDBError("cleanup failed")
    with pytest.raises(ValueError) as raised:
        standalone.init_components()
    assert raised.value is original
