"""
Local Queue implementation for SchedulerMessageItem objects.
This module provides a local-based queue implementation that can replace
the local memos_message_queue functionality in BaseScheduler.
"""

from memos.log import get_logger
from memos.mem_scheduler.general_modules.misc import AutoDroppingQueue as Queue
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.webservice_modules.redis_service import RedisSchedulerModule


logger = get_logger(__name__)


class SchedulerLocalQueue(RedisSchedulerModule):
    def __init__(
        self,
        maxsize: int,
    ):
        """
        Initialize the SchedulerLocalQueue with a maximum queue size limit.

        Args:
            maxsize (int): Maximum number of messages allowed
                                                 in each individual queue.
                                                 If exceeded, subsequent puts will block
                                                 or raise an exception based on `block` parameter.
        """
        super().__init__()

        self.stream_key_prefix = "local_queue"

        self.max_internal_message_queue_size = maxsize
        # Dictionary to hold per-stream queues: key = stream_key, value = Queue[ScheduleMessageItem]
        self.queue_streams: dict[str, Queue[ScheduleMessageItem]] = {}
        logger.info(
            f"SchedulerLocalQueue initialized with max_internal_message_queue_size={maxsize}"
        )

    def get_stream_key(self, user_id: str, mem_cube_id: str, task_label: str) -> str:
        stream_key = f"{self.stream_key_prefix}:{user_id}:{mem_cube_id}:{task_label}"
        return stream_key

    def put(
        self, message: ScheduleMessageItem, block: bool = True, timeout: float | None = None
    ) -> None:
        """
        Put a message into the appropriate internal queue based on user_id and mem_cube_id.

        If the corresponding queue does not exist, it is created automatically.
        This method uses a local in-memory queue (not Redis) for buffering messages.

        Args:
            message (ScheduleMessageItem): The message to enqueue.
            block (bool): If True, block if the queue is full; if False, raise Full immediately.
            timeout (float | None): Maximum time to wait for the queue to become available.
                                   If None, block indefinitely. Ignored if block=False.

        Raises:
            queue.Full: If the queue is full and block=False or timeout expires.
            Exception: Any underlying error during queue.put() operation.
        """
        stream_key = self.get_stream_key(
            user_id=message.user_id, mem_cube_id=message.mem_cube_id, task_label=message.label
        )

        message.stream_key = stream_key

        # Create the queue if it doesn't exist yet
        if stream_key not in self.queue_streams:
            logger.info(f"Creating new internal queue for stream: {stream_key}")
            self.queue_streams[stream_key] = Queue(maxsize=self.max_internal_message_queue_size)

        try:
            self.queue_streams[stream_key].put(item=message, block=block, timeout=timeout)
            logger.info(
                f"Message successfully put into queue '{stream_key}'. Current size: {self.queue_streams[stream_key].qsize()}"
            )
        except Exception as e:
            logger.error(f"Failed to put message into queue '{stream_key}': {e}", exc_info=True)
            raise  # Re-raise to maintain caller expectations

    def get(
        self,
        stream_key: str,
        block: bool = True,
        timeout: float | None = None,
        batch_size: int | None = None,
    ) -> list[ScheduleMessageItem]:
        if batch_size is not None and batch_size <= 0:
            logger.warning(
                f"get() called with invalid batch_size: {batch_size}. Returning empty list."
            )
            return []

        # Return empty list if queue does not exist
        if stream_key not in self.queue_streams:
            logger.error(f"Stream {stream_key} does not exist when trying to get messages.")
            return []

        # Note: Assumes custom Queue implementation supports batch_size parameter
        res = self.queue_streams[stream_key].get(
            block=block, timeout=timeout, batch_size=batch_size
        )
        logger.debug(
            f"Retrieved {len(res)} messages from queue '{stream_key}'. Current size: {self.queue_streams[stream_key].qsize()}"
        )
        return res

    def get_nowait(
        self, stream_key: str, batch_size: int | None = None
    ) -> list[ScheduleMessageItem]:
        """
        Non-blocking version of get(). Equivalent to get(stream_key, block=False, batch_size=batch_size).

        Returns immediately with available messages or an empty list if queue is empty.

        Args:
            stream_key (str): The stream/queue identifier.
            batch_size (int | None): Number of messages to retrieve in a batch.
                                   If None, retrieves one message.

        Returns:
            List[ScheduleMessageItem]: Retrieved messages or empty list if queue is empty.
        """
        logger.debug(f"get_nowait() called for {stream_key} with batch_size: {batch_size}")
        return self.get(stream_key=stream_key, block=False, batch_size=batch_size)

    def get_messages(self, batch_size: int) -> list[ScheduleMessageItem]:
        """
        Get messages from all streams in round-robin or sequential fashion.
        Equivalent to SchedulerRedisQueue.get_messages.
        """
        messages = []
        # Snapshot keys to avoid runtime modification issues
        stream_keys = list(self.queue_streams.keys())

        # Simple strategy: try to get up to batch_size messages across all streams
        # We can just iterate and collect.

        # Calculate how many to get per stream to be fair?
        # Or just greedy? Redis implementation uses a complex logic.
        # For local, let's keep it simple: just iterate and take what's available (non-blocking)

        for stream_key in stream_keys:
            if len(messages) >= batch_size:
                break

            needed = batch_size - len(messages)
            # Use get_nowait to avoid blocking
            fetched = self.get_nowait(stream_key=stream_key, batch_size=needed)
            messages.extend(fetched)

        return messages

    def qsize(self) -> dict:
        """
        Return the current size of all internal queues as a dictionary.

        Each key is the stream name, and each value is the number of messages in that queue.
        Also includes 'total_size'.

        Returns:
            Dict[str, int]: Mapping from stream name to current queue size.
        """
        sizes = {stream: queue.qsize() for stream, queue in self.queue_streams.items()}
        total_size = sum(sizes.values())
        sizes["total_size"] = total_size
        logger.debug(f"Current queue sizes: {sizes}")
        return sizes

    def size(self) -> int:
        """
        Get the current size of the queue (total message count).
        Compatible with SchedulerRedisQueue.
        """
        return self.unfinished_tasks

    def empty(self) -> bool:
        """
        Check if the queue is empty.
        Compatible with SchedulerRedisQueue.
        """
        return self.size() == 0

    def full(self) -> bool:
        """
        Check if the queue is full.
        Compatible with SchedulerRedisQueue.
        """
        # Local queue limits are per-stream (max_internal_message_queue_size).
        # It is considered full only if all streams are full.
        if not self.queue_streams:
            return False

        return all(queue.full() for queue in self.queue_streams.values())

    def clear(self) -> None:
        for queue in self.queue_streams.values():
            queue.clear()

    @property
    def unfinished_tasks(self) -> int:
        """
        Calculate the total number of unprocessed messages across all queues.

        This is a convenience property for monitoring overall system load.

        Returns:
            int: Sum of all message counts in all internal queues.
        """
        # qsize() now includes "total_size", so we need to be careful not to double count if we use qsize() values
        # But qsize() implementation above sums values from queue_streams, then adds total_size.
        # So sum(self.queue_streams.values().qsize()) is safer.
        total = sum(queue.qsize() for queue in self.queue_streams.values())
        logger.debug(f"Total unfinished tasks across all queues: {total}")
        return total
