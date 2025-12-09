"""
Scheduler Orchestrator for Redis-backed task queues.

This module provides an orchestrator class that works with `SchedulerRedisQueue` to:
- Broker tasks from Redis streams according to per-user priority weights.
- Maintain a cache of fetched messages and assemble balanced batches across
  `(user_id, mem_cube_id, task_label)` groups.

Stream format:
- Keys follow: `{prefix}:{user_id}:{mem_cube_id}:{task_label}`

Default behavior:
- All users have priority 1, so fetch sizes are equal per user.
"""

from __future__ import annotations

from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    DEFAULT_PENDING_CLAIM_MIN_IDLE_MS,
    PREF_ADD_TASK_LABEL,
    QUERY_TASK_LABEL,
    TaskPriorityLevel,
)
from memos.mem_scheduler.webservice_modules.redis_service import RedisSchedulerModule


logger = get_logger(__name__)


class SchedulerOrchestrator(RedisSchedulerModule):
    def __init__(self):
        """
        Args:
            queue: An instance of `SchedulerRedisQueue`.
        """
        # Cache of fetched messages grouped by (user_id, mem_cube_id, task_label)
        self._cache = None
        self.tasks_priorities = {
            ADD_TASK_LABEL: TaskPriorityLevel.LEVEL_1,
            QUERY_TASK_LABEL: TaskPriorityLevel.LEVEL_1,
            ANSWER_TASK_LABEL: TaskPriorityLevel.LEVEL_1,
        }

        # Per-task minimum idle time (ms) before claiming pending messages
        # Default fallback handled in `get_task_idle_min`.
        self.tasks_min_idle_ms = {
            # Preferential add tasks: allow claiming pending sooner (10 minute)
            PREF_ADD_TASK_LABEL: 600_000,
        }

    def get_stream_priorities(self) -> None | dict:
        return None

    def get_task_priority(self, task_label: str):
        return self.tasks_priorities.get(task_label, TaskPriorityLevel.LEVEL_3)

    def get_task_idle_min(self, task_label: str) -> int:
        idle_min = self.tasks_min_idle_ms.get(task_label, DEFAULT_PENDING_CLAIM_MIN_IDLE_MS)
        return idle_min

    def get_stream_quotas(self, stream_keys, consume_batch_size) -> dict:
        stream_priorities = self.get_stream_priorities()
        stream_quotas = {}
        for stream_key in stream_keys:
            if stream_priorities is None:
                # Distribute per-stream evenly
                stream_quotas[stream_key] = consume_batch_size
            else:
                # TODO: not implemented yet
                stream_quotas[stream_key] = consume_batch_size
        return stream_quotas
