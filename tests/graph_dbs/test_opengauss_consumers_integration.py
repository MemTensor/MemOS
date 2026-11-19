"""Real factory/consumer ownership, using ordinary-role openGauss connections."""

import os
import time

from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock

import pytest

from memos.api.config import APIConfig
from memos.api.handlers import component_init
from memos.api.handlers.config_builders import build_graph_db_config
from memos.api.lifecycle import shutdown_components
from memos.graph_dbs.factory import GraphStoreFactory
from memos.graph_dbs.opengauss import OpenGaussGraphDB
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.general_modules import init_components_for_scheduler as standalone
from memos.memories.textual.tree import TreeTextMemory
from tests.api.test_component_ownership import prepare_components
from tests.graph_dbs.test_opengauss_integration import _query
from tests.graph_dbs.test_opengauss_integration import database as _database


database = _database
pytestmark = pytest.mark.skipif(
    not os.getenv("MEMOS_OPENGAUSS_TEST_CONFIG"), reason="openGauss integration tests not enabled"
)


@pytest.fixture
def environment(monkeypatch, database):
    admin, config = database
    for name, value in {
        "GRAPH_DB_BACKEND": "opengauss",
        "OPENGAUSS_HOST": config.host,
        "OPENGAUSS_PORT": str(config.port),
        "OPENGAUSS_USER": config.user,
        "OPENGAUSS_PASSWORD": config.password,
        "OPENGAUSS_DB": config.db_name,
        "EMBEDDING_DIMENSION": "3",
        "OPENGAUSS_MIN_CONN": "1",
        "OPENGAUSS_MAX_CONN": "2",
        "MOS_ENABLE_DEFAULT_CUBE_CONFIG": "true",
        "ENABLE_INTERNET": "false",
        "ENABLE_ACTIVATION_MEMORY": "false",
        "ENABLE_PREFERENCE_MEMORY": "false",
    }.items():
        monkeypatch.setenv(name, value)
    yield
    deadline = time.monotonic() + 5
    while True:
        count = _query(
            admin,
            "SELECT count(*) FROM pg_stat_activity WHERE datname=%s AND application_name='memos-opengauss'",
            (config.db_name,),
        )
        if count == [(0,)] or time.monotonic() >= deadline:
            break
        time.sleep(0.01)
    assert count == [(0,)]


def assert_scope_round_trip(graph):
    assert type(graph) is OpenGaussGraphDB
    graph.add_node("same", "configured", {"memory_type": "LongTermMemory"})
    graph.add_node("same", "explicit", {"memory_type": "LongTermMemory"}, user_name="request-cube")
    assert graph.get_node("same")["memory"] == "configured"
    assert graph.get_node("same", user_name="request-cube")["memory"] == "explicit"
    assert graph.config.user_name == "memos_default"


def model_factories(monkeypatch):
    import memos.memories.textual.tree as module

    for name in ("LLMFactory", "EmbedderFactory", "RerankerFactory"):
        monkeypatch.setattr(getattr(module, name), "from_config", Mock(return_value=Mock()))
    monkeypatch.setattr(module, "MemoryManager", Mock())


@pytest.mark.parametrize("entry", ["factory", "tree", "cube", "user_cube"])
def test_owned_entries_close_real_pool_and_preserve_requested_scope(
    environment, monkeypatch, entry
):
    model_factories(monkeypatch)
    if entry == "factory":
        owner = graph = GraphStoreFactory.from_config(build_graph_db_config())
    elif entry == "tree":
        owner = TreeTextMemory(APIConfig.get_default_cube_config().text_mem.config)
        graph = owner.graph_store
    else:
        owner = (
            GeneralMemCube(APIConfig.get_default_cube_config())
            if entry == "cube"
            else APIConfig.create_user_config("tester", "default")[1]
        )
        graph = owner.text_mem.graph_store
    try:
        assert_scope_round_trip(graph)
        connections = list(graph.connection_pool._pool)
    finally:
        owner.close()
    owner.close()
    assert all(connection.closed for connection in connections)
    assert graph.connection_pool.closed


@pytest.mark.parametrize("module", [component_init, standalone])
@pytest.mark.parametrize("failure", [False, True])
def test_component_assembly_real_pool_failure_cleanup(environment, monkeypatch, module, failure):
    create_graph = GraphStoreFactory.from_config
    graph_config = build_graph_db_config()
    prepare_components(monkeypatch, module)
    opened = []

    def create(_):
        graph = create_graph(graph_config)
        opened.append(graph)
        return graph

    monkeypatch.setattr(module.GraphStoreFactory, "from_config", create)
    original = ValueError("model unavailable")
    if failure:
        module.MemReaderFactory.from_config.side_effect = original
    initialize = module.init_server if module is component_init else module.init_components
    if failure:
        with pytest.raises(ValueError) as raised:
            initialize()
        assert raised.value is original
    else:
        components = initialize()
        try:
            assert_scope_round_trip(components["graph_db"])
        finally:
            shutdown_components(components)
    assert len(opened) == 1 and opened[0].connection_pool.closed


def test_standalone_scheduler_owns_one_real_graph(environment, monkeypatch):
    graph_config = build_graph_db_config()
    create_graph = GraphStoreFactory.from_config
    prepare_components(monkeypatch, standalone)
    monkeypatch.setattr(
        standalone.GraphStoreFactory, "from_config", lambda _: create_graph(graph_config)
    )
    scheduler = BaseScheduler({"use_redis_queue": False})
    try:
        cube, feedback = scheduler.mem_cube, scheduler.feedback_server
        assert cube is scheduler.components["naive_mem_cube"]
        assert feedback is scheduler.components["feedback_server"]
        graph = scheduler.components["graph_db"]
        assert_scope_round_trip(graph)
    finally:
        scheduler.close()
    assert graph.connection_pool.closed


def test_scheduler_finishes_inflight_database_task_before_closing_pool(environment, monkeypatch):
    graph = GraphStoreFactory.from_config(build_graph_db_config())
    components = {"graph_db": graph, "naive_mem_cube": Mock(), "feedback_server": Mock()}
    monkeypatch.setattr("memos.mem_scheduler.base_scheduler.init_components", lambda: components)
    scheduler = BaseScheduler({"use_redis_queue": False})
    assert scheduler.mem_cube is components["naive_mem_cube"]
    entered, release = Event(), Event()
    connections = []

    def task():
        with graph._get_connection() as connection:
            connections.append(connection)
            with connection.cursor() as cursor:
                cursor.execute("SELECT 17")
                assert cursor.fetchone() == (17,)
            entered.set()
            assert release.wait(5)
            assert not graph._closed and not connection.closed

    running = scheduler.dispatcher.dispatcher_executor.submit(task)
    try:
        assert entered.wait(5)
        with ThreadPoolExecutor(1) as pool:
            closing = pool.submit(scheduler.close)
            assert scheduler._close_state.closing.wait(5)
            assert not closing.done()
            release.set()
            running.result(5)
            closing.result(5)
    finally:
        release.set()
        scheduler.close()
    assert graph.connection_pool.closed and all(connection.closed for connection in connections)
