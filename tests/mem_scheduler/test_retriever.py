import json
import sys
import unittest

from pathlib import Path
from unittest.mock import MagicMock, patch

from memos.configs.mem_scheduler import (
    AuthConfig,
    GraphDBAuthConfig,
    OpenAIConfig,
    RabbitMQConfig,
    SchedulerConfigFactory,
)
from memos.llms.base import BaseLLM
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_scheduler.utils.filter_utils import (
    filter_too_short_memories,
    filter_vector_based_similar_memories,
)
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


class TestSchedulerRetriever(unittest.TestCase):
    def _create_mock_auth_config(self):
        """Create a mock AuthConfig for testing purposes."""
        # Create mock configs with valid test values
        graph_db_config = GraphDBAuthConfig(
            uri="bolt://localhost:7687",
            user="neo4j",
            password="test_password_123",  # 8+ characters to pass validation
            db_name="neo4j",
            auto_create=True,
        )

        rabbitmq_config = RabbitMQConfig(
            host_name="localhost", port=5672, user_name="guest", password="guest", virtual_host="/"
        )

        openai_config = OpenAIConfig(api_key="test_api_key_123", default_model="gpt-3.5-turbo")

        return AuthConfig(rabbitmq=rabbitmq_config, openai=openai_config, graph_db=graph_db_config)

    def setUp(self):
        """Initialize test environment with mock objects."""
        example_scheduler_config_path = (
            f"{BASE_DIR}/examples/data/config/mem_scheduler/general_scheduler_config.yaml"
        )
        scheduler_config = SchedulerConfigFactory.from_yaml_file(
            yaml_path=example_scheduler_config_path
        )
        mem_scheduler = SchedulerFactory.from_config(scheduler_config)
        self.scheduler = mem_scheduler
        self.llm = MagicMock(spec=BaseLLM)
        self.mem_cube = MagicMock(spec=GeneralMemCube)
        self.tree_text_memory = MagicMock(spec=TreeTextMemory)
        self.mem_cube.text_mem = self.tree_text_memory
        self.mem_cube.act_mem = MagicMock()

        # Mock AuthConfig.from_local_env() to return our test config
        mock_auth_config = self._create_mock_auth_config()
        self.auth_config_patch = patch(
            "memos.configs.mem_scheduler.AuthConfig.from_local_env", return_value=mock_auth_config
        )
        self.auth_config_patch.start()

        # Initialize general_modules with mock LLM
        self.scheduler.initialize_modules(chat_llm=self.llm, process_llm=self.llm)
        self.scheduler.mem_cube = self.mem_cube

        self.retriever = self.scheduler.retriever

        # Mock logging to verify messages
        self.logging_warning_patch = patch("logging.warning")
        self.mock_logging_warning = self.logging_warning_patch.start()

        # Mock the MemoryFilter logger since that's where the actual logging happens
        self.logger_info_patch = patch(
            "memos.mem_scheduler.memory_manage_modules.memory_filter.logger.info"
        )
        self.mock_logger_info = self.logger_info_patch.start()

    def tearDown(self):
        """Clean up patches."""
        self.logging_warning_patch.stop()
        self.logger_info_patch.stop()
        self.auth_config_patch.stop()

    def test_filter_similar_memories_empty_input(self):
        """Test filter_similar_memories with empty input list."""
        result = filter_vector_based_similar_memories([])
        self.assertEqual(result, [])

    def test_filter_similar_memories_no_duplicates(self):
        """Test filter_similar_memories with no duplicate memories."""
        memories = [
            "This is a completely unique first memory",
            "This second memory is also totally unique",
            "And this third one has nothing in common with the others",
        ]

        result = filter_vector_based_similar_memories(memories)
        self.assertEqual(len(result), 3)
        self.assertEqual(set(result), set(memories))

    def test_filter_similar_memories_with_duplicates(self):
        """Test filter_similar_memories with duplicate memories."""
        memories = [
            "The user is planning to move to Chicago next month, although the exact date of the move is unclear.",
            "The user is planning to move to Chicago next month, which reflects a significant change in their living situation.",
            "The user is planning to move to Chicago in the upcoming month, indicating a significant change in their living situation.",
        ]
        result = filter_vector_based_similar_memories(memories, similarity_threshold=0.75)
        self.assertLess(len(result), len(memories))

    def test_filter_similar_memories_error_handling(self):
        """Test filter_similar_memories error handling."""
        # Test with non-string input (should return original list due to error)
        memories = ["valid text", 12345, "another valid text"]
        result = filter_vector_based_similar_memories(memories)
        self.assertEqual(result, memories)

    def test_filter_too_short_memories_empty_input(self):
        """Test filter_too_short_memories with empty input list."""
        result = filter_too_short_memories([])
        self.assertEqual(result, [])

    def test_filter_too_short_memories_all_valid(self):
        """Test filter_too_short_memories with all valid memories."""
        memories = [
            "This memory is definitely long enough to be kept",
            "This one is also sufficiently lengthy to pass the filter",
            "And this third memory meets the minimum length requirements too",
        ]

        result = filter_too_short_memories(memories, min_length_threshold=5)
        self.assertEqual(len(result), 3)
        self.assertEqual(result, memories)

    def test_filter_too_short_memories_with_short_ones(self):
        """Test filter_too_short_memories with some short memories."""
        memories = [
            "This is long enough",  # 5 words
            "Too short",  # 2 words
            "This one passes",  # 3 words (assuming threshold is 3)
            "Nope",  # 1 word
            "This is also acceptable",  # 4 words
        ]

        # Test with word count threshold of 3
        result = filter_too_short_memories(memories, min_length_threshold=3)
        self.assertEqual(len(result), 3)
        self.assertNotIn("Too short", result)
        self.assertNotIn("Nope", result)

    def test_filter_too_short_memories_edge_case(self):
        """Test filter_too_short_memories with edge case length."""
        memories = ["Exactly three words here", "Two words only", "One", "Four words right here"]

        # Test with threshold exactly matching some memories
        # The implementation uses word count, not character count
        result = filter_too_short_memories(memories, min_length_threshold=3)
        self.assertEqual(
            len(result), 3
        )  # "Exactly three words here", "Two words only", "Four words right here"
        self.assertIn("Exactly three words here", result)
        self.assertIn("Four words right here", result)

    def test_filter_unrelated_memories_empty_memories(self):
        """Test filter_unrelated_memories with empty memories list."""
        query_history = ["What is the weather like?", "Tell me about Python programming"]

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=[]
        )

        self.assertEqual(result, [])
        self.assertTrue(success_flag)
        self.mock_logger_info.assert_called_with("No memories to filter - returning empty list")

    def test_filter_unrelated_memories_empty_query_history(self):
        """Test filter_unrelated_memories with empty query history."""
        memories = [
            TextualMemoryItem(memory="Python is a programming language"),
            TextualMemoryItem(memory="Machine learning uses algorithms"),
            TextualMemoryItem(memory="Data science involves statistics"),
        ]

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=[], memories=memories
        )

        self.assertEqual(result, memories)
        self.assertTrue(success_flag)
        self.mock_logger_info.assert_called_with("No query history provided - keeping all memories")

    def test_filter_unrelated_memories_successful_filtering(self):
        """Test filter_unrelated_memories with successful LLM filtering."""
        query_history = ["What is Python?", "How does machine learning work?"]
        memories = [
            TextualMemoryItem(memory="Python is a high-level programming language"),
            TextualMemoryItem(memory="Machine learning algorithms learn from data"),
            TextualMemoryItem(memory="The weather is sunny today"),  # Unrelated
            TextualMemoryItem(memory="Python has many libraries for ML"),
            TextualMemoryItem(memory="Cooking recipes for pasta"),  # Unrelated
        ]

        # Mock LLM response for successful filtering
        mock_llm_response = {
            "relevant_memories": [0, 1, 3],  # Keep Python, ML, and Python ML libraries
            "filtered_count": 2,  # Filter out weather and cooking
            "reasoning": "Kept memories related to Python and machine learning, filtered out unrelated topics",
        }

        # Convert to proper JSON string
        self.llm.generate.return_value = json.dumps(mock_llm_response)

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=memories
        )

        # Verify results
        self.assertEqual(len(result), 3)
        self.assertIn(memories[0], result)  # Python
        self.assertIn(memories[1], result)  # ML
        self.assertIn(memories[3], result)  # Python ML libraries
        self.assertNotIn(memories[2], result)  # Weather
        self.assertNotIn(memories[4], result)  # Cooking
        self.assertTrue(success_flag)

        # Verify LLM was called correctly
        self.llm.generate.assert_called_once()
        call_args = self.llm.generate.call_args[0][0]
        self.assertEqual(call_args[0]["role"], "user")
        self.assertIn("Memory Relevance Filtering Task", call_args[0]["content"])

    def test_filter_unrelated_memories_llm_failure_fallback(self):
        """Test filter_unrelated_memories with LLM failure - should fallback to keeping all memories."""
        query_history = ["What is Python?"]
        memories = [
            TextualMemoryItem(memory="Python is a programming language"),
            TextualMemoryItem(memory="Machine learning is a subset of AI"),
        ]

        # Mock LLM to return an invalid response that will trigger error handling
        self.llm.generate.return_value = "Invalid response that cannot be parsed"

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=memories
        )

        # Should return all memories as fallback
        self.assertEqual(result, memories)
        self.assertFalse(success_flag)

        # Verify error was logged
        self.mock_logger_info.assert_called_with(
            "Starting memory filtering for 2 memories against 1 queries"
        )

    def test_filter_unrelated_memories_invalid_json_response(self):
        """Test filter_unrelated_memories with invalid JSON response from LLM."""
        query_history = ["What is Python?"]
        memories = [
            TextualMemoryItem(memory="Python is a programming language"),
            TextualMemoryItem(memory="Machine learning is a subset of AI"),
        ]

        # Mock LLM to return invalid JSON
        self.llm.generate.return_value = "This is not valid JSON"

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=memories
        )

        # Should return all memories as fallback
        self.assertEqual(result, memories)
        self.assertFalse(success_flag)

    def test_filter_unrelated_memories_invalid_indices(self):
        """Test filter_unrelated_memories with invalid indices in LLM response."""
        query_history = ["What is Python?"]
        memories = [
            TextualMemoryItem(memory="Python is a programming language"),
            TextualMemoryItem(memory="Machine learning is a subset of AI"),
        ]

        # Mock LLM to return invalid indices
        mock_llm_response = {
            "relevant_memories": [0, 5, -1],  # Invalid indices
            "filtered_count": 1,
            "reasoning": "Some memories are relevant",
        }

        # Convert to proper JSON string
        self.llm.generate.return_value = json.dumps(mock_llm_response)

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=memories
        )

        # Should only include valid indices
        self.assertEqual(len(result), 1)
        self.assertIn(memories[0], result)  # Index 0 is valid
        self.assertTrue(success_flag)

    def test_filter_unrelated_memories_missing_required_fields(self):
        """Test filter_unrelated_memories with missing required fields in LLM response."""
        query_history = ["What is Python?"]
        memories = [
            TextualMemoryItem(memory="Python is a programming language"),
            TextualMemoryItem(memory="Machine learning is a subset of AI"),
        ]

        # Mock LLM to return response missing required fields
        mock_llm_response = {
            "relevant_memories": [0, 1]
            # Missing "filtered_count" and "reasoning"
        }

        # Convert to proper JSON string
        self.llm.generate.return_value = json.dumps(mock_llm_response)

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=memories
        )

        # Should return all memories as fallback due to missing fields
        self.assertEqual(result, memories)
        self.assertFalse(success_flag)

    def test_filter_unrelated_memories_conservative_filtering(self):
        """Test that filter_unrelated_memories uses conservative approach - keeps memories when in doubt."""
        query_history = ["What is Python?"]
        memories = [
            TextualMemoryItem(memory="Python is a programming language"),
            TextualMemoryItem(memory="Machine learning is a subset of AI"),
            TextualMemoryItem(memory="The weather is sunny today"),  # Potentially unrelated
        ]

        # Mock LLM to return all memories as relevant (conservative)
        mock_llm_response = {
            "relevant_memories": [0, 1, 2],  # Keep all memories
            "filtered_count": 0,  # No filtering
            "reasoning": "All memories could potentially provide context",
        }

        self.llm.generate.return_value = json.dumps(mock_llm_response)

        result, success_flag = self.retriever.filter_unrelated_memories(
            query_history=query_history, memories=memories
        )

        # Should return all memories
        self.assertEqual(result, memories)
        self.assertTrue(success_flag)
