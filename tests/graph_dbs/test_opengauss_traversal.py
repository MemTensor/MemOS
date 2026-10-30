"""Bounded graph traversal and ranked tag candidates, with fixed business results."""

import json

from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import GraphDBError
from memos.graph_dbs import opengauss as module
from tests.graph_dbs.opengauss_test_support import PartialOpenGaussGraphDB


@pytest.fixture
def store(monkeypatch):
    pool = MagicMock()
    cursor = pool.transaction.return_value.__enter__.return_value.cursor.return_value.__enter__.return_value
    monkeypatch.setattr(module, "ThreadedConnectionPool", MagicMock())
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_get_connection", pool.transaction)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_ensure_open", pool.ensure_open)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "close", pool.close)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_init_schema", lambda self: None)
    db = PartialOpenGaussGraphDB(
        OpenGaussGraphDBConfig(
            host="localhost",
            user="memos",
            password="synthetic",
            db_name="test",
            user_name="A",
            embedding_dimension=3,
        )
    )
    return db, pool, cursor


@pytest.fixture
def graph(store, monkeypatch):
    """Model driver rows, keeping expected paths/subgraphs independent of traversal."""
    db, pool, cursor = store
    nodes = {("A", name): {} for name in [*"abcdefg", "z"]}
    nodes.update({("B", name): {} for name in "abcdefg"})
    edges = [
        ("A", "a", "b", "R"),
        ("A", "a", "c", "R"),
        ("A", "b", "d", "R"),
        ("A", "c", "d", "R"),
        ("A", "d", "a", "R"),
        ("A", "e", "a", "R"),
        ("A", "b", "c", "SIDE"),
        ("A", "a", "b", "OTHER"),
        ("A", "b", "b", "SELF"),
        ("A", "d", "f", "R"),
        ("A", "f", "g", "R"),
        ("B", "a", "g", "R"),
    ]

    def execute(statement, parameters):
        scope, ids = parameters
        selected = [
            (name, metadata)
            for (owner, name), metadata in nodes.items()
            if owner == scope and (name not in ids if "NOT" in statement else name in ids)
        ]
        if statement.startswith("SELECT business_id FROM"):
            cursor.fetchall.return_value = [(name,) for name, _ in selected]
        else:
            cursor.fetchall.return_value = [
                (
                    name,
                    "memory " + name,
                    json.dumps(
                        {**metadata, "id": name, "memory": "memory " + name, "user_name": scope}
                    ),
                    "[1, 0, 0]" if "embedding::text" in statement else None,
                )
                for name, metadata in selected
            ]

    def cypher(cursor, body, parameters, columns):
        assert "a.user_name = $scope" in body and "b.user_name = $scope" in body
        scope, ids = parameters["scope"], set(parameters["ids"])
        result = []
        for owner, source, target, kind in reversed(edges):
            if owner != scope:
                continue
            if "(a.id IN $ids OR b.id IN $ids)" in body:
                matches = source in ids or target in ids
            elif "a.id IN $ids AND b.id IN $ids" in body:
                matches = source in ids and target in ids
            else:
                matches = source in ids
            if matches:
                result.append(tuple(json.dumps(value) for value in (source, target, kind)))
        return result

    cursor.execute.side_effect = execute
    monkeypatch.setattr(db, "_cypher", MagicMock(side_effect=cypher))
    return db, pool, cursor, nodes, edges


@pytest.mark.parametrize(
    "source,target,depth,expected",
    [
        ("a", "d", 1, []),
        ("a", "d", 2, ["a", "b", "d"]),
        ("a", "g", 3, []),
        ("a", "g", 4, ["a", "b", "d", "f", "g"]),
        ("a", "g", 5, ["a", "b", "d", "f", "g"]),
        ("a", "a", 1, ["a"]),
        ("a", "e", 5, []),
        ("a", "z", 5, []),
        ("z", "a", 5, []),
        ("missing", "a", 3, []),
        ("a", "missing", 3, []),
        ("missing", "missing", 3, []),
    ],
)
def test_directed_shortest_path_is_bounded_and_deterministic(
    graph, source, target, depth, expected
):
    db, pool, _, _, _ = graph
    assert db.get_path(source, target, depth) == expected
    pool.transaction.assert_called_once()


