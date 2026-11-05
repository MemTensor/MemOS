"""Real PostgreSQL lifecycle ownership tests; enable with MEMOS_TEST_PG_DSN."""

from __future__ import annotations

import json
import os

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from memos.configs.graph_db import PostgresGraphDBConfig
from memos.dream.lifecycle import LIFECYCLE_METADATA_KEY, LifecycleConfig, initialize_state
from memos.exceptions import MemoryError as MemOSMemoryError
from memos.graph_dbs.base import NodeMetadataUpdate
from memos.graph_dbs.postgres import PostgresGraphDB


@pytest.fixture(scope="module")
def graph():
    dsn = os.environ.get("MEMOS_TEST_PG_DSN")
    if not dsn:
        pytest.skip("MEMOS_TEST_PG_DSN not configured")
    psycopg2 = pytest.importorskip("psycopg2")
    from psycopg2 import sql
    from psycopg2.extensions import parse_dsn

    settings = parse_dsn(dsn)
    schema = "dream_lifecycle_" + uuid4().hex
    config = PostgresGraphDBConfig(
        host=settings.get("host", "localhost"),
        port=int(settings.get("port", 5432)),
        user=settings["user"],
        password=settings.get("password", ""),
        db_name=settings["dbname"],
        schema_name=schema,
        user_name="cube-a",
        embedding_dimension=3,
    )
    backend = PostgresGraphDB(config)
    yield backend
    backend.close()
    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))
    conn.close()


def add(graph, *, archived=False):
    memory_id = "memory-" + uuid4().hex
    state = initialize_state(
        memory_id=memory_id,
        cube_id="cube-a",
        created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        config=LifecycleConfig(),
    ).model_copy(
        update={"protect_archived_status": archived, "status": "archived" if archived else "active"}
    )
    graph.add_node(
        memory_id,
        "Synthetic memory",
        {
            "source": "dream",
            "status": "archived" if archived else "activated",
            LIFECYCLE_METADATA_KEY: state.model_dump(mode="json"),
            "counter": 0,
        },
        user_name="cube-a",
    )
    return memory_id


def test_concurrent_atomic_updates_keep_every_committed_observation(graph):
    memory_id = add(graph)

    def increment(_):
        return graph.mutate_nodes_metadata(
            [memory_id],
            lambda _id, metadata: NodeMetadataUpdate({"counter": metadata["counter"] + 1}),
            user_name="cube-a",
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(increment, range(16)))
    assert all(result[0].found and result[0].changed for result in results)
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["counter"] == 16


def test_stale_ordinary_write_cannot_erase_committed_lifecycle_hit(graph):
    memory_id = add(graph)
    stale = graph.get_node(memory_id, user_name="cube-a")["metadata"]

    def hit(_id, metadata):
        life = {**metadata[LIFECYCLE_METADATA_KEY], "hit_count": 1, "revision": 1}
        return NodeMetadataUpdate({LIFECYCLE_METADATA_KEY: life})

    graph.mutate_nodes_metadata([memory_id], hit, user_name="cube-a")
    graph.update_node(memory_id, {**stale, "memory": "Content changed"}, user_name="cube-a")
    result = graph.get_node(memory_id, user_name="cube-a")
    assert result["memory"] == "Content changed"
    assert result["metadata"][LIFECYCLE_METADATA_KEY]["hit_count"] == 1
    assert result["metadata"][LIFECYCLE_METADATA_KEY]["revision"] == 1


def test_context_style_upsert_preserves_invalidated_archive_and_evidence(graph):
    memory_id = add(graph, archived=True)
    previous = graph.get_node(memory_id, user_name="cube-a")["metadata"][LIFECYCLE_METADATA_KEY]
    graph.add_node(
        memory_id,
        "Refreshed context",
        {"source": "system", "status": "activated"},
        user_name="cube-a",
    )
    result = graph.get_node(memory_id, user_name="cube-a")
    assert result["memory"] == "Refreshed context"
    assert result["metadata"]["status"] == "archived"
    assert result["metadata"][LIFECYCLE_METADATA_KEY] == previous


def test_ordinary_status_write_cannot_restore_protected_archive(graph):
    memory_id = add(graph, archived=True)
    graph.update_node(
        memory_id, {"status": "activated", LIFECYCLE_METADATA_KEY: {}}, user_name="cube-a"
    )
    result = graph.get_node(memory_id, user_name="cube-a")
    assert result["metadata"]["status"] == "archived"
    assert result["metadata"][LIFECYCLE_METADATA_KEY]["protect_archived_status"] is True


def test_atomic_capability_can_perform_deliberate_recovery(graph):
    memory_id = add(graph, archived=True)

    def recover(_id, metadata):
        life = {
            **metadata[LIFECYCLE_METADATA_KEY],
            "protect_archived_status": False,
            "status": "active",
        }
        return NodeMetadataUpdate(
            {LIFECYCLE_METADATA_KEY: life, "status": "activated"}, result="restored"
        )

    result = graph.mutate_nodes_metadata([memory_id], recover, user_name="cube-a")
    assert result[0].result == "restored"
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["status"] == "activated"


