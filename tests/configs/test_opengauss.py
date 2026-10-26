"""openGauss configuration contract (CFG-02 through CFG-04, REG-01)."""

import json
import os
import subprocess
import sys

from copy import deepcopy

import pytest

from pydantic import ValidationError

from memos.configs import graph_db
from tests.utils import check_config_base_class


@pytest.fixture
def config_class():
    return graph_db.OpenGaussGraphDBConfig


@pytest.fixture
def valid_config():
    return {
        "host": "localhost",
        "user": "memos",
        "password": "synthetic-test-password",
        "db_name": "memos_test",
        "user_name": "cube-a",
    }


def test_config_fields_and_defaults(config_class, valid_config):
    check_config_base_class(
        config_class,
        required_fields=["host", "user", "password", "db_name"],
        optional_fields=[
            "port",
            "embedding_dimension",
            "minconn",
            "maxconn",
            "connect_timeout",
            "connection_wait_timeout",
            "use_multi_db",
            "user_name",
        ],
    )
    config = config_class(**valid_config)
    assert config.model_dump(exclude=set(valid_config)) == {
        "port": 5432,
        "embedding_dimension": 1024,
        "minconn": 1,
        "maxconn": 20,
        "connect_timeout": 10,
        "connection_wait_timeout": 30,
        "use_multi_db": False,
    }


@pytest.mark.parametrize("field", ["host", "user", "password", "db_name"])
def test_required_field_is_located(config_class, valid_config, field):
    del valid_config[field]
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config)
    assert (field,) in [error["loc"] for error in exc.value.errors()]


@pytest.mark.parametrize("field", ["host", "user", "password", "db_name", "user_name"])
@pytest.mark.parametrize("value", ["", " \t\n"])
def test_blank_identifiers_and_credentials_are_rejected(config_class, valid_config, field, value):
    valid_config[field] = value
    with pytest.raises(ValidationError, match=field):
        config_class(**valid_config)


@pytest.mark.parametrize("field", ["host", "user", "password", "db_name", "user_name"])
@pytest.mark.parametrize("value", [42, False, ["value"], {"value": "name"}])
def test_string_fields_are_strict(config_class, valid_config, field, value):
    valid_config[field] = value
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config)
    assert (field,) in [error["loc"] for error in exc.value.errors()]


@pytest.mark.parametrize("field", ["host", "user", "password", "db_name"])
def test_required_strings_reject_none(config_class, valid_config, field):
    valid_config[field] = None
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config)
    assert (field,) in [error["loc"] for error in exc.value.errors()]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("port", 1),
        ("port", 65535),
        ("embedding_dimension", 1),
        ("minconn", 20),
        ("maxconn", 1),
        ("connect_timeout", 1),
        ("connect_timeout", 3600),
        ("connection_wait_timeout", 1),
        ("connection_wait_timeout", 3600),
    ],
)
def test_numeric_boundaries_are_inclusive(config_class, valid_config, field, value):
    valid_config[field] = value
    assert getattr(config_class(**valid_config), field) == value


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("port", 0),
        ("port", 65536),
        ("embedding_dimension", 0),
        ("embedding_dimension", -1),
        ("minconn", 0),
        ("maxconn", 0),
        ("connect_timeout", 0),
        ("connect_timeout", 3601),
        ("connection_wait_timeout", 0),
        ("connection_wait_timeout", 3601),
    ],
)
def test_numeric_values_outside_contract_are_rejected(config_class, valid_config, field, value):
    valid_config[field] = value
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config)
    assert (field,) in [error["loc"] for error in exc.value.errors()]


@pytest.mark.parametrize(
    "field",
    [
        "port",
        "embedding_dimension",
        "minconn",
        "maxconn",
        "connect_timeout",
        "connection_wait_timeout",
    ],
)
@pytest.mark.parametrize("value", ["10", 1.5, True, None])
def test_numeric_fields_do_not_coerce_invalid_types(config_class, valid_config, field, value):
    valid_config[field] = value
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config)
    assert (field,) in [error["loc"] for error in exc.value.errors()]


def test_pool_minimum_cannot_exceed_maximum(config_class, valid_config):
    with pytest.raises(ValidationError, match="minconn.*maxconn"):
        config_class(**valid_config, minconn=3, maxconn=2)


@pytest.mark.parametrize("use_multi_db", [False, True])
def test_explicit_scope_is_preserved_in_either_mode(config_class, valid_config, use_multi_db):
    valid_config["user_name"] = " 范围甲 "
    config = config_class(**valid_config, use_multi_db=use_multi_db)
    assert config.user_name == " 范围甲 "
    assert config.use_multi_db is use_multi_db