def test_equal_length_paths_compare_full_sequences_not_only_last_hop(graph):
    db, _, _, _, edges = graph
    edges[:] = [
        ("A", *edge)
        for edge in [
            ("a", "b", "R"),
            ("a", "c", "R"),
            ("b", "f", "R"),
            ("c", "d", "R"),
            ("f", "g", "R"),
            ("d", "g", "R"),
        ]
    ]
    assert db.get_path("a", "g", 3) == ["a", "b", "f", "g"]


def test_path_honors_explicit_scope(graph):
    db, _, _, _, _ = graph
    assert db.get_path("a", "g", 1, user_name="B") == ["a", "g"]


def test_fifth_hop_is_included_but_sixth_is_not(graph):
    db, _, _, _, edges = graph
    edges[:] = [
        ("A", source, target, "R") for source, target in zip("abcdef", "bcdefg", strict=True)
    ]
    assert db.get_path("a", "f", 5) == ["a", "b", "c", "d", "e", "f"]
    assert db.get_path("a", "g", 5) == []


def test_subgraph_contains_incoming_boundary_edges_parallel_edges_and_self_loop(graph):
    db, pool, _, _, _ = graph
    result = db.get_subgraph("a", depth=1)
    assert result == {
        "core_node": {"id": "a", "memory": "memory a", "metadata": {}},
        "neighbors": [
            {"id": name, "memory": "memory " + name, "metadata": {}}
            for name in ["b", "c", "d", "e"]
        ],
        "edges": [
            {"source": "a", "target": "b", "type": "OTHER"},
            {"source": "a", "target": "b", "type": "R"},
            {"source": "a", "target": "c", "type": "R"},
            {"source": "b", "target": "b", "type": "SELF"},
            {"source": "b", "target": "c", "type": "SIDE"},
            {"source": "b", "target": "d", "type": "R"},
            {"source": "c", "target": "d", "type": "R"},
            {"source": "d", "target": "a", "type": "R"},
            {"source": "e", "target": "a", "type": "R"},
        ],
    }
    pool.transaction.assert_called_once()


@pytest.mark.parametrize(
    "depth,names", [(2, ["b", "c", "d", "e", "f"]), (5, ["b", "c", "d", "e", "f", "g"])]
)
def test_subgraph_expands_actual_depth_without_repeating_cycle(graph, depth, names):
    db, _, _, _, _ = graph
    result = db.get_subgraph("a", depth)
    assert [node["id"] for node in result["neighbors"]] == names
    assert len(result["edges"]) == (10 if depth == 2 else 11)
    assert db._cypher.call_count <= depth + 1


def test_isolated_subgraph_and_explicit_scope(graph):
    db, _, _, _, _ = graph
    assert db.get_subgraph("z") == {
        "core_node": {"id": "z", "memory": "memory z", "metadata": {}},
        "neighbors": [],
        "edges": [],
    }
    assert db.get_subgraph("a", user_name="B") == {
        "core_node": {"id": "a", "memory": "memory a", "metadata": {}},
        "neighbors": [{"id": "g", "memory": "memory g", "metadata": {}}],
        "edges": [{"source": "a", "target": "g", "type": "R"}],
    }


@pytest.mark.parametrize("status", ["archived", None])
def test_center_status_filters_center_only_and_can_be_disabled(graph, status):
    db, _, _, nodes, _ = graph
    nodes[("A", "a")] = {"status": status}
    nodes[("A", "b")] = {"status": "deleted"}
    assert db.get_subgraph("a") == {"core_node": None, "neighbors": [], "edges": []}
    for required in (None, "", status):
        result = db.get_subgraph("a", center_status=required)
        assert result["core_node"]["metadata"] == {"status": status}
        assert result["neighbors"][0]["metadata"] == {"status": "deleted"}


def test_missing_center_does_not_query_edges(graph):
    db, _, _, _, _ = graph
    assert db.get_subgraph("missing") == {"core_node": None, "neighbors": [], "edges": []}
    db._cypher.assert_not_called()


