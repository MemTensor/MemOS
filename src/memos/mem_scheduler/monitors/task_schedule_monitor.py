from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.task_schedule_modules.local_queue import SchedulerLocalQueue
from memos.mem_scheduler.task_schedule_modules.redis_queue import SchedulerRedisQueue


logger = get_logger(__name__)


class TaskScheduleMonitor:
    """
    Monitor for task scheduling queue status.

    Initialize with the underlying `memos_message_queue` implementation
    (either SchedulerRedisQueue or SchedulerLocalQueue) and optionally a
    dispatcher for local running task counts.
    """

    def __init__(
        self,
        memos_message_queue: SchedulerRedisQueue | SchedulerLocalQueue,
        dispatcher: object | None = None,
        get_status_parallel: bool = False,
    ) -> None:
        self.queue = memos_message_queue
        self.dispatcher = dispatcher
        self.get_status_parallel = get_status_parallel

    @staticmethod
    def init_task_status() -> dict:
        return {"running": 0, "remaining": 0, "pending": 0}

    def get_tasks_status(self) -> dict:
        if isinstance(self.queue, SchedulerRedisQueue):
            return self._get_redis_tasks_status()
        elif isinstance(self.queue, SchedulerLocalQueue):
            return self._get_local_tasks_status()
        else:
            logger.error(
                f"Unsupported queue type for TaskScheduleMonitor: {type(self.queue).__name__}"
            )
            raise NotImplementedError()

    def print_tasks_status(self, tasks_status: dict | None = None) -> None:
        """
        Nicely print task queue status grouped by "user_id:mem_cube_id".

        For Redis queues, stream keys follow the pattern
        "{prefix}:{user_id}:{mem_cube_id}:{task_label}" — group by user/mem
        and show per-task_label counts. For local queues, only totals are
        available, so print aggregate metrics.
        """
        try:
            status = tasks_status if isinstance(tasks_status, dict) else self.get_tasks_status()
        except Exception as e:
            logger.warning(f"Failed to get tasks status: {e}")
            return

        if not isinstance(status, dict) or not status:
            print("[Tasks] No status available.")
            return

        total_running = int(status.get("running", 0) or 0)
        total_remaining = int(status.get("remaining", 0) or 0)

        header = f"Task Queue Status | running={total_running}, remaining={total_remaining}"
        print(header)

        if isinstance(self.queue, SchedulerRedisQueue):
            # Build grouping: {"user_id:mem_cube_id": {task_label: {counts}}}
            try:
                from collections import defaultdict
            except Exception:
                defaultdict = None

            group_stats = (
                defaultdict(lambda: defaultdict(lambda: {"running": 0, "remaining": 0}))
                if defaultdict is not None
                else {}
            )

            # Keys that look like stream entries (exclude the totals keys)
            stream_keys = [
                k for k in status if isinstance(k, str) and k not in ("running", "remaining")
            ]

            for stream_key in stream_keys:
                stream_stat = status.get(stream_key, {})
                if not isinstance(stream_stat, dict):
                    continue
                parts = stream_key.split(":")
                # Safely parse from the right to avoid prefix colons
                if len(parts) < 3:
                    # Not enough parts to form user:mem:label — skip
                    continue
                task_label = parts[-1]
                mem_cube_id = parts[-2]
                user_id = parts[-3]
                group_key = f"{user_id}:{mem_cube_id}"

                try:
                    group_stats[group_key][task_label]["running"] += int(
                        stream_stat.get("running", 0) or 0
                    )
                    group_stats[group_key][task_label]["remaining"] += int(
                        stream_stat.get("remaining", 0) or 0
                    )
                except Exception:
                    # Keep printing robust in face of bad data
                    pass

            if not group_stats:
                print("[Tasks] No per-stream details found.")
                return

            # Pretty print per group
            for group_key in sorted(group_stats.keys()):
                print("")
                print(f"[{group_key}]")

                labels = sorted(group_stats[group_key].keys())
                label_width = max(10, max((len(label) for label in labels), default=10))
                # Table header
                header_line = f"{'Task Label'.ljust(label_width)}  {'Running':>7}  {'Remaining':>9}"
                sep_line = f"{'-' * label_width}  {'-' * 7}  {'-' * 9}"
                print(header_line)
                print(sep_line)

                for label in labels:
                    counts = group_stats[group_key][label]
                    line = (
                        f"{label.ljust(label_width)}  "
                        f"{int(counts.get('running', 0)):>7}  "
                        f"{int(counts.get('remaining', 0)):>9}  "
                    )
                    print(line)

        elif isinstance(self.queue, SchedulerLocalQueue):
            # Local queue: only aggregate totals available; print them clearly
            print("")
            print("[Local Queue Totals]")
            label_width = 12
            header_line = f"{'Metric'.ljust(label_width)}  {'Value':>7}"
            sep_line = f"{'-' * label_width}  {'-' * 7}"
            print(header_line)
            print(sep_line)
            print(f"{'Running'.ljust(label_width)}  {total_running:>7}")
            print(f"{'Remaining'.ljust(label_width)}  {total_remaining:>7}")

    def _get_local_tasks_status(self) -> dict:
        task_status = self.init_task_status()

        try:
            # remaining is the sum of per-stream qsize
            qsize_map = self.queue.qsize()
            remaining_total = sum(v for k, v in qsize_map.items() if isinstance(v, int))
            task_status["remaining"] = remaining_total
            task_status["pending"] = remaining_total
            # running from dispatcher if available
            if self.dispatcher and hasattr(self.dispatcher, "get_running_task_count"):
                task_status["running"] = int(self.dispatcher.get_running_task_count())
        except Exception as e:
            logger.warning(f"Failed to collect local queue status: {e}")
        return task_status

    def _get_redis_tasks_status(self) -> dict:
        task_status = self.init_task_status()

        stream_keys = self.queue.get_stream_keys(stream_key_prefix=self.queue.stream_key_prefix)

        # Parallel path: use asyncio.to_thread for blocking redis calls
        if self.get_status_parallel:
            try:
                import asyncio

                async def _collect_async() -> dict:
                    # Collect xlen and group info in parallel for each stream
                    xlen_tasks = [
                        asyncio.to_thread(self.queue.redis.xlen, stream_key)
                        for stream_key in stream_keys
                    ]
                    groups_tasks = [
                        asyncio.to_thread(self.queue.redis.xinfo_groups, stream_key)
                        for stream_key in stream_keys
                    ]
                    xlen_results = await asyncio.gather(*xlen_tasks, return_exceptions=True)
                    groups_results = await asyncio.gather(*groups_tasks, return_exceptions=True)

                    local = self.init_task_status()
                    for idx, stream_key in enumerate(stream_keys):
                        local[stream_key] = self.init_task_status()
                        groups_info = groups_results[idx] if idx < len(groups_results) else None
                        xlen_val = xlen_results[idx] if idx < len(xlen_results) else 0
                        if isinstance(xlen_val, Exception):
                            xlen_val = 0
                        if isinstance(groups_info, Exception):
                            continue
                        pending = 0
                        if groups_info:
                            for group in groups_info:
                                if group.get("name") == self.queue.consumer_group:
                                    pending = int(group.get("pending", 0))
                                    break
                        total_messages = max(0, int(xlen_val or 0))
                        remaining = max(0, total_messages - pending)
                        # running = in-progress (delivered, not yet acked)
                        local[stream_key]["running"] += pending
                        # pending = not yet delivered (remaining)
                        local[stream_key]["pending"] += remaining
                        local[stream_key]["remaining"] += remaining
                        local["running"] += pending
                        local["pending"] += remaining
                        local["remaining"] += remaining
                    return local

                try:
                    asyncio.get_running_loop()
                    loop_running = True
                except RuntimeError:
                    loop_running = False

                if not loop_running:
                    return asyncio.run(_collect_async())
            except Exception as e:
                logger.debug(f"Parallel status collection failed, fallback to sequential: {e}")

        # Sequential fallback
        for stream_key in stream_keys:
            task_status[stream_key] = self.init_task_status()
            try:
                groups_info = self.queue.redis.xinfo_groups(stream_key)
            except Exception:
                groups_info = None
            try:
                xlen_val = int(self.queue.redis.xlen(stream_key))
            except Exception:
                xlen_val = 0
            if groups_info:
                for group in groups_info:
                    if group.get("name") == self.queue.consumer_group:
                        pending = int(group.get("pending", 0))
                        remaining = max(0, xlen_val - pending)
                        # running = in-progress (delivered, not yet acked)
                        task_status[stream_key]["running"] += pending
                        # pending = not yet delivered (remaining)
                        task_status[stream_key]["pending"] += remaining
                        task_status[stream_key]["remaining"] += remaining
                        task_status["running"] += pending
                        task_status["pending"] += remaining
                        task_status["remaining"] += remaining
                        break

        return task_status
