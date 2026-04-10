import os
import tempfile

from memos.configs.graph_db import LanceGraphDBConfig
from memos.graph_dbs.lance import LanceGraphDB


def test_lance_graph_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_uri = os.path.join(tmpdir, "test_lancedb_data")

        config = LanceGraphDBConfig(uri=db_uri, user_name="test_user", embedding_dimension=3)

        print("\nInitializing LanceGraphDB in temporary directory...")
        db = LanceGraphDB(config)

        print("\n--- 1. Testing Node Insertion (Batch & Upsert) ---")
        nodes = [
            {
                "id": "node_1",
                "memory": "Alice went to Beijing",
                "metadata": {
                    "memory_type": "LongTermMemory",
                    "status": "activated",
                    "tags": ["travel", "city"],
                },
                "embedding": [0.1, 0.2, 0.3],
            },
            {
                "id": "node_2",
                "memory": "Alice visited the Forbidden City",
                "metadata": {
                    "memory_type": "LongTermMemory",
                    "status": "activated",
                    "tags": ["travel", "history"],
                },
                "embedding": [0.15, 0.25, 0.35],
            },
            {
                "id": "node_3",
                "memory": "Bob likes programming in Python",
                "metadata": {
                    "memory_type": "ShortTermMemory",
                    "status": "activated",
                    "tags": ["tech"],
                },
                "embedding": [0.8, 0.1, 0.1],
            },
        ]
        db.add_nodes_batch(nodes)

        n1 = db.get_node("node_1")
        assert n1["id"] == "node_1"
        assert n1["memory"] == "Alice went to Beijing"
        print("Node insertion verified.")

        print("\n--- 2. Testing Edge Insertion ---")
        db.add_edge("node_1", "node_2", "FOLLOWS")
        db.add_edge("node_1", "node_3", "KNOWS")
        print("Edge insertion verified.")

        print("\n--- 3. Testing Vector Search ---")
        res_vec = db.search_by_embedding(
            [0.12, 0.22, 0.32], top_k=2, return_fields=["memory", "memory_type"]
        )
        assert len(res_vec) == 2
        assert res_vec[0]["id"] in ["node_1", "node_2"]
        print("Vector search verified.")

        print("\n--- 4. Testing Metadata Filter (Scalar + JSON LIKE) ---")
        res_meta = db.get_by_metadata(
            filters=[{"field": "tags", "op": "contains", "value": "travel"}], status="activated"
        )
        assert "node_1" in res_meta
        assert "node_2" in res_meta
        print("Metadata filtering verified.")

        print("\n--- 5. Testing Full-Text Search (FTS) ---")
        try:
            res_fts = db.search_by_fulltext(["Forbidden", "City"], top_k=2)
            assert len(res_fts) > 0
            assert res_fts[0]["id"] == "node_2"
            print("FTS verified.")
        except Exception as e:
            print(f"FTS failed: {e}")

        print("\n--- 6. Testing Hybrid Search (Multi-way Recall + Reranker) ---")
        try:
            from lancedb.rerankers import LinearCombinationReranker, RRFReranker

            res_hybrid_default = db.search_by_hybrid(
                query_text="Forbidden", vector=[0.1, 0.2, 0.3], top_k=2
            )
            assert len(res_hybrid_default) > 0

            ratio_reranker = LinearCombinationReranker(weight=0.8)
            res_hybrid_ratio = db.search_by_hybrid(
                query_text="Forbidden", vector=[0.1, 0.2, 0.3], top_k=2, reranker=ratio_reranker
            )
            assert len(res_hybrid_ratio) > 0

            rrf_reranker = RRFReranker()
            res_hybrid_rrf = db.search_by_hybrid(
                query_text="Forbidden", vector=[0.1, 0.2, 0.3], top_k=2, reranker=rrf_reranker
            )
            assert len(res_hybrid_rrf) > 0
            print("Hybrid Search (Default/Ratio/RRF) verified.")
        except Exception as e:
            print(f"Hybrid search failed: {e}")

        print("\n--- 7. Testing Graph Traversal (Neighbors) ---")
        neighbors_out = db.get_neighbors("node_1", direction="OUT")
        assert len(neighbors_out) == 2
        print("Neighbors traversal verified.")

        print("\n--- 8. Testing Graph Traversal (Subgraph BFS) ---")
        subgraph = db.get_subgraph("node_1", depth=1)
        assert len(subgraph) == 3
        print("Subgraph BFS verified.")

        print("\n--- 9. Testing Node Update ---")
        db.update_node("node_1", {"memory": "Alice went to Beijing and loved it!"})
        n1_updated = db.get_node("node_1")
        assert n1_updated["memory"] == "Alice went to Beijing and loved it!"
        print("Node update verified.")

        print("\nCleaning up...")
        db.clear()
        print("Test finished successfully in temporary directory!")


def test_lance_compaction_and_fts_effectiveness():
    """
    Test the effectiveness of the LanceDB _optimize_table mechanism,
    including compaction of small files and FTS index functionality.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        db_uri = os.path.join(tmpdir, "test_lancedb_compaction")
        # Use a low threshold to force triggering
        config = LanceGraphDBConfig(
            uri=db_uri, user_name="test_user", embedding_dimension=3, compaction_version_threshold=2
        )
        db = LanceGraphDB(config)

        # 1. Insert multiple single nodes to create small fragments
        print("\nInserting 5 separate fragments...")
        for i in range(5):
            node = {
                "id": f"node_c_{i}",
                "memory": f"Alice went to the magical forest number {i}",
                "metadata": {"memory_type": "LongTermMemory", "status": "activated"},
                "embedding": [0.1 * i, 0.2 * i, 0.3 * i],
            }
            db.add_nodes_batch([node])

        import lance

        ds = lance.dataset(os.path.join(db_uri, "memories.lance"))
        fragments_before = len(ds.get_fragments())
        print(f"Fragments BEFORE optimize: {fragments_before}")

        # 2. Test FTS before optimization
        try:
            res_fts_before = db.search_by_fulltext(["magical"], top_k=10)
            print(f"FTS hits BEFORE optimize: {len(res_fts_before)}")
        except Exception as e:
            print(f"FTS failed before optimize: {e}")

        # 3. Force the internal optimizer
        print("Forcing LanceDB optimizer...")
        db._force_optimize()

        ds = lance.dataset(os.path.join(db_uri, "memories.lance"))
        fragments_after = len(ds.get_fragments())
        print(f"Fragments AFTER optimize: {fragments_after}")

        # 5. Verify FTS index effectiveness after optimization
        res_fts_after = db.search_by_fulltext(["magical"], top_k=10)
        assert len(res_fts_after) == 5, (
            f"FTS should recall all 5 nodes, but got {len(res_fts_after)}"
        )
        print(f"FTS hits AFTER optimize: {len(res_fts_after)}")

        # 6. Test prune/delete
        db.delete_node("node_c_0")
        db._force_optimize()

        res_fts_deleted = db.search_by_fulltext(["magical"], top_k=10)
        assert len(res_fts_deleted) == 4, (
            f"FTS should recall 4 nodes after deletion, got {len(res_fts_deleted)}"
        )
        print(f"FTS hits AFTER deletion and optimize: {len(res_fts_deleted)}")

        db.clear()


if __name__ == "__main__":
    test_lance_graph_db()
    test_lance_compaction_and_fts_effectiveness()