@pytest.mark.parametrize("method,args", [("get_path", ("a", "b")), ("get_subgraph", ("a",))])
@pytest.mark.parametrize("depth", [0, -1, 6, True, False, 1.0, "2", None, []])
def test_invalid_depth_rejected_before_borrowing(store, method, args, depth):
    db, pool, _ = store
    with pytest.raises(ValueError, match="depth"):
        getattr(db, method)(*args, depth)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "method,args,kwargs",
    [
        ("get_path", (None, "b"), {}),
        ("get_path", ("a", " "), {}),
        ("get_subgraph", ("",), {}),
        ("get_subgraph", ("a",), {"center_status": []}),
        ("get_path", ("a", "b"), {"user_name": " "}),
        ("get_subgraph", ("a",), {"user_name": 3}),
    ],
)
def test_invalid_traversal_inputs_do_not_borrow(store, method, args, kwargs):
    db, pool, _ = store
    with pytest.raises(ValueError):
        getattr(db, method)(*args, **kwargs)
    pool.transaction.assert_not_called()


def test_frontier_values_are_bound_and_both_endpoints_scoped(store):
    db, _, cursor = store
    cursor.fetchall.return_value = [('"one"', '"two"', '"R"')]
    scope, node_id = " B $$ ' ", "中文 $memos$ ' ; --\n"
    result = db._read_edges(cursor, "a.id IN $ids", {"scope": scope, "ids": [node_id]})
    assert result == [{"from": "one", "to": "two", "type": "R"}]
    calls = cursor.execute.call_args_list
    prepare = next(call.args[0] for call in calls if call.args[0].startswith("PREPARE"))
    assert "a.user_name = $scope" in prepare and "b.user_name = $scope" in prepare
    assert node_id not in prepare and scope not in prepare
    bound = next(call.args[1][0] for call in calls if call.args[0].startswith("EXECUTE"))
    assert json.loads(bound) == {"scope": scope, "ids": [node_id]}


@pytest.mark.parametrize(
    "direction,rows,expected",
    [
        ("out", [('"one"', '"two"', '"R"'), ('"one"', '"one"', '"SELF"')], ["one", "two"]),
        ("in", [('"two"', '"one"', '"R"')], ["two"]),
        ("both", [('"two"', '"one"', '"R"'), ('"one"', '"two"', '"OTHER"')], ["two"]),
    ],
)
def test_existing_neighbor_projection_survives_shared_query_refactor(
    store, direction, rows, expected
):
    db, _, cursor = store
    cursor.fetchall.return_value = rows
    assert db.get_neighbors("one", "ANY", direction) == expected


@pytest.mark.parametrize("method,args", [("get_path", ("a", "g")), ("get_subgraph", ("a",))])
def test_expansion_failure_does_not_return_partial_results(graph, method, args):
    db, pool, _, _, _ = graph
    error = ValueError("synthetic second-hop failure")
    db._cypher.side_effect = [[('"a"', '"b"', '"R"')], error]
    with pytest.raises(ValueError) as caught:
        getattr(db, method)(*args)
    assert caught.value is error
    assert pool.transaction.return_value.__exit__.call_args.args[1] is error


@pytest.fixture
def candidates(graph):
    db, pool, cursor, nodes, _ = graph
    nodes.clear()
    nodes.update(
        {
            ("A", "b"): {"tags": ["red", "blue", "blue"]},
            ("A", "a"): {"tags": '["red", "blue"]'},
            ("A", "c"): {"tags": ["red"]},
            ("A", "archived"): {"status": "archived", "tags": ["red", "blue"]},
            ("A", "null-status"): {"status": None, "tags": ["red"]},
            ("A", "reasoning"): {"type": "reasoning", "tags": ["red"]},
            ("A", "legacy"): {"node_type": "reasoning", "tags": ["red"]},
            ("A", "working"): {"memory_type": "WorkingMemory", "tags": ["red"]},
            ("A", "no-tags"): {},
            ("A", "null-tags"): {"tags": None},
            ("B", "foreign"): {"tags": ["red", "blue"]},
        }
    )
    return db, pool, cursor, nodes


