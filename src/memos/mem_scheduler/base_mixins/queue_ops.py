from __future__ import annotations

import multiprocessing
import time

from collections.abc import Callable
from contextlib import suppress
from datetime import datetime, timezone

from memos.context.context import ContextThread, RequestContext, get_current_context, get_current_trace_id, set_request_context
from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.general_schemas import STARTUP_BY_PROCESS
from memos.mem_scheduler.schemas.task_schemas import TaskPriorityLevel
from memos.mem_scheduler.utils.db_utils import get_utc_now
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube
from memos.mem_scheduler.utils.monitor_event_utils import emit_monitor_event, to_iso


logger = get_logger(__name__)


class BaseSchedulerQueueMixin:
    def submit_messages(self, messages: ScheduleMessageItem | list[ScheduleMessageItem]):
        if isinstance(messages, ScheduleMessageItem):
            messages = [messages]

        if not messages:
            return

        current_trace_id = get_current_trace_id()

        immediate_msgs: list[ScheduleMessageItem] = []
        queued_msgs: list[ScheduleMessageItem] = []

        for msg in messages:
            if current_trace_id:
                msg.trace_id = current_trace_id

            with suppress(Exception):
                self.metrics.task_enqueued(user_id=msg.user_id, task_type=msg.label)

            if getattr(msg, "timestamp", None) is None:
                msg.timestamp = get_utc_now()

            if self.status_tracker:
                try:
                    self.status_tracker.task_submitted(
                        task_id=msg.item_id,
                        user_id=msg.user_id,
                        task_type=msg.label,
                        mem_cube_id=msg.mem_cube_id,
                        business_task_id=msg.task_id,
                    )
                except Exception:
                    logger.warning("status_tracker.task_submitted failed", exc_info=True)

            if self.disabled_handlers and msg.label in self.disabled_handlers:
                logger.info("Skipping disabled handler: %s - %s", msg.label, msg.content)
                continue

            task_priority = self.orchestrator.get_task_priority(task_label=msg.label)
            if task_priority == TaskPriorityLevel.LEVEL_1:
                immediate_msgs.append(msg)
            else:
                queued_msgs.append(msg)

        if immediate_msgs:
            for m in immediate_msgs:
                emit_monitor_event(
                    "enqueue",
                    m,
                    {
                        "enqueue_ts": to_iso(getattr(m, "timestamp", None)),
                        "event_duration_ms": 0,
                        "total_duration_ms": 0,
                    },
                )

            for m in immediate_msgs:
                try:
                    now = time.time()
                    enqueue_ts_obj = getattr(m, "timestamp", None)
                    enqueue_epoch = None
                    if isinstance(enqueue_ts_obj, int | float):
                        enqueue_epoch = float(enqueue_ts_obj)
                    elif hasattr(enqueue_ts_obj, "timestamp"):
                        dt = enqueue_ts_obj
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        enqueue_epoch = dt.timestamp()

                    queue_wait_ms = None
                    if enqueue_epoch is not None:
                        queue_wait_ms = max(0.0, now - enqueue_epoch) * 1000

                    object.__setattr__(m, "_dequeue_ts", now)
                    emit_monitor_event(
                        "dequeue",
                        m,
                        {
                            "enqueue_ts": to_iso(enqueue_ts_obj),
                            "dequeue_ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                            "queue_wait_ms": queue_wait_ms,
                            "event_duration_ms": queue_wait_ms,
                            "total_duration_ms": queue_wait_ms,
                        },
                    )
                    self.metrics.task_dequeued(user_id=m.user_id, task_type=m.label)
                except Exception:
                    logger.debug("Failed to emit dequeue for immediate task", exc_info=True)

            user_cube_groups = group_messages_by_user_and_mem_cube(immediate_msgs)
            for user_id, cube_groups in user_cube_groups.items():
                for mem_cube_id, user_cube_msgs in cube_groups.items():
                    label_groups: dict[str, list[ScheduleMessageItem]] = {}
                    for m in user_cube_msgs:
                        label_groups.setdefault(m.label, []).append(m)

                    for label, msgs_by_label in label_groups.items():
                        handler = self.dispatcher.handlers.get(
                            label, self.dispatcher._default_message_handler
                        )
                        self.dispatcher.execute_task(
                            user_id=user_id,
                            mem_cube_id=mem_cube_id,
                            task_label=label,
                            msgs=msgs_by_label,
                            handler_call_back=handler,
                        )

        if queued_msgs:
            self.memos_message_queue.submit_messages(messages=queued_msgs)

    def _message_consumer(self) -> None:
        while self._running:
            try:
                if self.enable_parallel_dispatch and self.dispatcher:
                    running_tasks = self.dispatcher.get_running_task_count()
                    if running_tasks >= self.dispatcher.max_workers:
                        time.sleep(self._consume_interval)
                        continue

                messages = self.memos_message_queue.get_messages(batch_size=self.consume_batch)

                if messages:
                    now = time.time()
                    for msg in messages:
                        prev_context = get_current_context()
                        try:
                            msg_context = RequestContext(
                                trace_id=msg.trace_id,
                                user_name=msg.user_name,
                            )
                            set_request_context(msg_context)

                            enqueue_ts_obj = getattr(msg, "timestamp", None)
                            enqueue_epoch = None
                            if isinstance(enqueue_ts_obj, int | float):
                                enqueue_epoch = float(enqueue_ts_obj)
                            elif hasattr(enqueue_ts_obj, "timestamp"):
                                dt = enqueue_ts_obj
                                if dt.tzinfo is None:
                                    dt = dt.replace(tzinfo=timezone.utc)
                                enqueue_epoch = dt.timestamp()

                            queue_wait_ms = None
                            if enqueue_epoch is not None:
                                queue_wait_ms = max(0.0, now - enqueue_epoch) * 1000

                            object.__setattr__(msg, "_dequeue_ts", now)
                            emit_monitor_event(
                                "dequeue",
                                msg,
                                {
                                    "enqueue_ts": to_iso(enqueue_ts_obj),
                                    "dequeue_ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                                    "queue_wait_ms": queue_wait_ms,
                                    "event_duration_ms": queue_wait_ms,
                                    "total_duration_ms": queue_wait_ms,
                                },
                            )
                            self.metrics.task_dequeued(user_id=msg.user_id, task_type=msg.label)
                        finally:
                            set_request_context(prev_context)
                    try:
                        with suppress(Exception):
                            if messages:
                                self.dispatcher.on_messages_enqueued(messages)

                        self.dispatcher.dispatch(messages)
                    except Exception as e:
                        logger.error("Error dispatching messages: %s", e)

                time.sleep(self._consume_interval)

            except Exception as e:
                if "No messages available in Redis queue" not in str(e):
                    logger.error("Unexpected error in message consumer: %s", e, exc_info=True)
                time.sleep(self._consume_interval)

    def _monitor_loop(self):
        while self._running:
            try:
                q_sizes = self.memos_message_queue.qsize()

                if not isinstance(q_sizes, dict):
                    continue

                for stream_key, queue_length in q_sizes.items():
                    if stream_key == "total_size":
                        continue

                    parts = stream_key.split(":")
                    if len(parts) >= 3:
                        user_id = parts[-3]
                        self.metrics.update_queue_length(queue_length, user_id)
                    else:
                        if ":" not in stream_key:
                            self.metrics.update_queue_length(queue_length, stream_key)

            except Exception as e:
                logger.error("Error in metrics monitor loop: %s", e, exc_info=True)

            time.sleep(15)

    def start(self) -> None:
        if self.enable_parallel_dispatch:
            logger.info(
                "Initializing dispatcher thread pool with %s workers",
                self.thread_pool_max_workers,
            )

        self.start_consumer()
        self.start_background_monitor()

    def start_background_monitor(self):
        if self._monitor_thread and self._monitor_thread.is_alive():
            return
        self._monitor_thread = ContextThread(
            target=self._monitor_loop, daemon=True, name="SchedulerMetricsMonitor"
        )
        self._monitor_thread.start()
        logger.info("Scheduler metrics monitor thread started.")

    def start_consumer(self) -> None:
        if self._running:
            logger.warning("Memory Scheduler consumer is already running")
            return

        self._running = True

        if self.scheduler_startup_mode == STARTUP_BY_PROCESS:
            self._consumer_process = multiprocessing.Process(
                target=self._message_consumer,
                daemon=True,
                name="MessageConsumerProcess",
            )
            self._consumer_process.start()
            logger.info("Message consumer process started")
        else:
            self._consumer_thread = ContextThread(
                target=self._message_consumer,
                daemon=True,
                name="MessageConsumerThread",
            )
            self._consumer_thread.start()
            logger.info("Message consumer thread started")

    def stop_consumer(self) -> None:
        if not self._running:
            logger.warning("Memory Scheduler consumer is not running")
            return

        self._running = False

        if self.scheduler_startup_mode == STARTUP_BY_PROCESS and self._consumer_process:
            if self._consumer_process.is_alive():
                self._consumer_process.join(timeout=5.0)
                if self._consumer_process.is_alive():
                    logger.warning("Consumer process did not stop gracefully, terminating...")
                    self._consumer_process.terminate()
                    self._consumer_process.join(timeout=2.0)
                    if self._consumer_process.is_alive():
                        logger.error("Consumer process could not be terminated")
                    else:
                        logger.info("Consumer process terminated")
                else:
                    logger.info("Consumer process stopped")
            self._consumer_process = None
        elif self._consumer_thread and self._consumer_thread.is_alive():
            self._consumer_thread.join(timeout=5.0)
            if self._consumer_thread.is_alive():
                logger.warning("Consumer thread did not stop gracefully")
            else:
                logger.info("Consumer thread stopped")
            self._consumer_thread = None

        logger.info("Memory Scheduler consumer stopped")

    def stop(self) -> None:
        if not self._running:
            logger.warning("Memory Scheduler is not running")
            return

        self.stop_consumer()

        if self._monitor_thread:
            self._monitor_thread.join(timeout=2.0)

        if self.dispatcher:
            logger.info("Shutting down dispatcher...")
            self.dispatcher.shutdown()

        if self.dispatcher_monitor:
            logger.info("Shutting down monitor...")
            self.dispatcher_monitor.stop()

    @property
    def handlers(self) -> dict[str, Callable]:
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, returning empty handlers dict")
            return {}

        return self.dispatcher.handlers

    def register_handlers(self, handlers: dict[str, Callable[[list[ScheduleMessageItem]], None]]) -> None:
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, cannot register handlers")
            return

        self.dispatcher.register_handlers(handlers)

    def unregister_handlers(self, labels: list[str]) -> dict[str, bool]:
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, cannot unregister handlers")
            return dict.fromkeys(labels, False)

        return self.dispatcher.unregister_handlers(labels)

    def get_running_tasks(self, filter_func: Callable | None = None) -> dict[str, dict]:
        if not self.dispatcher:
            logger.warning("Dispatcher is not initialized, returning empty tasks dict")
            return {}

        running_tasks = self.dispatcher.get_running_tasks(filter_func=filter_func)

        result = {}
        for task_id, task_item in running_tasks.items():
            result[task_id] = {
                "item_id": task_item.item_id,
                "user_id": task_item.user_id,
                "mem_cube_id": task_item.mem_cube_id,
                "task_info": task_item.task_info,
                "task_name": task_item.task_name,
                "start_time": task_item.start_time,
                "end_time": task_item.end_time,
                "status": task_item.status,
                "result": task_item.result,
                "error_message": task_item.error_message,
                "messages": task_item.messages,
            }

        return result

    def get_tasks_status(self):
        return self.task_schedule_monitor.get_tasks_status()

    def print_tasks_status(self, tasks_status: dict | None = None) -> None:
        self.task_schedule_monitor.print_tasks_status(tasks_status=tasks_status)

    def _gather_queue_stats(self) -> dict:
        memos_message_queue = self.memos_message_queue.memos_message_queue
        stats: dict[str, int | float | str] = {}
        stats["use_redis_queue"] = bool(self.use_redis_queue)
        if not self.use_redis_queue:
            try:
                stats["qsize"] = int(memos_message_queue.qsize())
            except Exception:
                stats["qsize"] = -1
            try:
                stats["unfinished_tasks"] = int(
                    getattr(memos_message_queue, "unfinished_tasks", 0) or 0
                )
            except Exception:
                stats["unfinished_tasks"] = -1
            stats["maxsize"] = int(self.max_internal_message_queue_size)
            try:
                maxsize = int(self.max_internal_message_queue_size) or 1
                qsize = int(stats.get("qsize", 0))
                stats["utilization"] = min(1.0, max(0.0, qsize / maxsize))
            except Exception:
                stats["utilization"] = 0.0
        try:
            d_stats = self.dispatcher.stats()
            stats.update(
                {
                    "running": int(d_stats.get("running", 0)),
                    "inflight": int(d_stats.get("inflight", 0)),
                    "handlers": int(d_stats.get("handlers", 0)),
                }
            )
        except Exception:
            stats.update({"running": 0, "inflight": 0, "handlers": 0})
        return stats
