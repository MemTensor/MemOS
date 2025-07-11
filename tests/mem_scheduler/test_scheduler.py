import json
import sys
import unittest

from pathlib import Path
from unittest.mock import MagicMock, call, patch

from memos.configs.mem_scheduler import SchedulerConfigFactory
from memos.llms.base import BaseLLM
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.monitor import SchedulerMonitor
from memos.mem_scheduler.modules.retriever import SchedulerRetriever
from memos.mem_scheduler.modules.schemas import (
    ANSWER_LABEL,
    DEFAULT_ACT_MEM_DUMP_PATH,
    QUERY_LABEL,
    ScheduleLogForWebItem,
    ScheduleMessageItem,
    TextMemory_SEARCH_METHOD,
)
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


class TestGeneralScheduler(unittest.TestCase):
    def setUp(self):
        """Initialize test environment with mock objects and test scheduler instance."""
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

        # Initialize modules with mock LLM
        self.scheduler.initialize_modules(self.llm)
        self.scheduler.mem_cube = self.mem_cube

        # Set current user and memory cube ID for testing
        self.scheduler._current_user_id = "test_user"
        self.scheduler._current_mem_cube_id = "test_cube"

    def test_initialization(self):
        """Test that scheduler initializes with correct default values and handlers."""
        # Verify initialization parameters
        self.assertEqual(self.scheduler.top_k, 10)
        self.assertEqual(self.scheduler.top_n, 5)
        self.assertEqual(self.scheduler.act_mem_update_interval, 300)
        self.assertEqual(self.scheduler.context_window_size, 5)
        self.assertEqual(self.scheduler.activation_mem_size, 5)
        self.assertEqual(self.scheduler.act_mem_dump_path, DEFAULT_ACT_MEM_DUMP_PATH)
        self.assertEqual(self.scheduler.search_method, TextMemory_SEARCH_METHOD)
        self.assertEqual(self.scheduler._last_activation_mem_update_time, 0.0)
        self.assertEqual(self.scheduler.query_list, [])

        # Verify handler registration
        self.assertTrue(QUERY_LABEL in self.scheduler.dispatcher.handlers)
        self.assertTrue(ANSWER_LABEL in self.scheduler.dispatcher.handlers)

    def test_initialize_modules(self):
        """Test module initialization with proper component assignments."""
        self.assertEqual(self.scheduler.chat_llm, self.llm)
        self.assertIsInstance(self.scheduler.monitor, SchedulerMonitor)
        self.assertIsInstance(self.scheduler.retriever, SchedulerRetriever)

    def test_query_message_consume(self):
        # Create test message
        message = ScheduleMessageItem(
            user_id="test_user",
            mem_cube_id="test_cube",
            mem_cube=self.mem_cube,
            label=QUERY_LABEL,
            content="Test query",
        )

        # Mock the detect_intent method to return a valid JSON string
        mock_intent_result = {"trigger_retrieval": False, "missing_evidence": []}

        # Mock the process_session_turn method
        with (
            patch.object(self.scheduler, "process_session_turn") as mock_process_session_turn,
            # Also mock detect_intent to avoid JSON parsing issues
            patch.object(self.scheduler.monitor, "detect_intent") as mock_detect_intent,
        ):
            mock_detect_intent.return_value = mock_intent_result

            # Test message handling
            self.scheduler._query_message_consume([message])

            # Verify method call
            mock_process_session_turn.assert_called_once_with(query="Test query", top_k=10, top_n=5)

    def test_process_session_turn_with_trigger(self):
        """Test session turn processing with retrieval trigger."""
        # Setup mock working memory
        working_memory = [
            TextualMemoryItem(memory="Memory 1"),
            TextualMemoryItem(memory="Memory 2"),
        ]
        self.tree_text_memory.get_working_memory.return_value = working_memory

        # Setup mock memory manager and memory sizes
        memory_manager = MagicMock()
        memory_manager.memory_size = {
            "LongTermMemory": 1000,
            "UserMemory": 500,
            "WorkingMemory": 100,
        }
        self.tree_text_memory.memory_manager = memory_manager

        # Setup intent detection result
        intent_result = {
            "trigger_retrieval": True,
            "missing_evidence": ["Evidence 1", "Evidence 2"],
        }

        # Mock methods
        with (
            patch.object(self.scheduler, "search") as mock_search,
            patch.object(self.scheduler, "replace_working_memory") as mock_replace,
            patch.object(self.scheduler.monitor, "detect_intent") as mock_detect,
        ):
            mock_detect.return_value = intent_result
            mock_search.side_effect = [
                [TextualMemoryItem(memory="Result 1")],
                [TextualMemoryItem(memory="Result 2")],
            ]

            # Test session turn processing
            self.scheduler.process_session_turn(query="Test query")

            # Verify method calls
            mock_detect.assert_called_once_with(
                q_list=["Test query"], text_working_memory=["Memory 1", "Memory 2"]
            )
            mock_search.assert_has_calls(
                [
                    call(query="Evidence 1", top_k=5, method=TextMemory_SEARCH_METHOD),
                    call(query="Evidence 2", top_k=5, method=TextMemory_SEARCH_METHOD),
                ]
            )
            mock_replace.assert_called_once()

    def test_submit_web_logs(self):
        """Test submission of web logs."""
        # Create log message with all required fields
        log_message = ScheduleLogForWebItem(
            user_id="test_user",
            mem_cube_id="test_cube",
            label=QUERY_LABEL,
            log_title="Test Log",
            log_content="Test Content",
            current_memory_sizes={
                "long_term_memory_size": 0,
                "user_memory_size": 0,
                "working_memory_size": 0,
                "transformed_act_memory_size": 0,
                "parameter_memory_size": 0,
            },
            memory_capacities={
                "long_term_memory_capacity": 1000,
                "user_memory_capacity": 500,
                "working_memory_capacity": 100,
                "transformed_act_memory_capacity": 0,
                "parameter_memory_capacity": 0,
            },
        )

        # Empty the queue by consuming all elements
        while not self.scheduler._web_log_message_queue.empty():
            self.scheduler._web_log_message_queue.get()

        # Submit the log message
        self.scheduler._submit_web_logs(messages=log_message)

        # Verify the message was added to the queue
        self.assertEqual(self.scheduler._web_log_message_queue.qsize(), 1)
        self.assertEqual(self.scheduler._web_log_message_queue.get(), log_message)

    def test_memory_reranking(self):
        """Test memory reranking process with LLM interaction."""
        # Setup original and new memory
        original_memory = [TextualMemoryItem(memory="Original 1")]
        new_memory = [TextualMemoryItem(memory="New 1"), TextualMemoryItem(memory="New 2")]

        # Setup LLM response
        llm_response = json.dumps({"new_order": ["New 2", "Original 1", "New 1"]})
        self.llm.generate.return_value = llm_response

        # Test memory reranking
        result = self.scheduler.replace_working_memory(
            original_memory, new_memory, top_k=2, top_n=1
        )

        # Verify result
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].memory, "New 2")

    def test_search_with_empty_results(self):
        """Test search method with empty results."""
        # Setup mock search results
        self.tree_text_memory.search.return_value = []

        # Test search
        results = self.scheduler.search(
            query="Test query", top_k=5, method=TextMemory_SEARCH_METHOD
        )

        # Verify results
        self.assertEqual(results, [])

    def test_multiple_messages_processing(self):
        """Test processing of multiple messages in a batch."""
        # Create multiple test messages
        query_message = ScheduleMessageItem(
            user_id="test_user",
            mem_cube_id="test_cube",
            mem_cube=self.mem_cube,
            label=QUERY_LABEL,
            content="Query 1",
        )
        answer_message = ScheduleMessageItem(
            user_id="test_user",
            mem_cube_id="test_cube",
            mem_cube=self.mem_cube,
            label=ANSWER_LABEL,
            content="Answer 1",
        )

        # Mock message handlers
        with (
            patch.object(self.scheduler, "_query_message_consume") as mock_query,
            patch.object(self.scheduler, "_answer_message_consume") as mock_answer,
        ):
            # Ensure message handlers are registered
            self.scheduler.dispatcher.register_handlers(
                {
                    QUERY_LABEL: self.scheduler._query_message_consume,
                    ANSWER_LABEL: self.scheduler._answer_message_consume,
                }
            )

            # Process messages
            self.scheduler.dispatcher.enable_parallel_dispatch = False
            self.scheduler.dispatcher.dispatch([query_message, answer_message])

            # Verify call arguments manually
            mock_query.assert_called_once_with([query_message])
            mock_answer.assert_called_once_with([answer_message])







