"""
Redis Queue implementation for SchedulerMessageItem objects.

This module provides a Redis-based queue implementation that can replace
the local memos_message_queue functionality in BaseScheduler.
"""

import os
import re
import threading
import time

from collections import deque
from collections.abc import Callable
from uuid import uuid4

from memos.context.context import ContextThread
from memos.log import get_logger
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_PENDING_CLAIM_MIN_IDLE_MS,
    DEFAULT_STREAM_KEY_PREFIX,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.task_schedule_modules.orchestrator import SchedulerOrchestrator
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
        stream_key_prefix: str = os.getenv(
            "MEMSCHEDULER_REDIS_STREAM_KEY_PREFIX",
            DEFAULT_STREAM_KEY_PREFIX,
        ),
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

        # Broker flush threshold and async refill control
        self.task_broker_flush_bar = 10
        self._refill_lock = threading.Lock()
        self._refill_thread: ContextThread | None = None

        logger.info(
            f"[REDIS_QUEUE] Initialized with stream_prefix='{self.stream_key_prefix}', "
            f"consumer_group='{self.consumer_group}', consumer_name='{self.consumer_name}'"
        )

        # Auto-initialize Redis connection
        if self.auto_initialize_redis():
            self._is_connected = True

        self.seen_streams = set()

        # Task Orchestrator
        self.message_pack_cache = deque()
        self.orchestrator = SchedulerOrchestrator(queue=self)

    def get_stream_key(self, user_id: str, mem_cube_id: str, task_label: str) -> str:
        stream_key = f"{self.stream_key_prefix}:{user_id}:{mem_cube_id}:{task_label}"
        return stream_key

    def task_broker(
        self,
        consume_batch_size: int,
    ) -> list[list[ScheduleMessageItem]]:
        stream_keys = self.get_stream_keys(stream_key_prefix=self.stream_key_prefix)
        if not stream_keys:
            return []

        stream_quotas = self.orchestrator.get_stream_quotas(
            stream_keys=stream_keys, consume_batch_size=consume_batch_size
        )
        cache: list[ScheduleMessageItem] = []
        for stream_key in stream_keys:
            messages = self.get(
                stream_key=stream_key,
                block=False,
                batch_size=stream_quotas[stream_key],
            )
            cache.extend(messages)

        # pack messages
        packed: list[list[ScheduleMessageItem]] = []
        for i in range(0, len(cache), consume_batch_size):
            packed.append(cache[i : i + consume_batch_size])
        # return packed list without overwriting existing cache
        return packed

    def _async_refill_cache(self, batch_size: int) -> None:
        """Background thread to refill message cache without blocking get_messages."""
        try:
            logger.debug(f"Starting async cache refill with batch_size={batch_size}")
            new_packs = self.task_broker(consume_batch_size=batch_size)
            logger.debug(f"task_broker returned {len(new_packs)} packs")
            with self._refill_lock:
                for pack in new_packs:
                    if pack:  # Only add non-empty packs
                        self.message_pack_cache.append(pack)
                        logger.debug(f"Added pack with {len(pack)} messages to cache")
            logger.debug(f"Cache refill complete, cache size now: {len(self.message_pack_cache)}")
        except Exception as e:
            logger.warning(f"Async cache refill failed: {e}", exc_info=True)

    def get_messages(self, batch_size: int) -> list[ScheduleMessageItem]:
        if self.message_pack_cache:
            # Trigger async refill if below threshold (non-blocking)
            if len(self.message_pack_cache) < self.task_broker_flush_bar and (
                self._refill_thread is None or not self._refill_thread.is_alive()
            ):
                logger.debug(
                    f"Triggering async cache refill: cache size {len(self.message_pack_cache)} < {self.task_broker_flush_bar}"
                )
                self._refill_thread = ContextThread(
                    target=self._async_refill_cache, args=(batch_size,), name="redis-cache-refill"
                )
                self._refill_thread.start()
            else:
                logger.debug(f"The size of message_pack_cache is {len(self.message_pack_cache)}")
        else:
            new_packs = self.task_broker(consume_batch_size=batch_size)
            for pack in new_packs:
                if pack:  # Only add non-empty packs
                    self.message_pack_cache.append(pack)
        if len(self.message_pack_cache) == 0:
            return []
        else:
            return self.message_pack_cache.popleft()

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

    # Pending lock methods removed as they are unnecessary with idle-threshold claiming

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
                user_id=message.user_id, mem_cube_id=message.mem_cube_id, task_label=message.label
            )

            if stream_key not in self.seen_streams:
                self.seen_streams.add(stream_key)
                self._ensure_consumer_group(stream_key=stream_key)

            message.stream_key = stream_key

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

    def ack_message(
        self, user_id: str, mem_cube_id: str, task_label: str, redis_message_id
    ) -> None:
        stream_key = self.get_stream_key(
            user_id=user_id, mem_cube_id=mem_cube_id, task_label=task_label
        )
        # No-op if not connected or message doesn't come from Redis
        if not self._redis_conn:
            logger.debug(
                f"Skip ack: Redis not connected for stream '{stream_key}', msg_id='{redis_message_id}'"
            )
            return
        if not redis_message_id:
            logger.debug(
                f"Skip ack: Empty redis_message_id for stream '{stream_key}', user_id='{user_id}', label='{task_label}'"
            )
            return

        try:
            self._redis_conn.xack(stream_key, self.consumer_group, redis_message_id)
        except Exception as e:
            logger.warning(
                f"xack failed for stream '{stream_key}', msg_id='{redis_message_id}': {e}"
            )
            return

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
            # 1) Read remaining/new messages first (not yet delivered to any consumer)
            new_messages: list[tuple[str, list[tuple[str, dict]]]] = []
            try:
                new_messages = self._redis_conn.xreadgroup(
                    self.consumer_group,
                    self.consumer_name,
                    {stream_key: ">"},
                    count=(batch_size if batch_size is not None else None),
                    block=redis_timeout,
                )
            except Exception as read_err:
                # Handle missing group/stream by creating and retrying once
                err_msg = str(read_err).lower()
                if "nogroup" in err_msg or "no such key" in err_msg:
                    logger.warning(
                        f"Consumer group or stream missing for '{stream_key}/{self.consumer_group}'. Attempting to create and retry (new)."
                    )
                    self._ensure_consumer_group(stream_key=stream_key)
                    new_messages = self._redis_conn.xreadgroup(
                        self.consumer_group,
                        self.consumer_name,
                        {stream_key: ">"},
                        count=(batch_size if batch_size is not None else None),
                        block=redis_timeout,
                    )
                else:
                    raise

            # 2) If needed, read pending messages for THIS consumer only
            pending_messages: list[tuple[str, list[tuple[str, dict]]]] = []
            need_pending_count = None
            if batch_size is None:
                # No batch_size: prefer returning a single new message; if none, fetch one pending
                if not new_messages:
                    need_pending_count = 1
            else:
                # With batch_size: fill from pending if new insufficient
                new_count = sum(len(sm) for _s, sm in new_messages) if new_messages else 0
                need_pending = max(0, batch_size - new_count)
                need_pending_count = need_pending if need_pending > 0 else 0

            if need_pending_count:
                # Claim only pending messages whose idle time exceeds configured threshold
                try:
                    # Ensure group exists before claiming
                    self._ensure_consumer_group(stream_key=stream_key)
                    # XAUTOCLAIM returns (next_start_id, [(id, fields), ...])
                    next_id, claimed = self._redis_conn.xautoclaim(
                        name=stream_key,
                        groupname=self.consumer_group,
                        consumername=self.consumer_name,
                        min_idle_time=DEFAULT_PENDING_CLAIM_MIN_IDLE_MS,
                        start_id="0-0",
                        count=need_pending_count,
                        justid=False,
                    )
                    pending_messages = [(stream_key, claimed)] if claimed else []
                except Exception as read_err:
                    # Handle missing group/stream by creating and retrying once
                    err_msg = str(read_err).lower()
                    if "nogroup" in err_msg or "no such key" in err_msg:
                        logger.warning(
                            f"Consumer group or stream missing for '{stream_key}/{self.consumer_group}'. Attempting to create and retry (xautoclaim)."
                        )
                        try:
                            self._ensure_consumer_group(stream_key=stream_key)
                            next_id, claimed = self._redis_conn.xautoclaim(
                                name=stream_key,
                                groupname=self.consumer_group,
                                consumername=self.consumer_name,
                                min_idle_time=DEFAULT_PENDING_CLAIM_MIN_IDLE_MS,
                                start_id="0-0",
                                count=need_pending_count,
                                justid=False,
                            )
                            pending_messages = [(stream_key, claimed)] if claimed else []
                        except Exception:
                            pending_messages = []
                    else:
                        pending_messages = []

            # Combine: new first, then pending
            messages = []
            if new_messages:
                messages.extend(new_messages)
            if pending_messages:
                messages.extend(pending_messages)

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

    def qsize(self) -> dict:
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
            qsize_stats = {}
            # Use filtered stream keys to avoid WRONGTYPE on non-stream keys
            for stream_key in self.get_stream_keys():
                stream_qsize = self._redis_conn.xlen(stream_key)
                qsize_stats[stream_key] = stream_qsize
                total_size += stream_qsize
            qsize_stats["total_size"] = total_size
            return qsize_stats

        except Exception as e:
            logger.error(f"Failed to get Redis queue size: {e}")
            return {}

    def get_stream_keys(self, stream_key_prefix: str | None = None) -> list[str]:
        """
        List all Redis stream keys that match this queue's prefix.

        Only returns actual Redis Stream keys, excluding auxiliary keys
        (e.g., any lock or string/hash keys). This avoids WRONGTYPE errors
        when issuing stream commands on non-stream keys.

        Returns:
            A list of stream keys like `"{prefix}:{user_id}:{mem_cube_id}:{task_label}"`.
        """
        if not self._redis_conn:
            return []

        if stream_key_prefix is None:
            stream_key_prefix = self.stream_key_prefix
        # First, get all keys that might match (using Redis pattern matching)
        redis_pattern = f"{stream_key_prefix}:*"
        raw_keys_iter = self._redis_conn.scan_iter(match=redis_pattern)
        raw_keys = list(raw_keys_iter)

        # Second, filter using Python regex to ensure exact prefix match
        # Escape special regex characters in the prefix, then add :.*
        escaped_prefix = re.escape(stream_key_prefix)
        regex_pattern = f"^{escaped_prefix}:"
        stream_keys = [key for key in raw_keys if re.match(regex_pattern, key)]

        return stream_keys

    def size(self) -> int:
        """
        Get the current size of the Redis queue (total message count from qsize dict).

        Returns:
            Total number of messages across all streams
        """
        qsize_result = self.qsize()
        return qsize_result.get("total_size", 0)

    def empty(self) -> bool:
        """
        Check if the Redis queue is empty (Queue-compatible interface).

        Returns:
            True if the queue is empty, False otherwise
        """
        return self.size() == 0

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
        return self.size() >= self.maxsize

    def join(self) -> None:
        """
        Block until all items in the queue have been gotten and processed (Queue-compatible interface).

        For Redis streams, this would require tracking pending messages,
        which is complex. For now, this is a no-op.
        """

    def clear(self, stream_key=None) -> None:
        """Clear all messages from the queue."""
        if not self._is_connected or not self._redis_conn:
            return

        try:
            if stream_key is not None:
                self._redis_conn.delete(stream_key)
                logger.info(f"Cleared Redis stream: {stream_key}")
            else:
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
