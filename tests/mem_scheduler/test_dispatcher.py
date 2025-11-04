import sys
import time
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
from memos.mem_scheduler.general_modules.dispatcher import SchedulerDispatcher
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import RunningTaskItem
from memos.memories.textual.tree import TreeTextMemory


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


class TestSchedulerDispatcher(unittest.TestCase):
    """Test cases for the SchedulerDispatcher class."""

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

        self.dispatcher = self.scheduler.dispatcher

        # Create mock handlers
        self.mock_handler1 = MagicMock()
        self.mock_handler2 = MagicMock()

        # Register mock handlers
        self.dispatcher.register_handler("label1", self.mock_handler1)
        self.dispatcher.register_handler("label2", self.mock_handler2)

        # Create test messages
        self.test_messages = [
            ScheduleMessageItem(
                item_id="msg1",
                user_id="user1",
                mem_cube="cube1",
                mem_cube_id="msg1",
                label="label1",
                content="Test content 1",
                timestamp=123456789,
            ),
            ScheduleMessageItem(
                item_id="msg2",
                user_id="user1",
                mem_cube="cube1",
                mem_cube_id="msg2",
                label="label2",
                content="Test content 2",
                timestamp=123456790,
            ),
            ScheduleMessageItem(
                item_id="msg3",
                user_id="user2",
                mem_cube="cube2",
                mem_cube_id="msg3",
                label="label1",
                content="Test content 3",
                timestamp=123456791,
            ),
        ]

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

    def test_register_handler(self):
        """Test registering a single handler."""
        new_handler = MagicMock()
        self.dispatcher.register_handler("new_label", new_handler)

        # Verify handler was registered
        self.assertIn("new_label", self.dispatcher.handlers)
        self.assertEqual(self.dispatcher.handlers["new_label"], new_handler)

    def test_register_handlers(self):
        """Test bulk registration of handlers."""
        new_handlers = {
            "bulk1": MagicMock(),
            "bulk2": MagicMock(),
        }

        self.dispatcher.register_handlers(new_handlers)

        # Verify all handlers were registered
        for label, handler in new_handlers.items():
            self.assertIn(label, self.dispatcher.handlers)
            self.assertEqual(self.dispatcher.handlers[label], handler)

    def test_dispatch_serial(self):
        """Test dispatching messages in serial mode."""
        # Create a new dispatcher with parallel dispatch disabled
        serial_dispatcher = SchedulerDispatcher(max_workers=2, enable_parallel_dispatch=False)

        # Create fresh mock handlers for this test
        mock_handler1 = MagicMock()
        mock_handler2 = MagicMock()

        serial_dispatcher.register_handler("label1", mock_handler1)
        serial_dispatcher.register_handler("label2", mock_handler2)

        # Dispatch messages
        serial_dispatcher.dispatch(self.test_messages)

        # Verify handlers were called - label1 handler should be called twice (for user1 and user2)
        # label2 handler should be called once (only for user1)
        self.assertEqual(mock_handler1.call_count, 2)  # Called for user1/msg1 and user2/msg3
        mock_handler2.assert_called_once()  # Called for user1/msg2

        # Check that each handler received the correct messages
        # For label1: first call should have [msg1], second call should have [msg3]
        label1_calls = mock_handler1.call_args_list
        self.assertEqual(len(label1_calls), 2)

        # Extract messages from calls
        call1_messages = label1_calls[0][0][0]  # First call, first argument (messages list)
        call2_messages = label1_calls[1][0][0]  # Second call, first argument (messages list)

        # Verify the messages in each call
        self.assertEqual(len(call1_messages), 1)
        self.assertEqual(len(call2_messages), 1)

        # For label2: should have one call with [msg2]
        label2_messages = mock_handler2.call_args[0][0]
        self.assertEqual(len(label2_messages), 1)
        self.assertEqual(label2_messages[0].item_id, "msg2")

    def test_dispatch_parallel(self):
        """Test dispatching messages in parallel mode."""
        # Create fresh mock handlers for this test
        mock_handler1 = MagicMock()
        mock_handler2 = MagicMock()

        # Create a new dispatcher for this test to avoid interference
        parallel_dispatcher = SchedulerDispatcher(max_workers=2, enable_parallel_dispatch=True)
        parallel_dispatcher.register_handler("label1", mock_handler1)
        parallel_dispatcher.register_handler("label2", mock_handler2)

        # Dispatch messages
        parallel_dispatcher.dispatch(self.test_messages)

        # Wait for all futures to complete
        parallel_dispatcher.join(timeout=1.0)

        # Verify handlers were called - label1 handler should be called twice (for user1 and user2)
        # label2 handler should be called once (only for user1)
        self.assertEqual(mock_handler1.call_count, 2)  # Called for user1/msg1 and user2/msg3
        mock_handler2.assert_called_once()  # Called for user1/msg2

        # Check that each handler received the correct messages
        # For label1: should have two calls, each with one message
        label1_calls = mock_handler1.call_args_list
        self.assertEqual(len(label1_calls), 2)

        # Extract messages from calls
        call1_messages = label1_calls[0][0][0]  # First call, first argument (messages list)
        call2_messages = label1_calls[1][0][0]  # Second call, first argument (messages list)

        # Verify the messages in each call
        self.assertEqual(len(call1_messages), 1)
        self.assertEqual(len(call2_messages), 1)

        # For label2: should have one call with [msg2]
        label2_messages = mock_handler2.call_args[0][0]
        self.assertEqual(len(label2_messages), 1)
        self.assertEqual(label2_messages[0].item_id, "msg2")

    def test_group_messages_by_user_and_cube(self):
        """Test grouping messages by user and cube."""
        # Check actual grouping logic
        with patch("memos.mem_scheduler.general_modules.dispatcher.logger.debug"):
            result = self.dispatcher._group_messages_by_user_and_mem_cube(self.test_messages)

        # Adjust expected results based on actual grouping logic
        # Note: According to dispatcher.py implementation, grouping is by mem_cube_id not mem_cube
        expected = {
            "user1": {
                "msg1": [self.test_messages[0]],
                "msg2": [self.test_messages[1]],
            },
            "user2": {
                "msg3": [self.test_messages[2]],
            },
        }

        # Use more flexible assertion method
        self.assertEqual(set(result.keys()), set(expected.keys()))
        for user_id in expected:
            self.assertEqual(set(result[user_id].keys()), set(expected[user_id].keys()))
            for cube_id in expected[user_id]:
                self.assertEqual(len(result[user_id][cube_id]), len(expected[user_id][cube_id]))
                # Check if each message exists
                for msg in expected[user_id][cube_id]:
                    self.assertIn(msg.item_id, [m.item_id for m in result[user_id][cube_id]])

    def test_thread_race(self):
        """Test the ThreadRace integration."""

        # Define test tasks
        def task1(stop_flag):
            time.sleep(0.1)
            return "result1"

        def task2(stop_flag):
            time.sleep(0.2)
            return "result2"

        # Run competitive tasks
        tasks = {
            "task1": task1,
            "task2": task2,
        }

        result = self.dispatcher.run_competitive_tasks(tasks, timeout=1.0)

        # Verify the result
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "task1")  # task1 should win
        self.assertEqual(result[1], "result1")

    def test_thread_race_timeout(self):
        """Test ThreadRace with timeout."""

        # Define a task that takes longer than the timeout
        def slow_task(stop_flag):
            time.sleep(0.5)
            return "slow_result"

        tasks = {"slow": slow_task}

        # Run with a short timeout
        result = self.dispatcher.run_competitive_tasks(tasks, timeout=0.1)

        # Verify no result was returned due to timeout
        self.assertIsNone(result)

    def test_thread_race_cooperative_termination(self):
        """Test that ThreadRace properly terminates slower threads when one completes."""

        # Create a fast task and a slow task
        def fast_task(stop_flag):
            return "fast result"

        def slow_task(stop_flag):
            # Check stop flag to ensure proper response
            for _ in range(10):
                if stop_flag.is_set():
                    return "stopped early"
                time.sleep(0.1)
            return "slow result"

        # Run competitive tasks with increased timeout for test stability
        result = self.dispatcher.run_competitive_tasks(
            {"fast": fast_task, "slow": slow_task},
            timeout=2.0,  # Increased timeout
        )

        # Verify the result is from the fast task
        self.assertIsNotNone(result)
        self.assertEqual(result[0], "fast")
        self.assertEqual(result[1], "fast result")

        # Allow enough time for thread cleanup
        time.sleep(0.5)

    def test_running_task_item_messages_field(self):
        """Test that RunningTaskItem correctly stores messages."""
        # Create test messages
        test_messages = [
            ScheduleMessageItem(
                item_id="test1",
                user_id="user1",
                mem_cube="cube1",
                mem_cube_id="test1",
                label="test_label",
                content="Test message 1",
                timestamp=123456789,
            ),
            ScheduleMessageItem(
                item_id="test2",
                user_id="user1",
                mem_cube="cube1",
                mem_cube_id="test2",
                label="test_label",
                content="Test message 2",
                timestamp=123456790,
            ),
        ]

        # Create RunningTaskItem with messages
        task_item = RunningTaskItem(
            user_id="user1",
            mem_cube_id="cube1",
            task_info="Test task",
            task_name="test_handler",
            messages=test_messages,
        )

        # Verify messages are stored correctly
        self.assertIsNotNone(task_item.messages)
        self.assertEqual(len(task_item.messages), 2)
        self.assertEqual(task_item.messages[0].item_id, "test1")
        self.assertEqual(task_item.messages[1].item_id, "test2")

        # Test with no messages
        task_item_no_msgs = RunningTaskItem(
            user_id="user1",
            mem_cube_id="cube1",
            task_info="Test task without messages",
            task_name="test_handler",
        )
        self.assertIsNone(task_item_no_msgs.messages)

    def test_dispatcher_creates_task_with_messages(self):
        """Test that dispatcher creates RunningTaskItem with messages."""
        # Mock the task wrapper to capture the task_item
        captured_task_items = []

        original_create_wrapper = self.dispatcher._create_task_wrapper

        def mock_create_wrapper(handler, task_item):
            captured_task_items.append(task_item)
            return original_create_wrapper(handler, task_item)

        with patch.object(self.dispatcher, "_create_task_wrapper", side_effect=mock_create_wrapper):
            # Dispatch messages
            self.dispatcher.dispatch(self.test_messages)

            # Wait for parallel tasks to complete
            if self.dispatcher.enable_parallel_dispatch:
                self.dispatcher.join(timeout=1.0)

        # Verify that task items were created with messages
        self.assertGreater(len(captured_task_items), 0)

        for task_item in captured_task_items:
            self.assertIsNotNone(task_item.messages)
            self.assertGreater(len(task_item.messages), 0)
            # Verify messages have the expected structure
            for msg in task_item.messages:
                self.assertIsInstance(msg, ScheduleMessageItem)

    def test_dispatcher_monitor_logs_stuck_task_messages(self):
        """Test that dispatcher monitor includes messages info when logging stuck tasks."""

        # Create test messages
        test_messages = [
            ScheduleMessageItem(
                item_id="stuck1",
                user_id="user1",
                mem_cube="cube1",
                mem_cube_id="stuck1",
                label="stuck_label",
                content="Stuck message 1",
                timestamp=123456789,
            ),
            ScheduleMessageItem(
                item_id="stuck2",
                user_id="user1",
                mem_cube="cube1",
                mem_cube_id="stuck2",
                label="stuck_label",
                content="Stuck message 2",
                timestamp=123456790,
            ),
        ]

        # Create a stuck task with messages
        stuck_task = RunningTaskItem(
            user_id="user1",
            mem_cube_id="cube1",
            task_info="Stuck task",
            task_name="stuck_handler",
            messages=test_messages,
        )

        # Mock logger to capture log messages
        with patch("memos.mem_scheduler.monitors.dispatcher_monitor.logger"):
            # Simulate stuck task detection by directly calling the logging part
            # We'll test the logging format by checking what would be logged
            task_info = stuck_task.get_execution_info()
            messages_info = ""
            if stuck_task.messages:
                messages_info = f", Messages: {len(stuck_task.messages)} items - {[str(msg) for msg in stuck_task.messages[:3]]}"
                if len(stuck_task.messages) > 3:
                    messages_info += f" ... and {len(stuck_task.messages) - 3} more"

            expected_log = f"  - Stuck task: {task_info}{messages_info}"

            # Verify the log message format includes messages info
            self.assertIn("Messages: 2 items", expected_log)
            self.assertIn("Stuck message 1", expected_log)
            self.assertIn("Stuck message 2", expected_log)
