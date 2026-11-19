"""Opt-in deletion tests using isolated Neo4j and Qdrant services."""

import os

from uuid import uuid4

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.configs.vec_db import QdrantVecDBConfig
from memos.exceptions import VectorDBError
from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB
from memos.vec_dbs.item import VecDBItem
from memos.vec_dbs.qdrant import QdrantVecDB


@pytest.fixture
def stores():
    uri = os.getenv("MEMOS_TEST_DELETE_NEO4J_URI")
    url = os.getenv("MEMOS_TEST_DELETE_QDRANT_URL")
    if not uri or not url:
        pytest.skip(
            "Configure isolated MEMOS_TEST_DELETE_NEO4J_URI and MEMOS_TEST_DELETE_QDRANT_URL"
        )
    neo4j = pytest.importorskip("neo4j")
    run_id = uuid4().hex
    scope = f"delete-test-{run_id}"
    db = Neo4jCommunityGraphDB.__new__(Neo4jCommunityGraphDB)
    db.config = Neo4jGraphDBConfig(
        uri=uri,
        user="neo4j",
        password="test-password",
        db_name="neo4j",
        user_name=scope,
        auto_create=False,
        use_multi_db=False,
    )
    db.db_name = "neo4j"
    db.driver = neo4j.GraphDatabase.driver(uri, auth=("neo4j", "test-password"))
    db.vec_db = QdrantVecDB(
        QdrantVecDBConfig(
            url=url,
            collection_name=f"delete_{run_id}",
            vector_dimension=3,
            distance_metric="cosine",
        )
    )
    ids = [str(uuid4()), str(uuid4())]
    nodes = [
        {"id": ids[0], "user_name": scope},
        {"id": ids[1], "user_name": scope + "-other"},
    ]
    try:
        with db.driver.session(database="neo4j") as session:
            session.run(
                "UNWIND $nodes AS row CREATE (n:Memory) SET n = row, "
                "n.test_run = $run, n.file_ids = ['synthetic-file'], "
                "n.user_id = 'synthetic-user'",
                nodes=nodes,
                run=run_id,
            ).consume()
        db.vec_db.add(
            [
                VecDBItem(
                    id=node["id"],
                    vector=[0.1, 0.2, 0.3],
                    payload={"user_name": node["user_name"]},
                )
                for node in nodes
            ]
        )
        yield db, ids, scope
    finally:
        with db.driver.session(database="neo4j") as session:
            session.run("MATCH (n:Memory {test_run: $run}) DETACH DELETE n", run=run_id).consume()
        db.vec_db.delete_collection(db.vec_db.config.collection_name)
        db.vec_db.client.close()
        db.driver.close()


def remaining_graph_ids(db):
    with db.driver.session(database="neo4j") as session:
        return {record["id"] for record in session.run("MATCH (n:Memory) RETURN n.id AS id")}


@pytest.mark.parametrize("delete_mode", ["ids", "file", "filter"])
def test_successful_delete_removes_both_stores_only_in_requested_cube(stores, delete_mode):
    db, ids, scope = stores
    arguments = {
        "ids": {"memory_ids": ids},
        "file": {"file_ids": ["synthetic-file"]},
        "filter": {"filter": {"user_id": "synthetic-user"}},
    }[delete_mode]

    assert db.delete_node_by_prams(writable_cube_ids=[scope], **arguments) == 1

    assert ids[0] not in remaining_graph_ids(db)
    assert ids[1] in remaining_graph_ids(db)
    assert db.vec_db.get_by_ids([ids[0]]) == []
    assert [item.id for item in db.vec_db.get_by_ids([ids[1]])] == [ids[1]]
    assert db.delete_node_by_prams(writable_cube_ids=[scope], **arguments) == 0


@pytest.mark.parametrize("partial_vector_delete", [False, True])
def test_vector_failure_rolls_back_graph_and_can_be_retried(
    stores, monkeypatch, partial_vector_delete
):
    db, ids, scope = stores
    delete_vectors = db.vec_db.delete

    def fail(_ids):
        if partial_vector_delete:
            delete_vectors(_ids)
        raise OSError("Synthetic vector outage")

    monkeypatch.setattr(db.vec_db, "delete", fail)
    with pytest.raises(VectorDBError):
        db.delete_node_by_prams(writable_cube_ids=[scope], memory_ids=[ids[0]])

    assert ids[0] in remaining_graph_ids(db)
    remaining_vectors = db.vec_db.get_by_ids([ids[0]])
    assert [item.id for item in remaining_vectors] == ([] if partial_vector_delete else [ids[0]])

    monkeypatch.setattr(db.vec_db, "delete", delete_vectors)
    assert db.delete_node_by_prams(writable_cube_ids=[scope], memory_ids=[ids[0]]) == 1
    assert ids[0] not in remaining_graph_ids(db)
    assert db.vec_db.get_by_ids([ids[0]]) == []


def test_graph_commit_failure_remains_retryable_after_vector_cleanup(stores, monkeypatch):
    db, ids, scope = stores
    with db.driver.session(database="neo4j") as session, session.begin_transaction() as transaction:
        transaction_type = type(transaction)
    commit = transaction_type.commit

    def fail_commit(self):
        raise OSError("Synthetic graph commit failure")

    monkeypatch.setattr(transaction_type, "commit", fail_commit)
    with pytest.raises(OSError, match="Synthetic graph commit failure"):
        db.delete_node_by_prams(writable_cube_ids=[scope], memory_ids=[ids[0]])

    assert ids[0] in remaining_graph_ids(db)
    assert db.vec_db.get_by_ids([ids[0]]) == []

    monkeypatch.setattr(transaction_type, "commit", commit)
    assert db.delete_node_by_prams(writable_cube_ids=[scope], memory_ids=[ids[0]]) == 1
    assert ids[0] not in remaining_graph_ids(db)
