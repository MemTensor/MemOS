"""Opt-in graph reorganization checks against an isolated Neo4j instance."""

import json
import os
import re

from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB
from memos.memories.textual.tree_text_memory.organize.reorganizer import GraphStructureReorganizer


@pytest.fixture(params=[Neo4jGraphDB, Neo4jCommunityGraphDB])
def graph(request):
    uri = os.getenv("MEMOS_TEST_REORGANIZE_NEO4J_URI")
    if not uri:
        pytest.skip("Configure isolated MEMOS_TEST_REORGANIZE_NEO4J_URI")
    neo4j = pytest.importorskip("neo4j")
    run = uuid4().hex
    tenants = [f"reorganize-{run}-alice", f"reorganize-{run}-bob"]
    db = request.param.__new__(request.param)
    db.config = Neo4jGraphDBConfig(
        uri=uri,
        user="neo4j",
        password="test-password",
        db_name="neo4j",
        use_multi_db=False,
        auto_create=False,
        user_name=f"reorganize-{run}-default",
        embedding_dimension=3,
    )
    db.db_name = "neo4j"
    db.driver = neo4j.GraphDatabase.driver(uri, auth=("neo4j", "test-password"))
    if isinstance(db, Neo4jCommunityGraphDB):
        db.vec_db = MagicMock()
        db.vec_db.get_by_id.return_value = None
    try:
        for tenant in tenants:
            for index in range(3):
                db.add_node(
                    str(uuid4()),
                    f"{tenant} synthetic memory {index}",
                    {
                        "memory_type": "LongTermMemory",
                        "status": "activated",
                        "key": "topic",
                        "embedding": [0.1, 0.2, 0.3],
                    },
                    user_name=tenant,
                )
        yield db, tenants
    finally:
        with db.driver.session(database="neo4j") as session:
            session.run(
                "MATCH (n:Memory) WHERE n.user_name IN $tenants DETACH DELETE n",
                tenants=tenants,
            ).consume()
        db.driver.close()


@pytest.mark.parametrize("malformed_tenant", [False, True])
def test_native_reorganization_keeps_tenants_isolated(graph, malformed_tenant):
    db, tenants = graph
    llm = MagicMock()

    def generate(messages):
        prompt = messages[0]["content"]
        if malformed_tenant and tenants[1] in prompt:
            return "Synthetic non-JSON completion"
        if '"clusters"' in prompt:
            ids = re.findall(r"- ID: (\S+) \|", prompt)
            return json.dumps({"clusters": [{"ids": ids}]})
        return '{"key": "topic", "value": "Synthetic summary", "tags": [], "summary": ""}'

    llm.generate.side_effect = generate
    embedder = MagicMock()
    embedder.embed.return_value = [[0.1, 0.2, 0.3]]
    reorganizer = GraphStructureReorganizer(db, llm, embedder, is_reorganize=False)

    assert db.get_all_user_names() == sorted(tenants)
    reorganizer._optimize_all_users("LongTermMemory", min_group_size=3, min_cluster_size=2)

    with db.driver.session(database="neo4j") as session:
        parents = [
            dict(record)
            for record in session.run(
                "MATCH (n:Memory) WHERE n.user_name IN $tenants AND n.type = 'topic' "
                "RETURN n.user_name AS tenant",
                tenants=tenants,
            )
        ]
        edges = [
            dict(record)
            for record in session.run(
                "MATCH (a:Memory)-[:PARENT]->(b:Memory) WHERE a.user_name IN $tenants "
                "RETURN a.user_name AS source_tenant, b.user_name AS target_tenant",
                tenants=tenants,
            )
        ]
    expected = tenants[:1] if malformed_tenant else tenants
    assert sorted(parent["tenant"] for parent in parents) == sorted(expected)
    assert len(edges) == 3 * len(expected)
    assert all(edge["source_tenant"] == edge["target_tenant"] for edge in edges)
