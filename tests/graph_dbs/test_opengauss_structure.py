"""The openGauss provider follows the existing single-class backend layout."""

import ast
import importlib
import inspect

from pathlib import Path

from memos.configs.graph_db import GraphDBConfigFactory
from memos.graph_dbs.base import BaseGraphDB


def test_one_backend_class_owns_pool_storage_and_filters():
    module = importlib.import_module("memos.graph_dbs.opengauss")
    cls = module.OpenGaussGraphDB
    assert issubclass(cls, BaseGraphDB)
    assert cls.__abstractmethods__ == frozenset()
    assert not inspect.isabstract(cls)
    support = importlib.import_module("tests.graph_dbs.opengauss_test_support")
    assert support.PartialOpenGaussGraphDB is cls
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
        "search_by_embedding",
        "search_by_fulltext",
        "get_grouped_counts",
        "get_memory_count",
        "node_not_exist",
        "remove_oldest_memory",
        "get_structure_optimization_candidates",
        "export_graph",
        "import_graph",
        "clear",
        "drop_database",
        "get_user_names_by_memory_ids",
        "exist_user_name",
        "delete_node_by_mem_cube_id",
        "recover_memory_by_mem_cube_id",
        "get_context_chain",
        "deduplicate_nodes",
        "detect_conflicts",
        "merge_nodes",
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