def test_tag_overlap_rank_ties_visibility_exclusions_and_projection(candidates):
    db, pool, _, _ = candidates
    assert db.get_neighbors_by_tag(["red", "blue", "red"], [], top_k=2) == [
        {"id": "a", "memory": "memory a", "metadata": {"tags": '["red", "blue"]'}},
        {"id": "b", "memory": "memory b", "metadata": {"tags": ["red", "blue", "blue"]}},
    ]
    assert [node["id"] for node in db.get_neighbors_by_tag(["red", "red"], ["a"])] == ["b", "c"]
    assert db.get_neighbors_by_tag(["red", "red"], [], min_overlap=2) == []
    assert db.get_neighbors_by_tag(["none"], []) == []
    assert pool.transaction.call_count == 4


def test_tag_explicit_scope_and_embedding_return(candidates):
    db, _, _, _ = candidates
    assert db.get_neighbors_by_tag(["blue"], [], include_embedding=True, user_name="B") == [
        {
            "id": "foreign",
            "memory": "memory foreign",
            "metadata": {"tags": ["red", "blue"], "embedding": [1, 0, 0]},
        },
    ]


def test_tag_sql_binds_special_scope_and_excluded_ids(store):
    db, _, cursor = store
    cursor.fetchall.return_value = []
    scope, excluded = " 范围 ' $$ ", "节点 $memos$ ' ; --\n"
    assert db.get_neighbors_by_tag(["标签 ' $$"], [excluded], user_name=scope) == []
    statement, parameters = cursor.execute.call_args.args
    assert parameters == (scope, [excluded])
    assert scope not in statement and excluded not in statement


@pytest.mark.parametrize("tags,top_k", [([], 5), (["red"], 0)])
def test_empty_tag_queries_do_not_borrow(store, tags, top_k):
    db, pool, _ = store
    assert db.get_neighbors_by_tag(tags, [], top_k=top_k) == []
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"tags": "red"},
        {"tags": None},
        {"tags": [3]},
        {"tags": [" "]},
        {"exclude_ids": "a"},
        {"exclude_ids": [None]},
        {"exclude_ids": [""]},
        {"top_k": -1},
        {"top_k": True},
        {"top_k": 1.5},
        {"min_overlap": 0},
        {"min_overlap": True},
        {"min_overlap": "1"},
        {"include_embedding": 1},
        {"user_name": ""},
    ],
)
def test_invalid_tag_arguments_reject_before_borrowing(store, kwargs):
    db, pool, _ = store
    with pytest.raises(ValueError):
        db.get_neighbors_by_tag(**{"tags": ["red"], "exclude_ids": [], **kwargs})
    pool.transaction.assert_not_called()


@pytest.mark.parametrize("tags", ["not-json", '"red"', "{}", "[1]", [1], {}, 1, "[null]"])
def test_corrupted_candidate_tags_fail_explicitly(candidates, tags):
    db, _, _, nodes = candidates
    nodes[("A", "a")]["tags"] = tags
    with pytest.raises(GraphDBError, match="tags"):
        db.get_neighbors_by_tag(["red"], [])


@pytest.mark.parametrize(
    "method,args",
    [
        ("get_path", ("a", "b")),
        ("get_subgraph", ("a",)),
        ("get_neighbors_by_tag", ([], [])),
    ],
)
def test_closed_store_rejects_all_traversal_calls(store, method, args):
    db, pool, _ = store
    pool.ensure_open.side_effect = GraphDBError("closed")
    with pytest.raises(GraphDBError, match="closed"):
        getattr(db, method)(*args)
    pool.transaction.assert_not_called()


@pytest.mark.parametrize(
    "method,args",
    [
        ("get_path", ("a", "b")),
        ("get_subgraph", ("a",)),
        ("get_neighbors_by_tag", (["red"], [])),
    ],
)
def test_read_failures_propagate_and_leave_transaction(store, method, args):
    db, pool, cursor = store
    error = ValueError("synthetic SELECT failure")
    cursor.execute.side_effect = error
    with pytest.raises(ValueError) as caught:
        getattr(db, method)(*args)
    assert caught.value is error
    assert pool.transaction.return_value.__exit__.call_args.args[1] is error
