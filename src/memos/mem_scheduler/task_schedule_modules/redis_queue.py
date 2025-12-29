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
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    DEFAULT_STREAM_INACTIVITY_DELETE_SECONDS,
    DEFAULT_STREAM_KEY_PREFIX,
    DEFAULT_STREAM_KEYS_REFRESH_INTERVAL_SEC,
    DEFAULT_STREAM_RECENT_ACTIVE_SECONDS,
)
from memos.mem_scheduler.task_schedule_modules.orchestrator import SchedulerOrchestrator
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker
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
        orchestrator: SchedulerOrchestrator | None = None,
        consumer_group: str = "scheduler_group",
        consumer_name: str | None = "scheduler_consumer",
        max_len: int | None = None,
        auto_delete_acked: bool = True,  # Whether to automatically delete acknowledged messages
        status_tracker: TaskStatusTracker | None = None,
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
        # Stream configuration
        self.stream_key_prefix = stream_key_prefix
        # Precompile regex for prefix filtering to reduce repeated compilation overhead
        self.stream_prefix_regex_pattern = re.compile(f"^{re.escape(self.stream_key_prefix)}:")
        self.consumer_group = consumer_group
        self.consumer_name = f"{consumer_name}_{uuid4().hex[:8]}"
        self.max_len = max_len
        self.auto_delete_acked = auto_delete_acked  # Whether to delete acknowledged messages
        self.status_tracker = status_tracker

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

        # Track empty streams first-seen time to avoid zombie keys
        self._empty_stream_seen_times: dict[str, float] = {}
        self._empty_stream_seen_lock = threading.Lock()

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

        self.orchestrator = SchedulerOrchestrator() if orchestrator is None else orchestrator

        # Cached stream keys and refresh control
        self._stream_keys_cache: list[str] = []
        self._stream_keys_last_refresh: float = 0.0
        self._stream_keys_refresh_interval_sec: float = DEFAULT_STREAM_KEYS_REFRESH_INTERVAL_SEC
        self._stream_keys_lock = threading.Lock()
        self._stream_keys_refresh_thread: ContextThread | None = None
        self._stream_keys_refresh_stop_event = threading.Event()
        self._initial_scan_max_keys = int(
            os.getenv("MEMSCHEDULER_REDIS_INITIAL_SCAN_MAX_KEYS", "1000") or 1000
        )
        self._initial_scan_time_limit_sec = float(
            os.getenv("MEMSCHEDULER_REDIS_INITIAL_SCAN_TIME_LIMIT_SEC", "1.0") or 1.0
        )

        # Pipeline chunk size for XREVRANGE pipelined calls
        self._pipeline_chunk_size = int(
            os.getenv("MEMSCHEDULER_REDIS_PIPELINE_CHUNK_SIZE", "200") or 200
        )

        # Start background stream keys refresher if connected
        if self._is_connected:
            try:
                self._refresh_stream_keys(
                    max_keys=self._initial_scan_max_keys,
                    time_limit_sec=self._initial_scan_time_limit_sec,
                )
            except Exception as e:
                logger.debug(f"Initial stream keys refresh failed: {e}")
            self._start_stream_keys_refresh_thread()

    def get_stream_key(self, user_id: str, mem_cube_id: str, task_label: str) -> str:
        stream_key = f"{self.stream_key_prefix}:{user_id}:{mem_cube_id}:{task_label}"
        return stream_key

    # --- Stream keys refresh background thread ---
    def _refresh_stream_keys(
        self,
        stream_key_prefix: str | None = None,
        max_keys: int | None = None,
        time_limit_sec: float | None = None,
    ) -> list[str]:
        """Scan Redis and refresh cached stream keys for the queue prefix."""
        if not self._redis_conn:
            return []

        if stream_key_prefix is None:
            stream_key_prefix = self.stream_key_prefix

        try:
            candidate_keys = self._scan_candidate_stream_keys(
                stream_key_prefix=stream_key_prefix,
                max_keys=max_keys,
                time_limit_sec=time_limit_sec,
            )
            chunked_results = self._pipeline_last_entries(candidate_keys)
            # Only process successful chunks to maintain 1:1 key-result mapping
            processed_keys: list[str] = []
            last_entries_results: list[list[tuple[str, dict]]] = []

            total_key_count = 0
            for chunk_keys, chunk_res, success in chunked_results:
                if success:
                    processed_keys.extend(chunk_keys)
                    last_entries_results.extend(chunk_res)
                    total_key_count += len(chunk_keys)

            # Abort refresh if any chunk failed, indicated by processed count mismatch
            if len(candidate_keys) != total_key_count:
                logger.error(
                    f"[REDIS_QUEUE] Last entries processed mismatch: "
                    f"candidates={len(candidate_keys)}, processed={len(processed_keys)}; aborting refresh"
                )
                return []

            now_sec = time.time()
            keys_to_delete = self._collect_inactive_keys(
                candidate_keys=processed_keys,
                last_entries_results=last_entries_results,
                inactivity_seconds=DEFAULT_STREAM_INACTIVITY_DELETE_SECONDS,
                now_sec=now_sec,
            )
            active_stream_keys = self._filter_active_keys(
                candidate_keys=processed_keys,
                last_entries_results=last_entries_results,
                recent_seconds=DEFAULT_STREAM_RECENT_ACTIVE_SECONDS,
                now_sec=now_sec,
            )

            # Ensure consumer groups for newly discovered active streams
            with self._stream_keys_lock:
                # Identify keys we haven't seen yet
                new_streams = [k for k in active_stream_keys if k not in self.seen_streams]

            # Create groups outside the lock to avoid blocking
            for key in new_streams:
                self._ensure_consumer_group(key)

            if new_streams:
                with self._stream_keys_lock:
                    self.seen_streams.update(new_streams)

            deleted_count = self._delete_streams(keys_to_delete)
            self._update_stream_cache_with_log(
                stream_key_prefix=stream_key_prefix,
                candidate_keys=processed_keys,
                active_stream_keys=active_stream_keys,
                deleted_count=deleted_count,
                active_threshold_sec=DEFAULT_STREAM_RECENT_ACTIVE_SECONDS,
            )
            return active_stream_keys
        except Exception as e:
            logger.warning(f"Failed to refresh stream keys: {e}")
            return []

    def _stream_keys_refresh_loop(self) -> None:
        """Background loop to periodically refresh Redis stream keys cache."""
        # Seed cache immediately
        self._refresh_stream_keys()
        logger.debug(
            f"Stream keys refresher started with interval={self._stream_keys_refresh_interval_sec}s"
        )
        while not self._stream_keys_refresh_stop_event.is_set():
            try:
                self._refresh_stream_keys()
            except Exception as e:
                logger.warning(f"Stream keys refresh iteration failed: {e}")
            # Wait with ability to be interrupted
            self._stream_keys_refresh_stop_event.wait(self._stream_keys_refresh_interval_sec)

        logger.debug("Stream keys refresher stopped")

    def _start_stream_keys_refresh_thread(self) -> None:
        if self._stream_keys_refresh_thread and self._stream_keys_refresh_thread.is_alive():
            return
        self._stream_keys_refresh_stop_event.clear()
        self._stream_keys_refresh_thread = ContextThread(
            target=self._stream_keys_refresh_loop,
            name="redis-stream-keys-refresher",
            daemon=True,
        )
        self._stream_keys_refresh_thread.start()

    def _stop_stream_keys_refresh_thread(self) -> None:
        try:
            self._stream_keys_refresh_stop_event.set()
            if self._stream_keys_refresh_thread and self._stream_keys_refresh_thread.is_alive():
                self._stream_keys_refresh_thread.join(timeout=2.0)
        except Exception as e:
            logger.debug(f"Stopping stream keys refresh thread encountered: {e}")

    def task_broker(
        self,
        consume_batch_size: int,
    ) -> list[list[ScheduleMessageItem]]:
        stream_keys = self.get_stream_keys(stream_key_prefix=self.stream_key_prefix)
        if not stream_keys:
            return []

        # Determine per-stream quotas for this cycle
        stream_quotas = self.orchestrator.get_stream_quotas(
            stream_keys=stream_keys, consume_batch_size=consume_batch_size
        )

        # Step A: batch-read new messages across streams (non-blocking)
        new_messages_map: dict[str, list[tuple[str, list[tuple[str, dict]]]]] = (
            self._read_new_messages_batch(stream_keys=stream_keys, stream_quotas=stream_quotas)
        )

        # Step B: compute pending needs per stream
        claims_spec: list[tuple[str, int, str]] = []
        for stream_key in stream_keys:
            need_pending_count = self._compute_pending_need(
                new_messages=new_messages_map.get(stream_key),
                batch_size=stream_quotas[stream_key],
            )
            if need_pending_count:
                # Derive task label from stream key suffix
                task_label = stream_key.rsplit(":", 1)[1]
                claims_spec.append((stream_key, need_pending_count, task_label))

        # Step C: batch claim pending messages across streams
        claimed_messages: list[tuple[str, list[tuple[str, dict]]]] = []
        if claims_spec:
            claimed_messages = self._batch_claim_pending_messages(claims_spec=claims_spec)

        # Step D: assemble and convert to ScheduleMessageItem
        messages: list[tuple[str, list[tuple[str, dict]]]] = []
        for stream_key in stream_keys:
            nm = new_messages_map.get(stream_key)
            if nm:
                messages.extend(nm)

        if claimed_messages:
            messages.extend(claimed_messages)

        cache: list[ScheduleMessageItem] = self._convert_messages(messages)

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
            if not ("busygroup" in error_msg or "already exists" in error_msg):
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

            # Update stream keys cache with newly observed stream key
            with self._stream_keys_lock:
                if stream_key not in self.seen_streams:
                    self.seen_streams.add(stream_key)
                    self._ensure_consumer_group(stream_key=stream_key)

                if stream_key not in self._stream_keys_cache:
                    self._stream_keys_cache.append(stream_key)
                    self._stream_keys_last_refresh = time.time()

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
        self,
        user_id: str,
        mem_cube_id: str,
        task_label: str,
        redis_message_id,
        message: ScheduleMessageItem | None,
    ) -> None:
        if message and hasattr(message, "stream_key") and message.stream_key:
            stream_key = message.stream_key
        else:
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
        if self.auto_delete_acked:
            # Optionally delete the message from the stream to keep it clean
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
        batch_size: int | None = 1,
    ) -> list[ScheduleMessageItem]:
        if not self._redis_conn:
            raise ConnectionError("Not connected to Redis. Redis connection not available.")

        redis_timeout = self._compute_redis_timeout(block=block, timeout=timeout)

        # Step 1: read new messages first
        new_messages = self._read_new_messages(
            stream_key=stream_key, batch_size=batch_size, redis_timeout=redis_timeout
        )

        # Step 2: determine how many pending messages we need
        need_pending_count = self._compute_pending_need(
            new_messages=new_messages, batch_size=batch_size
        )

        # Step 3: claim eligible pending messages
        pending_messages: list[tuple[str, list[tuple[str, dict]]]] = []
        if need_pending_count:
            task_label = stream_key.rsplit(":", 1)[1]
            pending_messages = self._claim_pending_messages(
                stream_key=stream_key,
                need_pending_count=need_pending_count,
                task_label=task_label,
            )

        # Step 4: assemble and convert to ScheduleMessageItem
        messages = []
        if new_messages:
            messages.extend(new_messages)
        if pending_messages:
            messages.extend(pending_messages)

        result_messages = self._convert_messages(messages)

        if not result_messages:
            if not block:
                return []
            else:
                from queue import Empty

                raise Empty("No messages available in Redis queue")

        return result_messages

    def _compute_redis_timeout(self, block: bool, timeout: float | None) -> int | None:
        """Compute Redis block timeout in milliseconds for xreadgroup."""
        if block and timeout is not None:
            return int(timeout * 1000)
        return None

    def _read_new_messages(
        self, stream_key: str, batch_size: int | None, redis_timeout: int | None
    ) -> list[tuple[str, list[tuple[str, dict]]]]:
        """Read new messages for the consumer group, handling missing group/stream."""
        try:
            return self._redis_conn.xreadgroup(
                self.consumer_group,
                self.consumer_name,
                {stream_key: ">"},
                count=batch_size,
                block=redis_timeout,
            )
        except Exception as read_err:
            err_msg = str(read_err).lower()
            if "nogroup" in err_msg or "no such key" in err_msg:
                logger.warning(
                    f"Consumer group or stream missing for '{stream_key}/{self.consumer_group}'. Attempting to create and retry (new)."
                )
                self._ensure_consumer_group(stream_key=stream_key)
                return self._redis_conn.xreadgroup(
                    self.consumer_group,
                    self.consumer_name,
                    {stream_key: ">"},
                    count=batch_size,
                    block=redis_timeout,
                )
            logger.error(f"{read_err}", stack_info=True)
            raise

    def _read_new_messages_batch(
        self, stream_keys: list[str], stream_quotas: dict[str, int]
    ) -> dict[str, list[tuple[str, list[tuple[str, dict]]]]]:
        """Batch-read new messages (non-blocking) across multiple streams.

        Uses a Redis pipeline to reduce round trips while honoring per-stream quotas.

        Args:
            stream_keys: List of stream keys to read from.
            stream_quotas: Per-stream message upper bounds.

        Returns:
            Mapping from stream key to xreadgroup-style result list.
        """
        if not self._redis_conn or not stream_keys:
            return {}

        # Pre-ensure consumer groups to avoid NOGROUP during batch reads
        # (Optimization: rely on put() and _refresh_stream_keys() to ensure groups)
        pipe = self._redis_conn.pipeline(transaction=False)
        for stream_key in stream_keys:
            pipe.xreadgroup(
                self.consumer_group,
                self.consumer_name,
                {stream_key: ">"},
                count=stream_quotas.get(stream_key),
                block=None,
            )

        try:
            res_list = pipe.execute()
        except Exception as e:
            err_msg = str(e).lower()
            if "nogroup" in err_msg or "no such key" in err_msg:
                # Fallback to sequential non-blocking reads
                res_list = []
                for stream_key in stream_keys:
                    try:
                        self._ensure_consumer_group(stream_key=stream_key)
                        res = self._redis_conn.xreadgroup(
                            self.consumer_group,
                            self.consumer_name,
                            {stream_key: ">"},
                            count=stream_quotas.get(stream_key),
                            block=None,
                        )
                        res_list.append(res)
                    except Exception:
                        res_list.append([])
            else:
                logger.error(f"Pipeline xreadgroup failed: {e}")
                res_list = []

        out: dict[str, list[tuple[str, list[tuple[str, dict]]]]] = {}
        for stream_key, res in zip(stream_keys, res_list, strict=False):
            out[stream_key] = res or []
        return out

    def _compute_pending_need(
        self, new_messages: list[tuple[str, list[tuple[str, dict]]]] | None, batch_size: int | None
    ) -> int:
        """Compute how many pending messages are needed to fill the batch."""
        if batch_size is None:
            return 1 if not new_messages else 0
        new_count = sum(len(sm) for _s, sm in new_messages) if new_messages else 0
        need_pending = max(0, batch_size - new_count)
        return need_pending if need_pending > 0 else 0

    def _claim_pending_messages(
        self, stream_key: str, need_pending_count: int, task_label: str
    ) -> list[tuple[str, list[tuple[str, dict]]]]:
        """Claim pending messages exceeding idle threshold, with group existence handling."""
        try:
            claimed_result = self._redis_conn.xautoclaim(
                name=stream_key,
                groupname=self.consumer_group,
                consumername=self.consumer_name,
                min_idle_time=self.orchestrator.get_task_idle_min(task_label=task_label),
                start_id="0-0",
                count=need_pending_count,
                justid=False,
            )
            if len(claimed_result) == 2:
                next_id, claimed = claimed_result
                deleted_ids = []
            elif len(claimed_result) == 3:
                next_id, claimed, deleted_ids = claimed_result
            else:
                raise ValueError(f"Unexpected xautoclaim response length: {len(claimed_result)}")

            return [(stream_key, claimed)] if claimed else []
        except Exception as read_err:
            err_msg = str(read_err).lower()
            if "nogroup" in err_msg or "no such key" in err_msg:
                logger.warning(
                    f"Consumer group or stream missing for '{stream_key}/{self.consumer_group}'. Attempting to create and retry (xautoclaim)."
                )
                self._ensure_consumer_group(stream_key=stream_key)
                claimed_result = self._redis_conn.xautoclaim(
                    name=stream_key,
                    groupname=self.consumer_group,
                    consumername=self.consumer_name,
                    min_idle_time=self.orchestrator.get_task_idle_min(task_label=task_label),
                    start_id="0-0",
                    count=need_pending_count,
                    justid=False,
                )
                if len(claimed_result) == 2:
                    next_id, claimed = claimed_result
                    deleted_ids = []
                elif len(claimed_result) == 3:
                    next_id, claimed, deleted_ids = claimed_result
                else:
                    raise ValueError(
                        f"Unexpected xautoclaim response length: {len(claimed_result)}"
                    ) from read_err

                return [(stream_key, claimed)] if claimed else []
            return []

    def _batch_claim_pending_messages(
        self, claims_spec: list[tuple[str, int, str]]
    ) -> list[tuple[str, list[tuple[str, dict]]]]:
        """Batch-claim pending messages across multiple streams.

        Args:
            claims_spec: List of tuples (stream_key, need_pending_count, task_label)

        Returns:
            A list of (stream_key, claimed_entries) pairs for all successful claims.
        """
        if not self._redis_conn or not claims_spec:
            return []

        pipe = self._redis_conn.pipeline(transaction=False)
        for stream_key, need_count, label in claims_spec:
            pipe.xautoclaim(
                name=stream_key,
                groupname=self.consumer_group,
                consumername=self.consumer_name,
                min_idle_time=self.orchestrator.get_task_idle_min(task_label=label),
                start_id="0-0",
                count=need_count,
                justid=False,
            )

        try:
            # Execute with raise_on_error=False so we get exceptions in the results list
            # instead of aborting the whole batch.
            results = pipe.execute(raise_on_error=False)
        except Exception as e:
            logger.error(f"Pipeline execution critical failure: {e}")
            results = [e] * len(claims_spec)

        # Handle individual failures (e.g. NOGROUP) by retrying just that stream
        final_results = []
        for i, res in enumerate(results):
            if isinstance(res, Exception):
                err_msg = str(res).lower()
                if "nogroup" in err_msg or "no such key" in err_msg:
                    stream_key, need_count, label = claims_spec[i]
                    try:
                        self._ensure_consumer_group(stream_key=stream_key)
                        retry_res = self._redis_conn.xautoclaim(
                            name=stream_key,
                            groupname=self.consumer_group,
                            consumername=self.consumer_name,
                            min_idle_time=self.orchestrator.get_task_idle_min(task_label=label),
                            start_id="0-0",
                            count=need_count,
                            justid=False,
                        )
                        final_results.append(retry_res)
                    except Exception as retry_err:
                        logger.warning(f"Retry xautoclaim failed for {stream_key}: {retry_err}")
                        final_results.append(None)
                else:
                    final_results.append(None)
            else:
                final_results.append(res)

        results = final_results

        claimed_pairs: list[tuple[str, list[tuple[str, dict]]]] = []
        for (stream_key, _need_count, _label), claimed_result in zip(
            claims_spec, results, strict=False
        ):
            try:
                if not claimed_result:
                    continue
                if len(claimed_result) == 2:
                    _next_id, claimed = claimed_result
                elif len(claimed_result) == 3:
                    _next_id, claimed, _deleted_ids = claimed_result
                else:
                    raise ValueError(
                        f"Unexpected xautoclaim response length: {len(claimed_result)} for '{stream_key}'"
                    )
                if claimed:
                    claimed_pairs.append((stream_key, claimed))
            except Exception as parse_err:
                logger.warning(f"Failed to parse xautoclaim result for '{stream_key}': {parse_err}")

        return claimed_pairs

    def _convert_messages(
        self, messages: list[tuple[str, list[tuple[str, dict]]]]
    ) -> list[ScheduleMessageItem]:
        """Convert raw Redis messages into ScheduleMessageItem with metadata."""
        result: list[ScheduleMessageItem] = []
        for _stream, stream_messages in messages or []:
            for message_id, fields in stream_messages:
                try:
                    message = ScheduleMessageItem.from_dict(fields)
                    message.stream_key = _stream
                    message.redis_message_id = message_id
                    result.append(message)
                except Exception as e:
                    logger.error(f"Failed to parse message {message_id}: {e}", stack_info=True)
        return result

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
            logger.error(f"Failed to get Redis queue size: {e}", stack_info=True)
            return {}

    def show_task_status(self) -> dict[str, dict[str, int]]:
        stream_keys = self.get_stream_keys(stream_key_prefix=self.stream_key_prefix)
        if not stream_keys:
            logger.info("No Redis streams found for the configured prefix")
            return {}

        consumer_group = self.consumer_group or "scheduler_group"

        grouped: dict[str, dict[str, int]] = {}

        for sk in stream_keys:
            uid = sk
            if uid not in grouped:
                grouped[uid] = {"pending": 0, "remaining": 0}

            # Pending count via XPENDING
            pending_count = 0
            try:
                pending_info = self._redis_conn.xpending(sk, consumer_group)
                # redis-py may return a tuple-like [count, ...]
                if pending_info:
                    try:
                        pending_count = int(pending_info[0])
                    except Exception:
                        # Fallback if structure differs
                        pending_count = int(getattr(pending_info, "count", 0) or 0)
            except Exception as e:
                logger.debug(f"XPENDING failed for '{sk}': {e}")

            # Remaining count via XLEN
            remaining_count = 0
            try:
                remaining_count = int(self._redis_conn.xlen(sk))
            except Exception as e:
                logger.debug(f"XLEN failed for '{sk}': {e}")

            grouped[uid]["pending"] += pending_count
            grouped[uid]["remaining"] += remaining_count

        # Pretty-print summary
        try:
            total_pending = sum(v.get("pending", 0) for v in grouped.values())
            total_remaining = sum(v.get("remaining", 0) for v in grouped.values())
            header = f"Task Queue Status by user_id | pending={total_pending}, remaining={total_remaining}"
            print(header)
            for uid in sorted(grouped.keys()):
                counts = grouped[uid]
                print(
                    f"- {uid}: pending={counts.get('pending', 0)}, remaining={counts.get('remaining', 0)}"
                )
        except Exception:
            # Printing is best-effort; return grouped regardless
            pass

        return grouped

    def get_stream_keys(self, stream_key_prefix: str | None = None) -> list[str]:
        """
        Return cached Redis stream keys maintained by background refresher.

        The cache is updated periodically by a background thread and also
        appended immediately on new stream creation via `put`.

        Before returning, validate that all cached keys match the given
        `stream_key_prefix` (or the queue's configured prefix if None).
        If any key does not match, log an error.
        """
        effective_prefix = stream_key_prefix or self.stream_key_prefix
        with self._stream_keys_lock:
            cache_snapshot = list(self._stream_keys_cache)

        # Validate that cached keys conform to the expected prefix
        escaped_prefix = re.escape(effective_prefix)
        regex_pattern = f"^{escaped_prefix}:"
        for key in cache_snapshot:
            if not re.match(regex_pattern, key):
                logger.error(
                    f"[REDIS_QUEUE] Cached stream key '{key}' does not match prefix '{effective_prefix}:'"
                )

        return cache_snapshot

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
        if self.max_len is None:
            return False
        return self.size() >= self.max_len

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
                messages = self.get_messages(batch_size=1)

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
                # Start stream keys refresher when connected
                self._start_stream_keys_refresh_thread()
            except Exception as e:
                logger.error(f"Failed to connect to Redis: {e}")
                self._is_connected = False
        else:
            logger.error("Redis connection not initialized")
            self._is_connected = False

    def disconnect(self) -> None:
        """Disconnect from Redis and clean up resources."""
        self._is_connected = False
        # Stop background refresher
        self._stop_stream_keys_refresh_thread()
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
        self._stop_stream_keys_refresh_thread()
        if self._is_connected:
            self.disconnect()

    @property
    def unfinished_tasks(self) -> int:
        return self.qsize()

    def _scan_candidate_stream_keys(
        self,
        stream_key_prefix: str,
        max_keys: int | None = None,
        time_limit_sec: float | None = None,
        count_hint: int = 200,
    ) -> list[str]:
        """Return stream keys matching the given prefix via SCAN with optional limits.

        Uses a cursor-based SCAN to collect keys matching the prefix, honoring
        optional `max_keys` and `time_limit_sec` constraints. Filters results
        with a precompiled regex when scanning the configured prefix.
        """
        redis_pattern = f"{stream_key_prefix}:*"
        collected = []
        cursor = 0
        start_ts = time.time() if time_limit_sec else None
        while True:
            if (
                start_ts is not None
                and time_limit_sec is not None
                and (time.time() - start_ts) > time_limit_sec
            ):
                break
            cursor, keys = self._redis_conn.scan(
                cursor=cursor, match=redis_pattern, count=count_hint
            )
            collected.extend(keys)
            if max_keys is not None and len(collected) >= max_keys:
                break
            if cursor == 0 or cursor == "0":
                break

        if stream_key_prefix == self.stream_key_prefix:
            pattern = self.stream_prefix_regex_pattern
        else:
            escaped_prefix = re.escape(stream_key_prefix)
            pattern = re.compile(f"^{escaped_prefix}:")
        return [key for key in collected if pattern.match(key)]

    def _pipeline_last_entries(
        self, candidate_keys: list[str]
    ) -> list[tuple[list[str], list[list[tuple[str, dict]]], bool]]:
        """Fetch last entries for keys using pipelined XREVRANGE COUNT 1, per-chunk success.

        Returns a list of tuples: (chunk_keys, chunk_results, success_bool).
        Only successful chunks should be processed by the caller to preserve
        a 1:1 mapping between keys and results.
        """
        if not candidate_keys:
            return []

        results_chunks: list[tuple[list[str], list[list[tuple[str, dict]]], bool]] = []
        chunk_size = max(1, int(self._pipeline_chunk_size))

        for start in range(0, len(candidate_keys), chunk_size):
            chunk_keys = candidate_keys[start : start + chunk_size]
            try:
                pipe = self._redis_conn.pipeline(transaction=False)
                for key in chunk_keys:
                    pipe.xrevrange(key, count=1)
                chunk_res = pipe.execute()
                results_chunks.append((chunk_keys, chunk_res, True))
            except Exception as e:
                logger.warning(
                    f"[REDIS_QUEUE] Pipeline execute failed for last entries chunk: "
                    f"offset={start}, size={len(chunk_keys)}, error={e}"
                )
                results_chunks.append((chunk_keys, [], False))

        return results_chunks

    def _parse_last_ms_from_entries(self, entries: list[tuple[str, dict]]) -> int | None:
        """Parse millisecond timestamp from the last entry ID."""
        if not entries:
            return None
        try:
            last_id = entries[0][0]
            return int(str(last_id).split("-")[0])
        except Exception:
            return None

    def _collect_inactive_keys(
        self,
        candidate_keys: list[str],
        last_entries_results: list[list[tuple[str, dict]]],
        inactivity_seconds: float,
        now_sec: float | None = None,
    ) -> list[str]:
        """Collect keys whose last entry time is older than inactivity threshold."""
        keys_to_delete: list[str] = []
        now = time.time() if now_sec is None else now_sec
        for key, entries in zip(candidate_keys, last_entries_results or [], strict=False):
            last_ms = self._parse_last_ms_from_entries(entries)
            if last_ms is None:
                # Empty stream (no entries). Track first-seen time and delete if past threshold
                with self._empty_stream_seen_lock:
                    first_seen = self._empty_stream_seen_times.get(key)
                    if first_seen is None:
                        # Record when we first observed this empty stream
                        self._empty_stream_seen_times[key] = now
                    else:
                        if (now - first_seen) > inactivity_seconds:
                            keys_to_delete.append(key)
                continue
            # Stream has entries; clear any empty-tracking state
            with self._empty_stream_seen_lock:
                if key in self._empty_stream_seen_times:
                    self._empty_stream_seen_times.pop(key, None)
            if (now - (last_ms / 1000.0)) > inactivity_seconds:
                keys_to_delete.append(key)
        return keys_to_delete

    def _filter_active_keys(
        self,
        candidate_keys: list[str],
        last_entries_results: list[list[tuple[str, dict]]],
        recent_seconds: float,
        now_sec: float | None = None,
    ) -> list[str]:
        """Return keys whose last entry time is within the recent window."""
        active: list[str] = []
        now = time.time() if now_sec is None else now_sec
        for key, entries in zip(candidate_keys, last_entries_results or [], strict=False):
            last_ms = self._parse_last_ms_from_entries(entries)
            if last_ms is None:
                continue
            # Stream has entries; clear any empty-tracking state
            with self._empty_stream_seen_lock:
                if key in self._empty_stream_seen_times:
                    self._empty_stream_seen_times.pop(key, None)
            # Active if last message is no older than recent_seconds
            if (now - (last_ms / 1000.0)) <= recent_seconds:
                active.append(key)
        return active

    def _delete_streams(self, keys_to_delete: list[str]) -> int:
        """Delete the given stream keys in batch, return deleted count."""
        if not keys_to_delete:
            return 0
        deleted_count = 0
        try:
            del_pipe = self._redis_conn.pipeline(transaction=False)
            for key in keys_to_delete:
                del_pipe.delete(key)
            del_pipe.execute()
            deleted_count = len(keys_to_delete)
            # Clean up empty-tracking state and seen_streams for deleted keys
            with self._empty_stream_seen_lock:
                for key in keys_to_delete:
                    self._empty_stream_seen_times.pop(key, None)

            with self._stream_keys_lock:
                for key in keys_to_delete:
                    self.seen_streams.discard(key)
        except Exception:
            for key in keys_to_delete:
                try:
                    self._redis_conn.delete(key)
                    deleted_count += 1
                    with self._empty_stream_seen_lock:
                        self._empty_stream_seen_times.pop(key, None)
                    with self._stream_keys_lock:
                        self.seen_streams.discard(key)
                except Exception:
                    pass
        return deleted_count

    def _update_stream_cache_with_log(
        self,
        stream_key_prefix: str,
        candidate_keys: list[str],
        active_stream_keys: list[str],
        deleted_count: int,
        active_threshold_sec: float,
    ) -> None:
        """Update cache and emit an info log summarizing refresh statistics."""
        if stream_key_prefix != self.stream_key_prefix:
            return
        with self._stream_keys_lock:
            self._stream_keys_cache = active_stream_keys
            self._stream_keys_last_refresh = time.time()
            cache_count = len(self._stream_keys_cache)
            logger.info(
                f"Refreshed stream keys cache: {cache_count} active keys, "
                f"{deleted_count} deleted, {len(candidate_keys)} candidates examined."
            )
