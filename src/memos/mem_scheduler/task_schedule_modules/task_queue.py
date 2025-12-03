"""
Redis Queue implementation for SchedulerMessageItem objects.

This module provides a Redis-based queue implementation that can replace
the local memos_message_queue functionality in BaseScheduler.
"""

from memos.context.context import get_current_trace_id
from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.task_schedule_modules.local_queue import SchedulerLocalQueue
from memos.mem_scheduler.task_schedule_modules.redis_queue import SchedulerRedisQueue
from memos.mem_scheduler.utils.db_utils import get_utc_now
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube
from memos.mem_scheduler.utils.monitor_event_utils import emit_monitor_event, to_iso


logger = get_logger(__name__)


class ScheduleTaskQueue:
    def __init__(
        self,
        use_redis_queue: bool,
        maxsize: int,
        disabled_handlers: list | None = None,
    ):
        self.use_redis_queue = use_redis_queue
        self.maxsize = maxsize

        if self.use_redis_queue:
            self.memos_message_queue = SchedulerRedisQueue(maxsize=self.maxsize)
        else:
            self.memos_message_queue = SchedulerLocalQueue(maxsize=self.maxsize)

        self.disabled_handlers = disabled_handlers

    def ack_message(
        self,
        user_id: str,
        mem_cube_id: str,
        task_label: str,
        redis_message_id,
    ) -> None:
        if not isinstance(self.memos_message_queue, SchedulerRedisQueue):
            logger.warning("ack_message is only supported for Redis queues")
            return

        self.memos_message_queue.ack_message(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            task_label=task_label,
            redis_message_id=redis_message_id,
        )

    def get_stream_keys(self) -> list[str]:
        if isinstance(self.memos_message_queue, SchedulerRedisQueue):
            stream_keys = self.memos_message_queue.get_stream_keys()
        else:
            stream_keys = list(self.memos_message_queue.queue_streams.keys())
        return stream_keys

    def submit_messages(self, messages: ScheduleMessageItem | list[ScheduleMessageItem]):
        """Submit messages to the message queue (either local queue or Redis)."""
        if isinstance(messages, ScheduleMessageItem):
            messages = [messages]

        current_trace_id = get_current_trace_id()

        for msg in messages:
            if current_trace_id:
                # Prefer current request trace_id so logs can be correlated
                msg.trace_id = current_trace_id
            msg.stream_key = self.memos_message_queue.get_stream_key(
                user_id=msg.user_id, mem_cube_id=msg.mem_cube_id, task_label=msg.label
            )

        if len(messages) < 1:
            logger.error("Submit empty")
        elif len(messages) == 1:
            enqueue_ts = to_iso(getattr(messages[0], "timestamp", None))
            emit_monitor_event("enqueue", messages[0], {"enqueue_ts": enqueue_ts})
            self.memos_message_queue.put(messages[0])
        else:
            user_cube_groups = group_messages_by_user_and_mem_cube(messages)

            # Process each user and mem_cube combination
            for _user_id, cube_groups in user_cube_groups.items():
                for _mem_cube_id, user_cube_msgs in cube_groups.items():
                    for message in user_cube_msgs:
                        if not isinstance(message, ScheduleMessageItem):
                            error_msg = f"Invalid message type: {type(message)}, expected ScheduleMessageItem"
                            logger.error(error_msg)
                            raise TypeError(error_msg)

                        if getattr(message, "timestamp", None) is None:
                            message.timestamp = get_utc_now()

                        if self.disabled_handlers and message.label in self.disabled_handlers:
                            logger.info(
                                f"Skipping disabled handler: {message.label} - {message.content}"
                            )
                            continue

                        enqueue_ts = to_iso(getattr(message, "timestamp", None))
                        emit_monitor_event("enqueue", message, {"enqueue_ts": enqueue_ts})
                        self.memos_message_queue.put(message)
                        logger.info(
                            f"Submitted message to local queue: {message.label} - {message.content}"
                        )

    def get_messages(self, batch_size: int) -> list[ScheduleMessageItem]:
        if isinstance(self.memos_message_queue, SchedulerRedisQueue):
            return self.memos_message_queue.get_messages(batch_size=batch_size)
        stream_keys = self.get_stream_keys()

        if len(stream_keys) == 0:
            return []

        messages: list[ScheduleMessageItem] = []

        for stream_key in stream_keys:
            fetched = self.memos_message_queue.get(
                stream_key=stream_key,
                block=False,
                batch_size=batch_size,
            )

            messages.extend(fetched)
        if len(messages) > 0:
            logger.debug(
                f"Fetched {len(messages)} messages across users with per-user batch_size={batch_size}"
            )
        return messages

    def clear(self):
        self.memos_message_queue.clear()

    def qsize(self):
        return self.memos_message_queue.qsize()