def test_scope_mismatch_cannot_run_a_mutation(graph):
    memory_id = add(graph)

    def forbidden(_id, _metadata):
        pytest.fail("Foreign-scope mutation was invoked")

    result = graph.mutate_nodes_metadata([memory_id], forbidden, user_name="cube-b")
    assert not result[0].found
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["counter"] == 0


def test_foreign_upsert_cannot_take_over_a_lifecycle_owned_id(graph):
    memory_id = add(graph)
    with pytest.raises(MemOSMemoryError):
        graph.add_node(memory_id, "Foreign replacement", {"source": "dream"}, user_name="cube-b")
    assert graph.get_node(memory_id, user_name="cube-a")["memory"] == "Synthetic memory"


def test_callback_failure_rolls_back_the_entire_batch(graph):
    memory_ids = sorted([add(graph), add(graph)])

    def update(memory_id, _metadata):
        if memory_id == memory_ids[1]:
            raise MemOSMemoryError("Synthetic failed reduction")
        return NodeMetadataUpdate({"counter": 42})

    with pytest.raises(MemOSMemoryError):
        graph.mutate_nodes_metadata(memory_ids, update, user_name="cube-a")
    assert [
        graph.get_node(item, user_name="cube-a")["metadata"]["counter"] for item in memory_ids
    ] == [0, 0]
    # A subsequent operation proves rollback/autocommit restoration before pool reuse.
    graph.update_node(memory_ids[0], {"counter": 1}, user_name="cube-a")
    assert graph.get_node(memory_ids[0], user_name="cube-a")["metadata"]["counter"] == 1


def test_read_only_reducer_does_not_update_metadata_timestamps(graph):
    memory_id = add(graph)
    before = graph.get_node(memory_id, user_name="cube-a")["metadata"]
    result = graph.mutate_nodes_metadata(
        [memory_id],
        lambda _id, _metadata: NodeMetadataUpdate(None, result="inspect"),
        user_name="cube-a",
    )
    assert result[0].result == "inspect"
    assert not result[0].changed
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"] == before


def test_keyset_pages_are_bounded_unique_and_scoped(graph):
    own = {add(graph) for _ in range(5)}
    after = None
    seen = []
    while True:
        page = graph.list_lifecycle_nodes(user_name="cube-a", after=after, limit=2)
        assert len(page) <= 2
        if not page:
            break
        seen.extend(row["id"] for row in page)
        after = page[-1]["id"]
    assert own <= set(seen)
    assert len(seen) == len(set(seen))
    assert graph.list_lifecycle_nodes(user_name="cube-b", limit=2) == []


def test_legacy_write_semantics_and_embedding_survive_managed_updates(graph):
    memory_id = "legacy-" + uuid4().hex
    graph.add_node(
        memory_id,
        "Original",
        {"status": "activated", "old": 1, "embedding": [1, 0, 0]},
        user_name="cube-a",
    )
    fields = {"memory": "Merged", "new": 2}
    graph.update_node(memory_id, fields, user_name="cube-a")
    assert fields == {"memory": "Merged", "new": 2}
    assert graph.get_node(memory_id, user_name="cube-a")["metadata"]["old"] == 1
    graph.add_node(memory_id, "Replaced", {"status": "archived", "new": 3}, user_name="cube-a")
    result = graph.get_node(memory_id, include_embedding=True, user_name="cube-a")
    assert result["memory"] == "Replaced"
    assert "old" not in result["metadata"]
    assert result["metadata"]["status"] == "archived"
    assert json.loads(result["metadata"]["embedding"]) == [1, 0, 0]


@pytest.mark.parametrize(
    "envelope", [None, [], {"version": 99}, {"protect_archived_status": "false"}]
)
def test_malformed_envelope_remains_quarantined_across_ordinary_writers(graph, envelope):
    memory_id = "quarantine-" + uuid4().hex
    graph.add_node(
        memory_id,
        "Original",
        {LIFECYCLE_METADATA_KEY: envelope, "status": "archived"},
        user_name="cube-a",
    )
    graph.update_node(memory_id, {"status": "activated"}, user_name="cube-a")
    graph.add_node(memory_id, "New", {"status": "activated"}, user_name="cube-a")
    result = graph.get_node(memory_id, user_name="cube-a")["metadata"]
    assert result[LIFECYCLE_METADATA_KEY] == envelope
    assert result["status"] == "archived"


def test_invalid_patch_serialization_rolls_back_earlier_rows(graph):
    memory_ids = sorted([add(graph), add(graph)])
    with pytest.raises(ValueError):
        graph.mutate_nodes_metadata(
            memory_ids,
            lambda item, _meta: NodeMetadataUpdate(
                {"counter": 1 if item == memory_ids[0] else float("nan")}
            ),
            user_name="cube-a",
        )
    assert [
        graph.get_node(item, user_name="cube-a")["metadata"]["counter"] for item in memory_ids
    ] == [0, 0]


@pytest.mark.parametrize("limit", [0, -1, 1001, True, 1.5])
def test_invalid_page_limit_rejected_before_query(graph, limit):
    with pytest.raises(MemOSMemoryError):
        graph.list_lifecycle_nodes(user_name="cube-a", limit=limit)
