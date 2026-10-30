"""The openGauss provider follows the existing single-class backend layout."""

import ast
import importlib
import inspect

from pathlib import Path

import pytest

from memos.configs.graph_db import GraphDBConfigFactory
from memos.graph_dbs.base import BaseGraphDB


PENDING = {
    "get_context_chain",
    "search_by_embedding",
    "get_structure_optimization_candidates",
    "deduplicate_nodes",
    "detect_conflicts",
    "merge_nodes",
    "clear",
    "export_graph",
    "import_graph",
}


def test_one_backend_class_owns_pool_storage_and_filters():
    module = importlib.import_module("memos.graph_dbs.opengauss")
    cls = module.OpenGaussGraphDB
    assert issubclass(cls, BaseGraphDB)
    assert cls.__abstractmethods__ == PENDING
    assert inspect.isabstract(cls)
    assert "opengauss" not in GraphDBConfigFactory.backend_to_class
    tree = ast.parse(Path(module.__file__).read_text())
    assert [node.name for node in ast.walk(tree) if isinstance(node, ast.ClassDef)] == [
        "OpenGaussGraphDB"
    ]
    for name in [
        "__init__",
        "_get_connection",
        "close",
        "parse_filter",
        "_build_filter_where_clause",
        "_build_single_filter_condition",
        "get_by_metadata",
        "get_all_memory_items",
        "delete_node_by_prams",
    ]:
        assert name in cls.__dict__
    assert "ThreadedConnectionPool" in inspect.getsource(cls.__init__)
    for name in ["_opengauss_connection.py", "_opengauss_store.py", "_opengauss_filter.py"]:
        assert not Path(module.__file__).with_name(name).exists()


def test_parse_filter_preserves_input_and_routes_business_fields():
    from copy import deepcopy

    module = importlib.import_module("memos.graph_dbs.opengauss")
    condition = {
        "and": [{"project": "星港"}, {"or": [{"status": "activated"}, {"info.done": True}]}]
    }
    before = deepcopy(condition)
    assert module.OpenGaussGraphDB.parse_filter(condition) == {
        "and": [{"info.project": "星港"}, {"or": [{"status": "activated"}, {"info.done": True}]}]
    }
    assert condition == before
    assert module.OpenGaussGraphDB.parse_filter(None) is None
    assert module.OpenGaussGraphDB.parse_filter({}) == {}


@pytest.mark.parametrize("method", sorted(PENDING))
def test_unimplemented_methods_in_test_harness_fail_explicitly(method):
    support = importlib.import_module("tests.graph_dbs.opengauss_test_support")
    with pytest.raises(NotImplementedError):
        getattr(support.PartialOpenGaussGraphDB, method)(None)
