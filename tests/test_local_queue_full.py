import unittest

from datetime import datetime, timezone

from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.task_schedule_modules.local_queue import SchedulerLocalQueue


class TestLocalQueueFull(unittest.TestCase):
    def test_full_behavior(self):
        # Create a queue with very small maxsize for testing
        lq = SchedulerLocalQueue(maxsize=1)

        # Initially empty
        self.assertFalse(lq.full())

        # Add message to stream 1
        msg1 = ScheduleMessageItem(
            user_id="u1",
            mem_cube_id="c1",
            label="l1",
            content="m1",
            timestamp=datetime.now(timezone.utc),
        )
        lq.put(msg1)

        # Now stream 1 is full (maxsize=1).
        # Since it's the only stream, and it's full, lq.full() should be True.
        self.assertTrue(lq.full())

        # Add message to stream 2
        msg2 = ScheduleMessageItem(
            user_id="u2",
            mem_cube_id="c2",
            label="l2",
            content="m2",
            timestamp=datetime.now(timezone.utc),
        )
        lq.put(msg2)

        # Now both stream 1 and stream 2 are full. lq.full() should be True.
        self.assertTrue(lq.full())

        # Remove message from stream 1
        stream1_key = lq.get_stream_key("u1", "c1", "l1")
        lq.get(stream1_key)

        # Now stream 1 is empty, stream 2 is full.
        # "all streams are full" is False.
        self.assertFalse(lq.full())


if __name__ == "__main__":
    unittest.main()
