import unittest
import uuid

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


class TestPreUpdateRecaller(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Initialize graph_db and embedder using factories
        # We assume environment variables are set for these to work
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
        cls.user_name = "test_pre_update_recaller_user_" + str(uuid.uuid4())[:8]

    def setUp(self):
        # Add some data to the db
        self.added_ids = []

        # Create a memory item to add
        self.memory_text = "The user likes to eat apples."
        self.embedding = self.embedder.embed([self.memory_text])[0]

        # We use dictionary for metadata to simulate what might be passed or stored
        # But wait, add_node expects metadata as a dict usually.
        metadata = {
            "memory_type": "LongTermMemory",
            "status": "activated",
            "embedding": self.embedding,
            "created_at": "2023-01-01T00:00:00",
            "updated_at": "2023-01-01T00:00:00",
            "tags": ["food", "fruit"],
            "key": "user_preference",
            "sources": [],
        }

        node_id = str(uuid.uuid4())
        self.graph_db.add_node(node_id, self.memory_text, metadata, user_name=self.user_name)
        self.added_ids.append(node_id)

        # Add another one
        self.memory_text_2 = "The user has a dog named Rex."
        self.embedding_2 = self.embedder.embed([self.memory_text_2])[0]
        metadata_2 = {
            "memory_type": "LongTermMemory",
            "status": "activated",
            "embedding": self.embedding_2,
            "created_at": "2023-01-01T00:00:00",
            "updated_at": "2023-01-01T00:00:00",
            "tags": ["pet", "dog"],
            "key": "user_pet",
            "sources": [],
        }
        node_id_2 = str(uuid.uuid4())
        self.graph_db.add_node(node_id_2, self.memory_text_2, metadata_2, user_name=self.user_name)
        self.added_ids.append(node_id_2)

    def tearDown(self):
        """Clean up test data."""
        for node_id in self.added_ids:
            try:
                self.graph_db.delete_node(node_id, user_name=self.user_name)
            except Exception as e:
                print(f"Error deleting node {node_id}: {e}")

    def test_recall_vector_search(self):
        """Test recalling using vector search (implicit in recall method)."""
        # "I like apples" -> perspective adjustment should match "The user likes to eat apples"
        query_text = "I like apples"

        # Create metadata with source to trigger perspective adjustment
        # role="user" means "I" -> "User"
        source = SourceMessage(role="user", lang="en")
        metadata = TreeNodeTextualMemoryMetadata(sources=[source], memory_type="WorkingMemory")

        item = TextualMemoryItem(memory=query_text, metadata=metadata)

        # The recall method does both vector and keyword search
        results = self.recaller.recall(item, self.user_name, top_k=5)

        # Verify we got results
        self.assertTrue(len(results) > 0, "Should return at least one result")
        found_texts = [r.memory for r in results]

        # Check if the relevant memory is found
        # "The user likes to eat apples." should be found.
        # We check for "apples" to be safe
        self.assertTrue(
            any("apples" in t for t in found_texts),
            f"Expected 'apples' in results, got: {found_texts}",
        )

    def test_recall_keyword_search(self):
        """Test recalling where keyword search might be more relevant."""
        # "Rex" is a specific name
        query_text = "What is the name of my dog?"
        source = SourceMessage(role="user", lang="en")
        metadata = TreeNodeTextualMemoryMetadata(sources=[source], memory_type="WorkingMemory")

        item = TextualMemoryItem(memory=query_text, metadata=metadata)

        results = self.recaller.recall(item, self.user_name, top_k=5)

        found_texts = [r.memory for r in results]
        self.assertTrue(
            any("Rex" in t for t in found_texts), f"Expected 'Rex' in results, got: {found_texts}"
        )

    def test_perspective_adjustment(self):
        """Unit test for the _adjust_perspective method specifically."""
        text = "I went to the store myself."
        adjusted = self.recaller._adjust_perspective(text, "user", "en")
        # I -> User, myself -> User himself
        self.assertIn("User", adjusted)
        self.assertIn("User himself", adjusted)

        text_zh = "我喜欢吃苹果"
        adjusted_zh = self.recaller._adjust_perspective(text_zh, "user", "zh")
        # 我 -> 用户
        self.assertIn("用户", adjusted_zh)


if __name__ == "__main__":
    unittest.main()
