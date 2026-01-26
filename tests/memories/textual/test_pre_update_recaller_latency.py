import time
import unittest
import uuid

import numpy as np

from dotenv import load_dotenv

from memos.api.handlers.config_builders import build_embedder_config, build_graph_db_config
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.memories.textual.tree_text_memory.retrieve.pre_update import PreUpdateRecaller


# Load environment variables
load_dotenv()


class TestPreUpdateRecallerLatency(unittest.TestCase):
    """
    Performance and latency tests for PreUpdateRecaller.
    These tests are designed to measure latency and might take longer to run.
    """

    @classmethod
    def setUpClass(cls):
        # Initialize graph_db and embedder using factories
        try:
            cls.graph_db_config = build_graph_db_config()
            cls.graph_db = GraphStoreFactory.from_config(cls.graph_db_config)

            cls.embedder_config = build_embedder_config()
            cls.embedder = EmbedderFactory.from_config(cls.embedder_config)
        except Exception as e:
            raise unittest.SkipTest(
                f"Skipping test because initialization failed (likely missing env vars): {e}"
            ) from e

        cls.recaller = PreUpdateRecaller(cls.graph_db, cls.embedder)

        # Use a unique user name to isolate tests
        cls.user_name = "test_pre_update_recaller_latency_user_" + str(uuid.uuid4())[:8]

    def setUp(self):
        # Add a substantial amount of data for latency testing
        self.added_ids = []
        self.num_items = 20

        print(f"\nPopulating database with {self.num_items} items for latency test...")
        for i in range(self.num_items):
            text = f"This is memory item number {i}. The user might enjoy topic {i % 5}."
            embedding = self.embedder.embed([text])[0]
            metadata = {
                "memory_type": "LongTermMemory",
                "status": "activated",
                "embedding": embedding,
                "created_at": "2023-01-01T00:00:00",
                "updated_at": "2023-01-01T00:00:00",
                "tags": [f"tag_{i}"],
                "key": f"key_{i}",
                "sources": [],
            }
            node_id = str(uuid.uuid4())
            self.graph_db.add_node(node_id, text, metadata, user_name=self.user_name)
            self.added_ids.append(node_id)

    def tearDown(self):
        """Clean up test data."""
        print("Cleaning up test data...")
        for node_id in self.added_ids:
            try:
                self.graph_db.delete_node(node_id, user_name=self.user_name)
            except Exception as e:
                print(f"Error deleting node {node_id}: {e}")

    def measure_network_rtt(self, trials=10):
        """Measure average network round-trip time."""
        print(f"Measuring Network RTT (using {trials} probes)...")
        latencies = []

        # Try to use raw driver for minimal overhead if available (Neo4j specific)
        if hasattr(self.graph_db, "driver") and hasattr(self.graph_db, "db_name"):
            print("Using Neo4j driver for direct ping...")
            try:
                with self.graph_db.driver.session(database=self.graph_db.db_name) as session:
                    # Warmup
                    session.run("RETURN 1").single()

                    for _ in range(trials):
                        start = time.time()
                        session.run("RETURN 1").single()
                        latencies.append((time.time() - start) * 1000)
            except Exception as e:
                print(f"Direct driver ping failed: {e}. Falling back to get_node.")
                latencies = []

        if not latencies:
            # Fallback to get_node with non-existent ID
            print("Using get_node for ping...")
            for _ in range(trials):
                probe_id = str(uuid.uuid4())
                start = time.time()
                self.graph_db.get_node(probe_id, user_name=self.user_name)
                latencies.append((time.time() - start) * 1000)

        avg_rtt = np.mean(latencies)
        print(f"Average Network RTT: {avg_rtt:.2f} ms")
        return avg_rtt

    def test_recall_latency(self):
        """Test and report recall latency statistics."""
        avg_rtt = self.measure_network_rtt()

        queries = [
            "I enjoy topic 1",
            "What about topic 3?",
            "Do I have any preferences?",
            "Tell me about memory item 5",
        ]

        latencies = []

        # Warmup
        print("Warming up...")
        warmup_item = TextualMemoryItem(
            memory="warmup query",
            metadata=TreeNodeTextualMemoryMetadata(
                sources=[SourceMessage(role="user", lang="en")], memory_type="WorkingMemory"
            ),
        )
        self.recaller.recall(warmup_item, self.user_name, top_k=5)

        print(f"Running {len(queries)} queries...")
        for q in queries:
            # Pre-calculate embedding to exclude from latency measurement
            q_embedding = self.embedder.embed([q])[0]

            item = TextualMemoryItem(
                memory=q,
                metadata=TreeNodeTextualMemoryMetadata(
                    sources=[SourceMessage(role="user", lang="en")],
                    memory_type="WorkingMemory",
                    embedding=q_embedding,
                ),
            )

            start_time = time.time()
            results = self.recaller.recall(item, self.user_name, top_k=5)
            end_time = time.time()

            duration_ms = (end_time - start_time) * 1000
            latencies.append(duration_ms)
            print(f"Query: '{q}' -> Found {len(results)} results in {duration_ms:.2f} ms")

            # Assert that we actually found results (sanity check)
            if "preferences" not in q:  # The preferences query might return 0
                self.assertTrue(len(results) > 0, f"Expected results for query: {q}")

        # Report Results
        avg_latency = np.mean(latencies)
        p95_latency = np.percentile(latencies, 95)
        min_latency = np.min(latencies)
        max_latency = np.max(latencies)
        internal_processing = avg_latency - avg_rtt

        print("\n--- Latency Results ---")
        print(f"Average Network RTT: {avg_rtt:.2f} ms")
        print(f"Average Total Latency: {avg_latency:.2f} ms")
        print(f"Estimated Internal Processing: {internal_processing:.2f} ms")
        print(f"95th Percentile: {p95_latency:.2f} ms")
        print(f"Min Latency:     {min_latency:.2f} ms")
        print(f"Max Latency:     {max_latency:.2f} ms")

        self.assertLess(internal_processing, 200, "Internal processing should be under 200ms")


if __name__ == "__main__":
    unittest.main()
