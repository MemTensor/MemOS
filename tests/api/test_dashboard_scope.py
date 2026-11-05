"""OP-09 B1 scope selection, pruning and real-record-only response buckets."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from pydantic import ValidationError

from memos.api.handlers.memory_handler import handle_get_memories_dashboard
from memos.api.product_models import GetMemoryDashboardRequest, GetMemoryRequest
from memos.exceptions import GraphDBError
from memos.graph_dbs.opengauss import OpenGaussGraphDB
from memos.memories.textual.tree import TreeTextMemory


PUBLIC = {"and": [{"object_type": "public"}, {"mem_cube_id": "P"}]}
USER = {"object_type": "user", "mem_cube_id": "P"}


def cube(open_gauss=True, nodes=None, total=0):
    graph = OpenGaussGraphDB.__new__(OpenGaussGraphDB) if open_gauss else SimpleNamespace()
    graph.export_graph = Mock(return_value={"nodes": nodes or [], "total_nodes": total})
    memory = TreeTextMemory.__new__(TreeTextMemory)
    memory.graph_store = graph
    return SimpleNamespace(text_mem=memory)


@pytest.mark.parametrize(
    "fields,owner,all_cubes,excluded,business",
    [
        ({}, None, True, None, None),
        ({"all_cubes": None, "exclude_cube_id": None}, None, True, None, None),
        ({"mem_cube_id": "A"}, "A", False, None, None),
        ({"all_cubes": False}, None, False, None, None),
        ({"all_cubes": False, "mem_cube_id": "A"}, "A", False, None, None),
        ({"all_cubes": True}, None, True, None, None),
        ({"exclude_cube_id": "P"}, None, True, "P", None),
        ({"all_cubes": True, "exclude_cube_id": "P"}, None, True, "P", None),
        ({"filter": PUBLIC, "mem_cube_id": "A"}, "P", False, None, None),
        ({"filter": PUBLIC, "all_cubes": False}, "P", False, None, None),
        ({"filter": USER, "mem_cube_id": "A"}, None, True, "P", None),
        ({"filter": USER, "all_cubes": True}, None, True, "P", None),
        ({"filter": USER, "exclude_cube_id": "P"}, None, True, "P", None),
        (
            {"filter": {"or": [{"object_type": "public", "mem_cube_id": "P"}, {"tag": "x"}]}},
            "P",
            False,
            None,
            {"or": [{"tag": "x"}]},
        ),
        (
            {"filter": {"and": [PUBLIC, PUBLIC, {"or": [{"tag": "x"}, {"tag": "y"}]}]}},
            "P",
            False,
            None,
            {"and": [{"or": [{"tag": "x"}, {"tag": "y"}]}]},
        ),
        ({"filter": {}}, None, True, None, None),
        ({"filter": {"tag": {"in": ["x", "y"]}}}, None, True, None, {"tag": {"in": ["x", "y"]}}),
    ],
)
def test_dashboard_resolves_once_and_preserves_request(
    fields, owner, all_cubes, excluded, business
):
    target = cube()
    request = GetMemoryDashboardRequest(**fields, user_id="u", page=2, page_size=3)
    before = deepcopy(request.model_dump())
    response = handle_get_memories_dashboard(request, target)
    calls = target.text_mem.graph_store.export_graph.call_args_list
    assert len(calls) == 4
    for call in calls:
        assert call.kwargs["user_name"] == owner
        assert call.kwargs["all_cubes"] is all_cubes
        assert call.kwargs.get("exclude_user_name") == excluded
        assert call.kwargs["filter"] == business
        assert call.kwargs["user_id"] == "u"
        assert (call.kwargs["page"], call.kwargs["page_size"]) == (2, 3)
    assert request.model_dump() == before
    assert response.data["text_mem"] == []


@pytest.mark.parametrize(
    "fields",
    [
        {"all_cubes": True, "mem_cube_id": "A"},
        {"all_cubes": True, "filter": PUBLIC},
        {"all_cubes": False, "filter": USER},
        {"all_cubes": False, "exclude_cube_id": "P"},
        {"mem_cube_id": "A", "exclude_cube_id": "P"},
        {"filter": PUBLIC, "exclude_cube_id": "P"},
        {"filter": USER, "exclude_cube_id": "Q"},
        {"mem_cube_id": "   "},
        *(
            {"filter": condition}
            for condition in [
                {"object_type": "public"},
                {"mem_cube_id": "P"},
                {"object_type": "unknown", "mem_cube_id": "P"},
                {"object_type": [], "mem_cube_id": "P"},
                {"object_type": "public", "mem_cube_id": " "},
                {"object_type": "public", "mem_cube_id": 3},
                {"and": [PUBLIC, USER]},
                {"and": [PUBLIC, {"mem_cube_id": "Q"}]},
                {"and": []},
                {"or": []},
                {"and": {}},
                {"or": [None]},
                {"or": [{}]},
                {"and": [PUBLIC, {}]},
                {"or": ["tag"]},
            ]
        ),
    ],
)
def test_invalid_scope_or_original_structure_never_calls_database(fields):
    target = cube()
    with pytest.raises(ValueError):
        handle_get_memories_dashboard(GetMemoryDashboardRequest(**fields), target)
    target.text_mem.graph_store.export_graph.assert_not_called()


@pytest.mark.parametrize("fields", [{}, {"all_cubes": None, "exclude_cube_id": None}])
def test_legacy_requests_keep_original_parameters(fields):
    target = cube(False)
    request = GetMemoryDashboardRequest(mem_cube_id="A", filter=PUBLIC, **fields)
    handle_get_memories_dashboard(request, target)
    for call in target.text_mem.graph_store.export_graph.call_args_list:
        assert call.kwargs["user_name"] == "A"
        assert call.kwargs["filter"] == PUBLIC
        assert "all_cubes" not in call.kwargs and "exclude_user_name" not in call.kwargs


@pytest.mark.parametrize(
    "fields", [{"all_cubes": False}, {"all_cubes": True}, {"exclude_cube_id": "P"}]
)
def test_legacy_backends_reject_explicit_new_inputs(fields):
    target = cube(False)
    with pytest.raises(ValueError, match="support"):
        handle_get_memories_dashboard(GetMemoryDashboardRequest(**fields), target)
    target.text_mem.graph_store.export_graph.assert_not_called()


@pytest.mark.parametrize("open_gauss", [False, True])
@pytest.mark.parametrize(
    "fields",
    [{}, {"mem_cube_id": "A"}, {"filter": PUBLIC}, {"filter": USER}, {"page": 5, "page_size": 2}],
)
def test_no_virtual_buckets_and_empty_page_keeps_statistics(open_gauss, fields):
    target = cube(open_gauss, total=7)
    response = handle_get_memories_dashboard(GetMemoryDashboardRequest(**fields), target)
    for category in ("text_mem", "tool_mem", "skill_mem", "pref_mem"):
        assert response.data[category] == []
    assert response.data["statistics"] == {
        "total_text_nodes": 7,
        "total_tool_nodes": 7,
        "total_skill_nodes": 7,
        "total_preference_nodes": 7,
    }


def test_real_nodes_keep_cross_cube_identity_and_bucket_counts():
    nodes = [
        {"id": "same", "memory": owner, "metadata": {"user_name": owner}}
        for owner in ("A", "B", "A")
    ]
    response = handle_get_memories_dashboard(
        GetMemoryDashboardRequest(), cube(nodes=nodes, total=8)
    )
    for category in ("text_mem", "tool_mem", "skill_mem", "pref_mem"):
        assert response.data[category] == [
            {"cube_id": "A", "memories": [nodes[0], nodes[2]], "total_nodes": 2},
            {"cube_id": "B", "memories": [nodes[1]], "total_nodes": 1},
        ]


def test_disabled_categories_are_not_queried():
    target = cube()
    request = GetMemoryDashboardRequest(
        include_tool_memory=False, include_skill_memory=False, include_preference=False
    )
    response = handle_get_memories_dashboard(request, target)
    target.text_mem.graph_store.export_graph.assert_called_once()
    assert all(value == 0 for value in response.data["statistics"].values())


def test_pure_control_still_queries_and_storage_failure_is_visible():
    target = cube()
    error = GraphDBError("storage failed")
    target.text_mem.graph_store.export_graph.side_effect = error
    with pytest.raises(GraphDBError) as raised:
        handle_get_memories_dashboard(GetMemoryDashboardRequest(filter=PUBLIC), target)
    assert raised.value is error
    target.text_mem.graph_store.export_graph.assert_called_once()


@pytest.mark.parametrize("value", ["true", "false", 0, 1, [], {}])
def test_new_boolean_is_strict(value):
    with pytest.raises(ValidationError):
        GetMemoryDashboardRequest(all_cubes=value)


@pytest.mark.parametrize("value", ["", "  ", 3, False])
def test_excluded_cube_must_be_nonblank_string(value):
    with pytest.raises(ValidationError):
        GetMemoryDashboardRequest(exclude_cube_id=value)


def test_optional_schema_and_ordinary_get_contract():
    schema = GetMemoryDashboardRequest.model_json_schema()
    for name in ("all_cubes", "exclude_cube_id"):
        assert name not in schema.get("required", [])
        assert schema["properties"][name]["default"] is None
        assert {"type": "null"} in schema["properties"][name]["anyOf"]
    ordinary = GetMemoryRequest.model_json_schema()
    assert "mem_cube_id" in ordinary["required"]
    assert "all_cubes" not in ordinary["properties"]


def test_tree_defaults_are_single_cube_and_legacy_rejects_new_arguments():
    memory = cube().text_mem
    memory.get_all()
    assert "all_cubes" not in memory.graph_store.export_graph.call_args.kwargs
    memory.get_all(exclude_user_name="P")
    assert "all_cubes" not in memory.graph_store.export_graph.call_args.kwargs
    assert memory.graph_store.export_graph.call_args.kwargs["exclude_user_name"] == "P"
    legacy = cube(False).text_mem
    with pytest.raises(ValueError, match="support"):
        legacy.get_all(all_cubes=False)
