# TODO: Overcomplex. Use pytest fixtures instead of setUp/tearDown.
import json
import os
import unittest
import uuid

from unittest.mock import MagicMock, mock_open, patch

from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.configs.memory import GeneralTextMemoryConfig
from memos.configs.vec_db import VectorDBConfigFactory
from memos.embedders.factory import OllamaEmbedder
from memos.llms.factory import OllamaLLM
from memos.memories.textual.general import GeneralTextMemory
from memos.memories.textual.item import TextualMemoryItem
from memos.vec_dbs.factory import QdrantVecDB
from memos.vec_dbs.item import VecDBItem


class TestGeneralTextMemory(unittest.TestCase):
    def setUp(self):
        # Mock configurations for GeneralTextMemoryConfig arguments
        self.mock_llm_config_arg = MagicMock(spec=LLMConfigFactory)
        self.mock_llm_config_arg.backend = "ollama"  # Example valid backend
        self.mock_llm_config_arg.config = {"model_name_or_path": "test-llm"}
        self.mock_llm_config_arg.model_schema = "memos.configs.llm.LLMConfigFactory"

        self.mock_embedder_config_arg = MagicMock(spec=EmbedderConfigFactory)
        self.mock_embedder_config_arg.backend = "ollama"  # Example valid backend
        self.mock_embedder_config_arg.config = {"model_name_or_path": "test-embedder"}
        self.mock_embedder_config_arg.model_schema = "memos.configs.embedder.EmbedderConfigFactory"

        self.mock_vector_db_config_arg = MagicMock(spec=VectorDBConfigFactory)
        self.mock_vector_db_config_arg.backend = "qdrant"  # Example valid backend
        self.mock_vector_db_config_arg.config = {"collection_name": "test-collection-for-factory"}
        self.mock_vector_db_config_arg.model_schema = "memos.configs.vec_db.VectorDBConfigFactory"

        # This mock_qdrant_config is for the *internal* config of the QdrantVecDB mock instance.
        # It is NOT passed directly to GeneralTextMemoryConfig.
        self.mock_qdrant_config = MagicMock()
        self.mock_qdrant_config.collection_name = "test_textual_memory_unittest"

        # Mocks for the actual LLM, VectorDB, Embedder instances that factories will return
        self.mock_llm = MagicMock(spec=OllamaLLM)
        self.mock_vector_db = MagicMock(spec=QdrantVecDB)
        # The mocked QdrantVecDB instance will have its .config attribute point to self.mock_qdrant_config
        self.mock_vector_db.config = self.mock_qdrant_config
        self.mock_embedder = MagicMock(spec=OllamaEmbedder)

        # Patch factories used in GeneralTextMemory constructor
        self.patcher_llm_factory = patch("memos.memories.textual.general.LLMFactory")
        self.patcher_vecdb_factory = patch("memos.memories.textual.general.VecDBFactory")
        self.patcher_embedder_factory = patch("memos.memories.textual.general.EmbedderFactory")

        self.mock_llm_factory = self.patcher_llm_factory.start()
        self.mock_vecdb_factory = self.patcher_vecdb_factory.start()
        self.mock_embedder_factory = self.patcher_embedder_factory.start()

        # Configure patched factories to return the above mocks
        self.mock_llm_factory.from_config.return_value = self.mock_llm
        self.mock_vecdb_factory.from_config.return_value = self.mock_vector_db
        self.mock_embedder_factory.from_config.return_value = self.mock_embedder

        # Instantiate GeneralTextMemoryConfig with the correctly specced *ConfigFactory mocks
        # that now have .backend and .config attributes
        self.config = GeneralTextMemoryConfig(
            extractor_llm=self.mock_llm_config_arg,
            vector_db=self.mock_vector_db_config_arg,
            embedder=self.mock_embedder_config_arg,
        )

        # Instantiate the class under test
        self.memory = GeneralTextMemory(self.config)

    def tearDown(self):
        self.patcher_llm_factory.stop()
        self.patcher_vecdb_factory.stop()
        self.patcher_embedder_factory.stop()

    def test_initialization(self):
        """Test that the memory components are initialized correctly."""
        # Assert that from_config was called with the *ConfigFactory instances
        self.mock_llm_factory.from_config.assert_called_once_with(self.mock_llm_config_arg)
        self.mock_vecdb_factory.from_config.assert_called_once_with(self.mock_vector_db_config_arg)
        self.mock_embedder_factory.from_config.assert_called_once_with(
            self.mock_embedder_config_arg
        )
        self.assertIs(self.memory.extractor_llm, self.mock_llm)
        self.assertIs(self.memory.vector_db, self.mock_vector_db)
        self.assertIs(self.memory.embedder, self.mock_embedder)

    def test_embed_one_sentence(self):
        """Test embedding a single sentence."""
        sentence = "This is a test sentence."
        expected_embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        self.mock_embedder.embed.return_value = [expected_embedding]

        embedding = self.memory._embed_one_sentence(sentence)

        self.mock_embedder.embed.assert_called_once_with(sentence)
        self.assertEqual(embedding, expected_embedding)

    def test_extract(self):
        """Test memory extraction from messages."""
        messages = [
            {"role": "user", "content": "I love tomatoes."},
            {"role": "assistant", "content": "Great! Tomatoes are delicious."},
        ]
        raw_memories = [
            {
                "memory": "User loves tomatoes.",
                "metadata": {"type": "opinion", "source": "conversation"},
            }
        ]
        self.mock_llm.generate.return_value = json.dumps(raw_memories)

        extracted_memories = self.memory.extract(messages)

        self.mock_llm.generate.assert_called_once()
        self.assertEqual(len(extracted_memories), 1)
        self.assertIsInstance(extracted_memories[0], TextualMemoryItem)
        self.assertEqual(extracted_memories[0].memory, "User loves tomatoes.")
        self.assertEqual(extracted_memories[0].metadata.type, "opinion")
        self.assertEqual(extracted_memories[0].metadata.source, "conversation")

    def test_extract_retry_on_json_decode_error(self):
        """Test retry logic for extract method when JSONDecodeError occurs."""
        messages = [{"role": "user", "content": "Test retry"}]
        valid_response_json = '[{"memory": "Test successful", "metadata": {"type": "fact", "source": "conversation", "confidence": 100.0, "visibility": "private"}}]'

        self.mock_llm.generate.side_effect = [
            json.JSONDecodeError("Error", "doc", 0),
            json.JSONDecodeError("Error", "doc", 0),
            valid_response_json,
        ]

        extracted_memories = self.memory.extract(messages)

        self.assertEqual(self.mock_llm.generate.call_count, 3)
        self.assertEqual(len(extracted_memories), 1)
        self.assertIsInstance(extracted_memories[0], TextualMemoryItem)
        self.assertEqual(extracted_memories[0].memory, "Test successful")
        # Check default metadata values are applied
        self.assertEqual(extracted_memories[0].metadata.type, "fact")
        self.assertEqual(extracted_memories[0].metadata.source, "conversation")
        self.assertEqual(extracted_memories[0].metadata.confidence, 100.0)
        self.assertEqual(extracted_memories[0].metadata.visibility, "private")

    def test_add_memories(self):
        """Test adding memories."""
        memories_to_add = [
            {
                "memory": "Memory 1",
                "metadata": {
                    "type": "fact",
                    "source": "conversation",
                    "confidence": 95.0,
                    "tags": ["test"],
                    "entities": ["memory"],
                    "visibility": "private",
                    "memory_time": "2025-05-23",
                    "updated_at": "2025-05-23T00:00:00",
                },
            },
            {
                "id": str(uuid.uuid4()),
                "memory": "Memory 2 with custom ID",
                "metadata": {
                    "type": "event",
                    "source": "conversation",
                    "confidence": 90.0,
                    "visibility": "private",
                },
            },
        ]

        embeddings = [[0.1] * 5, [0.2] * 5]
        self.mock_embedder.embed.return_value = embeddings

        self.memory.add(memories_to_add)

        self.mock_embedder.embed.assert_called_once_with(["Memory 1", "Memory 2 with custom ID"])

    def test_update_memory(self):
        """Test updating an existing memory."""
        memory_id_to_update = str(uuid.uuid4())
        new_memory_dict = {
            "id": memory_id_to_update,
            "memory": "This is the updated memory content via dict.",
            "metadata": {
                "type": "fact",
                "source": "conversation",
                "confidence": 95.0,
                "tags": ["test", "update", "dict"],
                "entities": ["memory system"],
                "visibility": "private",
                "memory_time": "2025-05-23",
                "updated_at": "2025-05-23T00:00:00",
            },
        }

        expected_embedding = [0.4] * 5
        self.mock_embedder.embed.return_value = [expected_embedding]

        self.memory.update(memory_id_to_update, new_memory_dict)

        self.mock_embedder.embed.assert_called_once_with(
            "This is the updated memory content via dict."
        )

        args, _ = self.mock_vector_db.update.call_args
        updated_id, updated_data_to_db = args
        self.assertEqual(updated_id, memory_id_to_update)
        self.assertEqual(updated_data_to_db.vector, expected_embedding)
        self.mock_vector_db.update.assert_called_once()

        memory_dict = updated_data_to_db.payload
        self.assertEqual(memory_dict["memory"], "This is the updated memory content via dict.")
        self.assertEqual(memory_dict["metadata"]["type"], "fact")
        self.assertEqual(memory_dict["metadata"]["source"], "conversation")
        self.assertEqual(memory_dict["metadata"]["confidence"], 95.0)
        self.assertIn("memory system", memory_dict["metadata"]["entities"])

    def test_search_memories(self):
        """Test searching for memories."""
        query = "Tell me about user preferences"
        top_k = 2
        query_embedding = [0.4] * 5

        self.mock_embedder.embed.return_value = [query_embedding]

        uuid1 = str(uuid.uuid4())
        uuid2 = str(uuid.uuid4())
        uuid3 = str(uuid.uuid4())

        db_search_results = [
            VecDBItem(
                id=uuid1,
                vector=[0.1] * 5,
                payload={
                    "id": uuid1,
                    "memory": "User likes apples.",
                    "metadata": {"type": "fact"},
                },
                score=0.95,
            ),
            VecDBItem(
                id=uuid2,
                vector=[0.2] * 5,
                payload={
                    "id": uuid2,
                    "memory": "User enjoys sunny days.",
                    "metadata": {"type": "opinion"},
                },
                score=0.88,
            ),
            VecDBItem(
                id=uuid3,
                vector=[0.3] * 5,
                payload={
                    "id": uuid3,
                    "memory": "User prefers tea over coffee.",
                    "metadata": {"type": "opinion"},
                },
                score=0.92,
            ),
        ]
        # Use only top_k results, as that's what the implementation should return
        self.mock_vector_db.search.return_value = db_search_results[:top_k]

        search_results = self.memory.search(query, top_k)

        self.mock_embedder.embed.assert_called_once_with(query)
        self.mock_vector_db.search.assert_called_once_with(query_embedding, top_k)

        self.assertEqual(len(search_results), top_k)
        for item in search_results:
            self.assertIsInstance(item, TextualMemoryItem)

    def test_get_memory_by_id(self):
        """Test retrieving a single memory by its ID."""
        memory_id = str(uuid.uuid4())
        expected_payload = {
            "id": memory_id,
            "memory": "Details of memory 789",
            "metadata": {"source": "conversation"},
        }
        self.mock_vector_db.get_by_id.return_value = VecDBItem(
            id=memory_id,
            vector=[0.1] * 5,
            payload=expected_payload,
        )

        retrieved_memory = self.memory.get(memory_id)

        self.mock_vector_db.get_by_id.assert_called_once_with(memory_id)
        self.assertEqual(retrieved_memory.id, expected_payload["id"])
        self.assertEqual(retrieved_memory.memory, expected_payload["memory"])

    def test_get_memories_by_ids(self):
        """Test retrieving multiple memories by their IDs."""
        uuid1 = str(uuid.uuid4())
        uuid2 = str(uuid.uuid4())
        memory_ids = [uuid1, uuid2]
        expected_payloads = [
            {"id": uuid1, "memory": "Memory ABC", "metadata": {}},
            {"id": uuid2, "memory": "Memory DEF", "metadata": {}},
        ]
        self.mock_vector_db.get_by_ids.return_value = [
            VecDBItem(
                id=uuid1,
                vector=[0.1] * 5,
                payload=expected_payloads[0],
            ),
            VecDBItem(
                id=uuid2,
                vector=[0.2] * 5,
                payload=expected_payloads[1],
            ),
        ]

        retrieved_memories = self.memory.get_by_ids(memory_ids)

        self.mock_vector_db.get_by_ids.assert_called_once_with(memory_ids)
        self.assertEqual(len(retrieved_memories), len(expected_payloads))
        for i, expected in enumerate(expected_payloads):
            self.assertEqual(retrieved_memories[i].id, expected["id"])
            self.assertEqual(retrieved_memories[i].memory, expected["memory"])

    def test_get_all_memories(self):
        """Test retrieving all memories."""
        uuid1 = str(uuid.uuid4())
        uuid2 = str(uuid.uuid4())
        all_db_items = [
            VecDBItem(
                id=uuid1,
                vector=[0.1] * 5,
                payload={
                    "id": uuid1,
                    "memory": "First of all memories",
                    "metadata": {"type": "fact"},
                },
            ),
            VecDBItem(
                id=uuid2,
                vector=[0.2] * 5,
                payload={
                    "id": uuid2,
                    "memory": "Second of all memories",
                    "metadata": {"type": "opinion"},
                },
            ),
        ]
        expected_memories = [item.payload for item in all_db_items]

        self.mock_vector_db.get_all.return_value = all_db_items

        all_memories_retrieved = self.memory.get_all()

        self.mock_vector_db.get_all.assert_called_once()
        self.assertEqual(len(all_memories_retrieved), len(expected_memories))

    def test_delete_memories(self):
        """Test deleting memories by IDs."""
        memory_ids_to_delete = ["del-id-1", "del-id-2"]

        self.memory.delete(memory_ids_to_delete)

        self.mock_vector_db.delete.assert_called_once_with(memory_ids_to_delete)

    def test_delete_all_memories(self):
        """Test deleting all memories."""
        # This correctly gets the collection name from the mocked vector_db's internal config
        collection_name = self.mock_qdrant_config.collection_name

        self.memory.delete_all()

        self.mock_vector_db.delete_collection.assert_called_once_with(collection_name)
        self.mock_vector_db.create_collection.assert_called_once()  # Assumes create_collection is called after delete

    def test_load(self):
        """Test load functionality for GeneralTextMemory."""
        test_dir = "/test/directory"
        memory_filename = "textual_memory.json"

        # Set the config's memory_filename
        self.config.memory_filename = memory_filename

        # Create test memory data
        memory1_id = str(uuid.uuid4())
        memory2_id = str(uuid.uuid4())
        test_memories_data = [
            {
                "id": memory1_id,
                "payload": {
                    "id": memory1_id,
                    "memory": "Test memory 1",
                    "metadata": {"type": "fact"},
                },
                "vector": [0.1, 0.2, 0.3],
            },
            {
                "id": memory2_id,
                "payload": {
                    "id": memory2_id,
                    "memory": "Test memory 2",
                    "metadata": {"type": "opinion"},
                },
                "vector": [0.4, 0.5, 0.6],
            },
        ]

        # Test case 1: Successfully load memories from file
        with (
            patch("os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data=json.dumps(test_memories_data))),
            patch.object(self.mock_vector_db, "add") as mock_add,
            patch("memos.memories.textual.general.logger.info") as mock_logger_info,
        ):
            # Call the function under test
            self.memory.load(test_dir)

            # Assertions
            mock_add.assert_called_once()
            args = mock_add.call_args[0][0]
            self.assertEqual(len(args), 2)
            self.assertIsInstance(args[0], VecDBItem)
            self.assertEqual(args[0].id, memory1_id)
            self.assertEqual(args[1].id, memory2_id)
            mock_logger_info.assert_called_once()
            self.assertIn("Loaded 2 memories", mock_logger_info.call_args[0][0])

        # Test case 2: File does not exist
        with (
            patch("os.path.exists", return_value=False),
            patch("memos.memories.textual.general.logger.warning") as mock_logger_warning,
        ):
            self.memory.load(test_dir)

            # Should log warning but not raise exception
            mock_logger_warning.assert_called_once()
            self.assertIn("Memory file not found", mock_logger_warning.call_args[0][0])

        # Test case 3: Invalid JSON format
        with (
            patch("os.path.exists", return_value=True),
            patch("builtins.open", mock_open(read_data="invalid json")),
            patch("memos.memories.textual.general.logger.error") as mock_logger_error,
        ):
            self.memory.load(test_dir)

            # Should log error but not raise exception
            mock_logger_error.assert_called_once()
            self.assertIn("Error decoding JSON", mock_logger_error.call_args[0][0])

    def test_dump(self):
        """Test dump functionality for GeneralTextMemory."""
        test_dir = "test/directory"
        memory_filename = "textual_memory.json"
        memory_file_path = os.path.join(test_dir, memory_filename)

        # Set the config's memory_filename
        self.config.memory_filename = memory_filename

        # Create test memory items
        uuid1 = str(uuid.uuid4())
        uuid2 = str(uuid.uuid4())
        test_vec_db_items = [
            VecDBItem(
                id=uuid1,
                vector=[0.1, 0.2, 0.3],
                payload={"id": uuid1, "memory": "Test memory 1", "metadata": {"type": "fact"}},
            ),
            VecDBItem(
                id=uuid2,
                vector=[0.4, 0.5, 0.6],
                payload={"id": uuid2, "memory": "Test memory 2", "metadata": {"type": "opinion"}},
            ),
        ]

        # Set up mock for vector_db.get_all
        self.mock_vector_db.get_all.return_value = test_vec_db_items

        # Test successful dump
        with (
            patch("os.makedirs", return_value=None) as mock_makedirs,
            patch("builtins.open", mock_open()) as mock_file,
            patch("json.dump") as mock_json_dump,
            patch("memos.memories.textual.general.logger.info") as mock_logger_info,
        ):
            # Call the function under test
            self.memory.dump(test_dir)

            # Assertions
            mock_makedirs.assert_called_once_with(test_dir, exist_ok=True)
            mock_file.assert_called_once_with(memory_file_path, "w", encoding="utf-8")

            # Verify correct data was passed to json.dump
            json_data_arg = mock_json_dump.call_args[0][0]
            self.assertEqual(len(json_data_arg), 2)
            self.assertEqual(json_data_arg[0]["id"], uuid1)
            self.assertEqual(json_data_arg[1]["id"], uuid2)

            # Verify formatting arguments
            format_args = mock_json_dump.call_args[1]
            self.assertEqual(format_args["indent"], 4)
            self.assertEqual(format_args["ensure_ascii"], False)

            # Verify logging
            mock_logger_info.assert_called_once()
            log_message = mock_logger_info.call_args[0][0]
            self.assertIn("Dumped 2 memories", log_message)
            self.assertIn(memory_file_path, log_message)

        # Test error case
        error_message = "Test exception"
        with (
            patch.object(self.mock_vector_db, "get_all", side_effect=Exception(error_message)),
            patch("memos.memories.textual.general.logger.error") as mock_logger_error,
        ):
            # Call should raise the same exception that was triggered in the mock
            with self.assertRaises(Exception) as context:
                self.memory.dump(test_dir)
            self.assertEqual(str(context.exception), error_message)

            # Verify error was logged
            mock_logger_error.assert_called_once()
            self.assertIn(
                "An error occurred while dumping memories", mock_logger_error.call_args[0][0]
            )


if __name__ == "__main__":
    unittest.main()
