import pytest
from unittest.mock import Mock, MagicMock
from memos.mem_scheduler.general_modules.scheduler_logger import SchedulerLoggerModule
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata


class TestSchedulerLoggerModule:
    """Test suite for SchedulerLoggerModule."""

    def setup_method(self):
        """Set up test fixtures."""
        self.logger_module = SchedulerLoggerModule()
        self.user_id = "test_user"
        self.mem_cube_id = "test_cube"

        # Mock mem_cube
        self.mock_mem_cube = MagicMock()
        self.mock_mem_cube.text_mem = MagicMock()
        self.mock_mem_cube.text_mem.get_current_memory_size = Mock(
            return_value={
                "LongTermMemory": 10,
                "UserMemory": 5,
                "WorkingMemory": 3,
            }
        )

    def create_memory_item(self, memory_id: str, content: str, memory_type: str = "LongTermMemory") -> TextualMemoryItem:
        """Helper to create a TextualMemoryItem."""
        metadata = TreeNodeTextualMemoryMetadata(
            key=f"key_{memory_id}",
            memory_type=memory_type,
            status="activated",
            confidence=0.9,
            tags=[],
        )
        return TextualMemoryItem(
            id=memory_id,
            memory=content,
            metadata=metadata,
        )

    def test_log_working_memory_replacement_reports_total_memory_len(self):
        """Test that log_working_memory_replacement reports total memory count, not delta."""
        # Arrange: Create original and new memory lists
        original_memory = [
            self.create_memory_item("mem_1", "Memory A"),
            self.create_memory_item("mem_2", "Memory B"),
            self.create_memory_item("mem_3", "Memory C"),
        ]

        new_memory = [
            self.create_memory_item("mem_1", "Memory A"),
            self.create_memory_item("mem_2", "Memory B"),
            self.create_memory_item("mem_4", "Memory D"),
        ]

        # Mock the log callback to capture the log item
        captured_logs = []

        def mock_log_callback(logs):
            captured_logs.extend(logs)

        # Act: Call log_working_memory_replacement
        self.logger_module.log_working_memory_replacement(
            original_memory=original_memory,
            new_memory=new_memory,
            user_id=self.user_id,
            mem_cube_id=self.mem_cube_id,
            mem_cube=self.mock_mem_cube,
            log_func_callback=mock_log_callback,
        )

        # Assert: memory_len should be 3 (total new_memory), not 1 (delta)
        assert len(captured_logs) == 1
        log_item = captured_logs[0]

        # The key assertion: memory_len should reflect total working memory size
        assert log_item.memory_len == 3, (
            f"memory_len should be {len(new_memory)} (total working memory size), "
            f"not {len(log_item.memcube_log_content)} (delta count)"
        )

        # Verify that memcube_log_content contains only the delta (1 added memory)
        assert len(log_item.memcube_log_content) == 1
        assert log_item.memcube_log_content[0]["ref_id"] == "mem_4"

    def test_log_working_memory_replacement_no_changes(self):
        """Test that no log is created when there are no memory changes."""
        # Arrange: identical original and new memory
        memory_list = [
            self.create_memory_item("mem_1", "Memory A"),
            self.create_memory_item("mem_2", "Memory B"),
        ]

        captured_logs = []

        def mock_log_callback(logs):
            captured_logs.extend(logs)

        # Act
        self.logger_module.log_working_memory_replacement(
            original_memory=memory_list,
            new_memory=memory_list,
            user_id=self.user_id,
            mem_cube_id=self.mem_cube_id,
            mem_cube=self.mock_mem_cube,
            log_func_callback=mock_log_callback,
        )

        # Assert: no log should be created
        assert len(captured_logs) == 0

    def test_log_working_memory_replacement_all_new(self):
        """Test logging when all memories are new (empty original)."""
        # Arrange
        original_memory = []
        new_memory = [
            self.create_memory_item("mem_1", "Memory A"),
            self.create_memory_item("mem_2", "Memory B"),
            self.create_memory_item("mem_3", "Memory C"),
        ]

        captured_logs = []

        def mock_log_callback(logs):
            captured_logs.extend(logs)

        # Act
        self.logger_module.log_working_memory_replacement(
            original_memory=original_memory,
            new_memory=new_memory,
            user_id=self.user_id,
            mem_cube_id=self.mem_cube_id,
            mem_cube=self.mock_mem_cube,
            log_func_callback=mock_log_callback,
        )

        # Assert
        assert len(captured_logs) == 1
        log_item = captured_logs[0]

        # memory_len should be 3 (total), memcube_log_content should also be 3 (all new)
        assert log_item.memory_len == 3
        assert len(log_item.memcube_log_content) == 3
