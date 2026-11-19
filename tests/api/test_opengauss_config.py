"""OP-09 R09-01/02: independent configuration expectations."""

from unittest.mock import Mock

import pytest

from memos.api.config import APIConfig
from memos.api.handlers.config_builders import build_graph_db_config
from memos.configs.graph_db import GraphDBConfigFactory, OpenGaussGraphDBConfig
from memos.graph_dbs.factory import GraphStoreFactory
from memos.graph_dbs.opengauss import OpenGaussGraphDB
from memos.mem_scheduler.general_modules.init_components_for_scheduler import (
    build_graph_db_config as scheduler_config,
)


@pytest.fixture
def env(monkeypatch):
    import os

    for key in tuple(os.environ):
        if key.startswith(("OPENGAUSS_", "POSTGRES_", "POLAR_", "NEO4J_", "MOS_")):
            monkeypatch.delenv(key)
    for key, value in {
        "GRAPH_DB_BACKEND": "opengauss",
        "OPENGAUSS_HOST": "db.example",
        "OPENGAUSS_USER": "app",
        "OPENGAUSS_PASSWORD": "synthetic",
        "OPENGAUSS_DB": "memos",
        "EMBEDDING_DIMENSION": "1024",
        "MEMOS_USER_NAME": "default",
        "ENABLE_INTERNET": "false",
        "ENABLE_ACTIVATION_MEMORY": "false",
        "ENABLE_PREFERENCE_MEMORY": "false",
    }.items():
        monkeypatch.setenv(key, value)


def test_factories_register_formal_class_without_losing_existing_backends(env):
    assert set(GraphDBConfigFactory.backend_to_class) == {
        "neo4j",
        "neo4j-community",
        "polardb",
        "postgres",
        "opengauss",
    }
    assert GraphStoreFactory.backend_to_class["opengauss"] is OpenGaussGraphDB
    assert not OpenGaussGraphDB.__abstractmethods__
    assert isinstance(build_graph_db_config().config, OpenGaussGraphDBConfig)


@pytest.mark.parametrize("user,scope", [(None, "default"), ("u-1", "memos_u1"), ("", "default")])
def test_open_gauss_defaults(env, user, scope):
    assert APIConfig.get_opengauss_config(user) == {
        "host": "db.example",
        "port": 5432,
        "user": "app",
        "password": "synthetic",
        "db_name": "memos",
        "user_name": scope,
        "use_multi_db": False,
        "embedding_dimension": 1024,
        "minconn": 1,
        "maxconn": 20,
        "connect_timeout": 10,
        "connection_wait_timeout": 30,
    }


def test_environment_overrides(env, monkeypatch):
    for key, value in {
        "OPENGAUSS_PORT": "55432",
        "OPENGAUSS_MIN_CONN": "2",
        "OPENGAUSS_MAX_CONN": "7",
        "OPENGAUSS_CONNECT_TIMEOUT": "8",
        "OPENGAUSS_CONNECTION_WAIT_TIMEOUT": "9",
        "EMBEDDING_DIMENSION": "3",
        "MEMOS_USER_NAME": "custom",
    }.items():
        monkeypatch.setenv(key, value)
    config = build_graph_db_config(None).config
    assert (config.port, config.minconn, config.maxconn) == (55432, 2, 7)
    assert (config.connect_timeout, config.connection_wait_timeout) == (8, 9)
    assert (config.embedding_dimension, config.user_name) == (3, "custom")


@pytest.mark.parametrize("name", ["HOST", "USER", "PASSWORD", "DB"])
@pytest.mark.parametrize("value", [None, "", "   "])
def test_required_connection_fields(env, monkeypatch, name, value):
    key = "OPENGAUSS_" + name
    if value is None:
        monkeypatch.delenv(key)
    else:
        monkeypatch.setenv(key, value)
    with pytest.raises(ValueError):
        build_graph_db_config()


def test_all_configuration_entries_select_only_requested_backend(env, monkeypatch):
    monkeypatch.setenv("POSTGRES_PORT", "broken")
    for backend in ("neo4j", "neo4j_community", "polardb"):
        monkeypatch.setattr(APIConfig, f"get_{backend}_config", Mock(side_effect=AssertionError))
    expected = build_graph_db_config()
    assert scheduler_config() == expected
    assert APIConfig.get_default_cube_config().text_mem.config.graph_db == expected
    cube = Mock()
    monkeypatch.setattr("memos.mem_cube.general.GeneralMemCube", cube)
    APIConfig.create_user_config("tester", "default")
    assert cube.call_args.args[0].text_mem.config.graph_db == expected


@pytest.mark.parametrize("backend", ["neo4j", "neo4j-community", "polardb", "postgres"])
def test_legacy_selection_only_calls_selected_getter(env, monkeypatch, backend):
    sentinel = {"selected": backend}
    for name in ("neo4j", "neo4j-community", "polardb", "postgres", "opengauss"):
        getter = (
            Mock(return_value=sentinel) if name == backend else Mock(side_effect=AssertionError)
        )
        monkeypatch.setattr(APIConfig, "get_" + name.replace("-", "_") + "_config", getter)
    monkeypatch.delenv("GRAPH_DB_BACKEND")
    monkeypatch.setenv("NEO4J_BACKEND", backend.upper())
    assert APIConfig.get_graph_db_config("u") == {"backend": backend, "config": sentinel}


def test_precedence_default_and_invalid_backend(env, monkeypatch):
    monkeypatch.setenv("NEO4J_BACKEND", "invalid")
    assert APIConfig.get_graph_db_config()["backend"] == "opengauss"
    monkeypatch.delenv("GRAPH_DB_BACKEND")
    with pytest.raises(ValueError, match="backend"):
        APIConfig.get_graph_db_config()
    monkeypatch.delenv("NEO4J_BACKEND")
    assert APIConfig.get_graph_db_config()["backend"] == "neo4j-community"


def test_disabled_default_cube_does_not_read_connection(env, monkeypatch):
    monkeypatch.setenv("MOS_ENABLE_DEFAULT_CUBE_CONFIG", "false")
    monkeypatch.delenv("OPENGAUSS_HOST")
    assert APIConfig.get_default_cube_config() is None


def test_user_cube_keeps_scheduler_and_mysql_configuration(env, monkeypatch):
    monkeypatch.setenv("MOS_ENABLE_SCHEDULER", "true")
    monkeypatch.setenv("MOS_USER_MANAGER_BACKEND", "mysql")
    monkeypatch.setattr("memos.mem_cube.general.GeneralMemCube", Mock())
    config, _ = APIConfig.create_user_config("tester", "default")
    assert config.enable_mem_scheduler
    assert config.user_manager.backend == "mysql"
