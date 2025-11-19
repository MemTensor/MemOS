"""
Redis Queue implementation for SchedulerMessageItem objects.

This module provides a Redis-based queue implementation that can replace
the local memos_message_queue functionality in BaseScheduler.
"""

import re
import time

from collections.abc import Callable
from uuid import uuid4

from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.webservice_modules.redis_service import RedisSchedulerModule


logger = get_logger(__name__)


class SchedulerRedisQueue(RedisSchedulerModule):
    """
    Redis-based queue for storing and processing SchedulerMessageItem objects.

    This class provides a Redis Stream-based implementation that can replace
    the local memos_message_queue functionality, offering better scalability
    and persistence for message processing.

    Inherits from RedisSchedulerModule to leverage existing Redis connection
    and initialization functionality.
    """

    def __init__(
        self,
        stream_key_prefix: str = "scheduler:messages:stream",
        consumer_group: str = "scheduler_group",
        consumer_name: str | None = "scheduler_consumer",
        max_len: int = 10000,
        maxsize: int = 0,  # For Queue compatibility
        auto_delete_acked: bool = True,  # Whether to automatically delete acknowledged messages
    ):
        """
        Initialize the Redis queue.

        Args:
            stream_key_prefix: Name of the Redis stream
            consumer_group: Name of the consumer group
            consumer_name: Name of the consumer (auto-generated if None)
            max_len: Maximum length of the stream (for memory management)
            maxsize: Maximum size of the queue (for Queue compatibility, ignored)
            auto_delete_acked: Whether to automatically delete acknowledged messages from stream
        """
        super().__init__()

        # If maxsize <= 0, set to None (unlimited queue size)
        if maxsize <= 0:
            maxsize = 0

        # Stream configuration
        self.stream_key_prefix = stream_key_prefix
        self.consumer_group = consumer_group
        self.consumer_name = consumer_name or f"consumer_{uuid4().hex[:8]}"
        self.max_len = max_len
        self.maxsize = maxsize  # For Queue compatibility
        self.auto_delete_acked = auto_delete_acked  # Whether to delete acknowledged messages

        # Consumer state
        self._is_listening = False
        self._message_handler: Callable[[ScheduleMessageItem], None] | None = None

        # Connection state
        self._is_connected = False

        # Task tracking for mem_scheduler_wait compatibility
        self._unfinished_tasks = 0

        # Auto-initialize Redis connection
        if self.auto_initialize_redis():
            self._is_connected = True

        self.seen_streams = set()

    def get_stream_key(self, user_id: str, mem_cube_id: str) -> str:
        stream_key = f"{self.stream_key_prefix}:{user_id}:{mem_cube_id}"
        return stream_key

    def _ensure_consumer_group(self, stream_key) -> None:
        """Ensure the consumer group exists for the stream."""
        if not self._redis_conn:
            return

        try:
            self._redis_conn.xgroup_create(stream_key, self.consumer_group, id="0", mkstream=True)
            logger.debug(
                f"Created consumer group '{self.consumer_group}' for stream '{stream_key}'"
            )
        except Exception as e:
            # Check if it's a "consumer group already exists" error
            error_msg = str(e).lower()
            if "busygroup" in error_msg or "already exists" in error_msg:
                logger.info(
                    f"Consumer group '{self.consumer_group}' already exists for stream '{stream_key}'"
                )
            else:
                logger.error(f"Error creating consumer group: {e}", exc_info=True)

    def put(
        self, message: ScheduleMessageItem, block: bool = True, timeout: float | None = None
    ) -> None:
        """
        Add a message to the Redis queue (Queue-compatible interface).

        Args:
            message: SchedulerMessageItem to add to the queue
            block: Ignored for Redis implementation (always non-blocking)
            timeout: Ignored for Redis implementation

        Raises:
            ConnectionError: If not connected to Redis
            TypeError: If message is not a ScheduleMessageItem
        """
        if not self._redis_conn:
            raise ConnectionError("Not connected to Redis. Redis connection not available.")

        if not isinstance(message, ScheduleMessageItem):
            raise TypeError(f"Expected ScheduleMessageItem, got {type(message)}")

        try:
            stream_key = self.get_stream_key(
                user_id=message.user_id, mem_cube_id=message.mem_cube_id
            )

            if stream_key not in self.seen_streams:
                self.seen_streams.add(stream_key)
                self._ensure_consumer_group(stream_key=stream_key)

            # Convert message to dictionary for Redis storage
            message_data = message.to_dict()

            # Add to Redis stream with automatic trimming
            message_id = self._redis_conn.xadd(
                stream_key, message_data, maxlen=self.max_len, approximate=True
            )

            logger.info(
                f"Added message {message_id} to Redis stream: {message.label} - {message.content[:100]}..."
            )

        except Exception as e:
            logger.error(f"Failed to add message to Redis queue: {e}")
            raise

    def ack_message(self, user_id, mem_cube_id, redis_message_id) -> None:
        stream_key = self.get_stream_key(user_id=user_id, mem_cube_id=mem_cube_id)

        self.redis.xack(stream_key, self.consumer_group, redis_message_id)

        # Optionally delete the message from the stream to keep it clean
        if self.auto_delete_acked:
            try:
                self._redis_conn.xdel(stream_key, redis_message_id)
                logger.info(f"Successfully delete acknowledged message {redis_message_id}")
            except Exception as e:
                logger.warning(f"Failed to delete acknowledged message {redis_message_id}: {e}")

    def get(
        self,
        stream_key: str,
        block: bool = True,
        timeout: float | None = None,
        batch_size: int | None = None,
    ) -> list[ScheduleMessageItem]:
        if not self._redis_conn:
            raise ConnectionError("Not connected to Redis. Redis connection not available.")

        try:
            # Calculate timeout for Redis
            redis_timeout = None
            if block and timeout is not None:
                redis_timeout = int(timeout * 1000)
            elif not block:
                redis_timeout = None  # Non-blocking

            # Read messages from the consumer group
            try:
                messages = self._redis_conn.xreadgroup(
                    self.consumer_group,
                    self.consumer_name,
                    {stream_key: ">"},
                    count=batch_size if not batch_size else 1,
                    block=redis_timeout,
                )
            except Exception as read_err:
                # Handle missing group/stream by creating and retrying once
                err_msg = str(read_err).lower()
                if "nogroup" in err_msg or "no such key" in err_msg:
                    logger.warning(
                        f"Consumer group or stream missing for '{stream_key}/{self.consumer_group}'. Attempting to create and retry."
                    )
                    self._ensure_consumer_group(stream_key=stream_key)
                    messages = self._redis_conn.xreadgroup(
                        self.consumer_group,
                        self.consumer_name,
                        {stream_key: ">"},
                        count=batch_size if not batch_size else 1,
                        block=redis_timeout,
                    )
                else:
                    raise
            result_messages = []

            for _stream, stream_messages in messages:
                for message_id, fields in stream_messages:
                    try:
                        # Convert Redis message back to SchedulerMessageItem
                        message = ScheduleMessageItem.from_dict(fields)
                        message.redis_message_id = message_id

                        result_messages.append(message)

                    except Exception as e:
                        logger.error(f"Failed to parse message {message_id}: {e}")

            # Always return a list for consistency
            if not result_messages:
                if not block:
                    return []  # Return empty list for non-blocking calls
                else:
                    # If no messages were found, raise Empty exception
                    from queue import Empty

                    raise Empty("No messages available in Redis queue")

            return result_messages if batch_size is not None else result_messages[0]

        except Exception as e:
            if "Empty" in str(type(e).__name__):
                raise
            logger.error(f"Failed to get message from Redis queue: {e}")
            raise

    def get_nowait(
        self, user_id: str, mem_cube_id: str, batch_size: int | None = None
    ) -> list[ScheduleMessageItem]:
        """
        Get messages from the Redis queue without blocking (Queue-compatible interface).

        Returns:
            List of SchedulerMessageItem objects

        Raises:
            Empty: If no message is available
        """
        return self.get(
            user_id=user_id, mem_cube_id=mem_cube_id, block=False, batch_size=batch_size
        )

    def qsize(self) -> int:
        """
        Get the current size of the Redis queue (Queue-compatible interface).

        This method scans for all streams matching the `stream_key_prefix`
        and sums up their lengths to get the total queue size.

        Returns:
            Total number of messages across all matching streams.
        """
        if not self._redis_conn:
            return 0

        total_size = 0
        try:
            # Scan for all stream keys matching the prefix
            for stream_key in self._redis_conn.scan_iter(f"{self.stream_key_prefix}:*"):
                try:
                    # Get the length of each stream and add to total
                    total_size += self._redis_conn.xlen(stream_key)
                except Exception as e:
                    logger.debug(f"Failed to get length for stream {stream_key}: {e}")
            return total_size
        except Exception as e:
            logger.error(f"Failed to get Redis queue size: {e}")
            return 0

    def get_stream_keys(self) -> list[str]:
        """
        List all Redis stream keys that match this queue's prefix.

        Returns:
            A list of stream keys like `"{prefix}:{user_id}:{mem_cube_id}"`.
        """
        if not self._redis_conn:
            return []

        # First, get all keys that might match (using Redis pattern matching)
        redis_pattern = f"{self.stream_key_prefix}:*"
        raw_keys = [
            key.decode("utf-8") if isinstance(key, bytes) else key
            for key in self._redis_conn.scan_iter(match=redis_pattern)
        ]

        # Second, filter using Python regex to ensure exact prefix match
        # Escape special regex characters in the prefix, then add :.*
        escaped_prefix = re.escape(self.stream_key_prefix)
        regex_pattern = f"^{escaped_prefix}:"
        stream_keys = [key for key in raw_keys if re.match(regex_pattern, key)]

        logger.debug(f"get stream_keys from redis: {stream_keys}")
        return stream_keys

    def size(self) -> int:
        """
        Get the current size of the Redis queue (alias for qsize).

        Returns:
            Number of messages in the queue
        """
        return self.qsize()

    def empty(self) -> bool:
        """
        Check if the Redis queue is empty (Queue-compatible interface).

        Returns:
            True if the queue is empty, False otherwise
        """
        return self.qsize() == 0

    def full(self) -> bool:
        """
        Check if the Redis queue is full (Queue-compatible interface).

        For Redis streams, we consider the queue full if it exceeds maxsize.
        If maxsize is 0 or None, the queue is never considered full.

        Returns:
            True if the queue is full, False otherwise
        """
        if self.maxsize <= 0:
            return False
        return self.qsize() >= self.maxsize

    def join(self) -> None:
        """
        Block until all items in the queue have been gotten and processed (Queue-compatible interface).

        For Redis streams, this would require tracking pending messages,
        which is complex. For now, this is a no-op.
        """

    def clear(self) -> None:
        """Clear all messages from the queue."""
        if not self._is_connected or not self._redis_conn:
            return

        try:
            stream_keys = self.get_stream_keys()

            for stream_key in stream_keys:
                # Delete the entire stream
                self._redis_conn.delete(stream_key)
                logger.info(f"Cleared Redis stream: {stream_key}")

        except Exception as e:
            logger.error(f"Failed to clear Redis queue: {e}")

    def start_listening(
        self,
        handler: Callable[[ScheduleMessageItem], None],
        batch_size: int = 10,
        poll_interval: float = 0.1,
    ) -> None:
        """
        Start listening for messages and process them with the provided handler.

        Args:
            handler: Function to call for each received message
            batch_size: Number of messages to process in each batch
            poll_interval: Interval between polling attempts in seconds
        """
        if not self._is_connected:
            raise ConnectionError("Not connected to Redis. Call connect() first.")

        self._message_handler = handler
        self._is_listening = True

        logger.info(f"Started listening on Redis stream: {self.stream_key_prefix}")

        try:
            while self._is_listening:
                messages = self.get(timeout=poll_interval, count=batch_size)

                for message in messages:
                    try:
                        self._message_handler(message)
                    except Exception as e:
                        logger.error(f"Error processing message {message.item_id}: {e}")

                # Small sleep to prevent excessive CPU usage
                if not messages:
                    time.sleep(poll_interval)

        except KeyboardInterrupt:
            logger.info("Received interrupt signal, stopping listener")
        except Exception as e:
            logger.error(f"Error in message listener: {e}")
        finally:
            self._is_listening = False
            logger.info("Stopped listening for messages")

    def stop_listening(self) -> None:
        """Stop the message listener."""
        self._is_listening = False
        logger.info("Requested stop for message listener")

    def connect(self) -> None:
        """Establish connection to Redis and set up the queue."""
        if self._redis_conn is not None:
            try:
                # Test the connection
                self._redis_conn.ping()
                self._is_connected = True
                logger.debug("Redis connection established successfully")
            except Exception as e:
                logger.error(f"Failed to connect to Redis: {e}")
                self._is_connected = False
        else:
            logger.error("Redis connection not initialized")
            self._is_connected = False

    def disconnect(self) -> None:
        """Disconnect from Redis and clean up resources."""
        self._is_connected = False
        if self._is_listening:
            self.stop_listening()
        logger.debug("Disconnected from Redis")

    def __enter__(self):
        """Context manager entry."""
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.stop_listening()
        self.disconnect()

    def __del__(self):
        """Cleanup when object is destroyed."""
        if self._is_connected:
            self.disconnect()

    @property
    def unfinished_tasks(self) -> int:
        return self.qsize()
