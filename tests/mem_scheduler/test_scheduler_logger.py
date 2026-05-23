import sys
import unittest

from pathlib import Path
from unittest.mock import MagicMock

from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.scheduler_logger import SchedulerLoggerModule
from memos.memories.textual.tree import TextualMemoryItem


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory


def _make_memory_item(memory_id, memory_text, memory_type="LongTermMemory"):
    item = MagicMock(spec=TextualMemoryItem)
    item.id = memory_id
    item.memory = memory_text
    item.metadata = MagicMock()
    item.metadata.key = memory_text
    item.metadata.memory_type = memory_type
    item.metadata.status = "active"
    item.metadata.confidence = 1.0
    item.metadata.tags = []
    item.metadata.updated_at = None
    item.metadata.update_at = None
    return item


def _make_mem_cube():
    mem_cube = MagicMock(spec=GeneralMemCube)
    mem_cube.text_mem = MagicMock()
    mem_cube.text_mem.memory_manager = MagicMock()
    mem_cube.text_mem.memory_manager.memory_size = {
        "LongTermMemory": 10000,
        "UserMemory": 10000,
        "WorkingMemory": 20,
    }
    mem_cube.text_mem.get_current_memory_size.return_value = {
        "LongTermMemory": 100,
        "UserMemory": 50,
        "WorkingMemory": 10,
    }
    return mem_cube


class TestSchedulerLogger(unittest.TestCase):
    def setUp(self):
        self.logger_module = SchedulerLoggerModule()
        self.mem_cube = _make_mem_cube()

    def test_log_working_memory_replacement_memory_len_equals_new_memory(self):
        """memory_len in the logged event should equal len(new_memory), not len(added items)."""
        # original has 2 items; new_memory has 5 items (2 carried over + 3 new)
        original_memory = [
            _make_memory_item("id1", "memory one"),
            _make_memory_item("id2", "memory two"),
        ]
        new_memory = [
            _make_memory_item("id1", "memory one"),    # carried over
            _make_memory_item("id2", "memory two"),    # carried over
            _make_memory_item("id3", "memory three"),  # new
            _make_memory_item("id4", "memory four"),   # new
            _make_memory_item("id5", "memory five"),   # new
        ]

        captured_events = []

        self.logger_module.log_working_memory_replacement(
            original_memory=original_memory,
            new_memory=new_memory,
            user_id="test_user",
            mem_cube_id="test_cube",
            mem_cube=self.mem_cube,
            log_func_callback=lambda evts: captured_events.extend(evts),
        )

        self.assertTrue(len(captured_events) > 0, "Expected at least one log event")
        event = captured_events[0]
        self.assertEqual(
            event.memory_len,
            len(new_memory),
            f"memory_len should be {len(new_memory)} (total new_memory size), got {event.memory_len}",
        )


if __name__ == "__main__":
    unittest.main()