@pytest.mark.parametrize("explicit_none", [False, True])
def test_physical_isolation_allows_absent_logical_scope(config_class, valid_config, explicit_none):
    del valid_config["user_name"]
    if explicit_none:
        valid_config["user_name"] = None
    config = config_class(**valid_config, use_multi_db=True)
    assert config.user_name is None


@pytest.mark.parametrize("scope", ["", " \t\n"])
def test_physical_isolation_rejects_explicit_blank_scope(config_class, valid_config, scope):
    valid_config["user_name"] = scope
    with pytest.raises(ValidationError, match="user_name"):
        config_class(**valid_config, use_multi_db=True)


@pytest.mark.parametrize("explicit_none", [False, True])
def test_shared_database_requires_scope(config_class, valid_config, explicit_none):
    del valid_config["user_name"]
    if explicit_none:
        valid_config["user_name"] = None
    with pytest.raises(ValidationError, match="user_name"):
        config_class(**valid_config)


@pytest.mark.parametrize("value", ["false", "true", 0, 1, None])
def test_isolation_mode_is_a_strict_boolean(config_class, valid_config, value):
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config, use_multi_db=value)
    assert ("use_multi_db",) in [error["loc"] for error in exc.value.errors()]


def test_unknown_options_are_rejected(config_class, valid_config):
    with pytest.raises(ValidationError) as exc:
        config_class(**valid_config, shard_count=400)
    assert exc.value.errors()[0]["type"] == "extra_forbidden"
    assert exc.value.errors()[0]["loc"] == ("shard_count",)


def test_password_is_hidden_from_repr(config_class, valid_config):
    assert valid_config["password"] not in repr(config_class(**valid_config))


def test_overrides_and_serialization_preserve_values(config_class, valid_config, tmp_path):
    values = {
        **valid_config,
        "host": "db.example",
        "port": 55432,
        "embedding_dimension": 3,
        "minconn": 2,
        "maxconn": 4,
        "connect_timeout": 5,
        "connection_wait_timeout": 15,
        "use_multi_db": True,
    }
    before = deepcopy(values)
    config = config_class(**values)
    assert config.model_dump() == before
    assert values == before
    for suffix in ("json", "yaml"):
        path = tmp_path / f"config.{suffix}"
        getattr(config, f"to_{suffix}_file")(str(path))
        restored = getattr(config_class, f"from_{suffix}_file")(str(path))
        assert restored.model_dump() == before


def test_config_import_needs_no_database_driver_or_connection():
    script = """
import importlib.abc
import json
import sys

class NoDatabaseDriver(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'psycopg2' or fullname.startswith('psycopg2.'):
            raise ModuleNotFoundError('driver intentionally unavailable')

sys.meta_path.insert(0, NoDatabaseDriver())
from memos.configs.graph_db import OpenGaussGraphDBConfig
config = OpenGaussGraphDBConfig(host='localhost', user='memos', password='synthetic', db_name='memos', user_name='cube-a')
assert 'psycopg2' not in sys.modules
print('CONFIG_RESULT:' + json.dumps({'port': config.port, 'scope': config.user_name}))
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    results = [
        line.removeprefix("CONFIG_RESULT:")
        for line in result.stdout.splitlines()
        if line.startswith("CONFIG_RESULT:")
    ]
    assert len(results) == 1
    assert json.loads(results[0]) == {"port": 5432, "scope": "cube-a"}


@pytest.mark.parametrize(
    ("backend", "values", "class_name"),
    [
        (
            "neo4j",
            {
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "synthetic",
                "db_name": "neo4j",
            },
            "Neo4jGraphDBConfig",
        ),
        (
            "neo4j-community",
            {
                "uri": "bolt://localhost:7687",
                "user": "neo4j",
                "password": "synthetic",
                "db_name": "neo4j",
                "use_multi_db": False,
                "user_name": "cube-a",
                "vec_config": {"backend": "qdrant", "config": {"collection_name": "memos"}},
            },
            "Neo4jCommunityGraphDBConfig",
        ),
        (
            "polardb",
            {"host": "localhost", "user": "memos", "password": "synthetic", "db_name": "memos"},
            "PolarDBGraphDBConfig",
        ),
        (
            "postgres",
            {
                "host": "localhost",
                "user": "memos",
                "password": "synthetic",
                "db_name": "memos",
                "user_name": "cube-a",
            },
            "PostgresGraphDBConfig",
        ),
    ],
)
def test_existing_backend_configs_are_still_selected(backend, values, class_name):
    config = graph_db.GraphDBConfigFactory(backend=backend, config=values)
    assert type(config.config).__name__ == class_name


def test_factories_do_not_expose_an_unimplemented_store():
    from memos.graph_dbs.factory import GraphStoreFactory

    expected = {"neo4j", "neo4j-community", "polardb", "postgres"}
    assert set(graph_db.GraphDBConfigFactory.backend_to_class) == expected
    assert set(GraphStoreFactory.backend_to_class) == expected
