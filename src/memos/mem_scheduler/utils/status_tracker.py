# src/memos/mem_scheduler/utils/status_tracker.py
import json

from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from memos.dependency import require_python_package


if TYPE_CHECKING:
    import redis


class TaskStatusTracker:
    @require_python_package(import_name="redis", install_command="pip install redis")
    def __init__(self, redis_client: "redis.Redis | None"):
        self.redis = redis_client

    def _get_key(self, user_id: str) -> str:
        return f"memos:task_meta:{user_id}"

    def _get_task_items_key(self, user_id: str, task_id: str) -> str:
        """Get Redis key for task_id → [item_id] mapping."""
        return f"memos:task_items:{user_id}:{task_id}"

    def task_submitted(
        self,
        task_id: str,
        user_id: str,
        task_type: str,
        mem_cube_id: str,
        business_task_id: str | None = None,
    ):
        """
        Submit a new task for tracking.

        Args:
            task_id: Internal item_id (UUID)
            user_id: User identifier
            task_type: Type of task (label)
            mem_cube_id: Memory cube identifier
            business_task_id: Optional business-level task ID (one task_id can have multiple item_ids)
        """
        if not self.redis:
            return

        key = self._get_key(user_id)
        payload = {
            "status": "waiting",
            "task_type": task_type,
            "mem_cube_id": mem_cube_id,
            "submitted_at": datetime.now(timezone.utc).isoformat(),
        }

        # Add business_task_id to payload if provided
        if business_task_id:
            payload["business_task_id"] = business_task_id
            # Add item_id to the task_id → [item_ids] set
            task_items_key = self._get_task_items_key(user_id, business_task_id)
            self.redis.sadd(task_items_key, task_id)
            self.redis.expire(task_items_key, timedelta(days=7))

        self.redis.hset(key, task_id, json.dumps(payload))
        self.redis.expire(key, timedelta(days=7))

    def task_started(self, task_id: str, user_id: str):
        if not self.redis:
            return

        key = self._get_key(user_id)
        existing_data_json = self.redis.hget(key, task_id)
        if not existing_data_json:
            # 容错处理: 如果任务不存在, 也创建一个
            payload = {
                "status": "in_progress",
                "started_at": datetime.now(timezone.utc).isoformat(),
            }
        else:
            payload = json.loads(existing_data_json)
            payload["status"] = "in_progress"
            payload["started_at"] = datetime.now(timezone.utc).isoformat()
        self.redis.hset(key, task_id, json.dumps(payload))
        self.redis.expire(key, timedelta(days=7))

    def task_completed(self, task_id: str, user_id: str):
        if not self.redis:
            return

        key = self._get_key(user_id)
        existing_data_json = self.redis.hget(key, task_id)
        if not existing_data_json:
            return
        payload = json.loads(existing_data_json)
        payload["status"] = "completed"
        payload["completed_at"] = datetime.now(timezone.utc).isoformat()
        # 设置该任务条目的过期时间, 例如 24 小时
        # 注意: Redis Hash 不能为单个 field 设置 TTL, 这里我们可以 通过后台任务清理或在获取时判断时间戳
        # 简单起见, 我们暂时依赖一个后台清理任务
        self.redis.hset(key, task_id, json.dumps(payload))
        self.redis.expire(key, timedelta(days=7))

    def task_failed(self, task_id: str, user_id: str, error_message: str):
        if not self.redis:
            return

        key = self._get_key(user_id)
        existing_data_json = self.redis.hget(key, task_id)
        if not existing_data_json:
            payload = {
                "status": "failed",
                "error": error_message,
                "failed_at": datetime.now(timezone.utc).isoformat(),
            }
        else:
            payload = json.loads(existing_data_json)
            payload["status"] = "failed"
            payload["error"] = error_message
            payload["failed_at"] = datetime.now(timezone.utc).isoformat()
        self.redis.hset(key, task_id, json.dumps(payload))
        self.redis.expire(key, timedelta(days=7))

    def get_task_status(self, task_id: str, user_id: str) -> dict | None:
        if not self.redis:
            return None

        key = self._get_key(user_id)
        data = self.redis.hget(key, task_id)
        return json.loads(data) if data else None

    def get_all_tasks_for_user(self, user_id: str) -> dict[str, dict]:
        if not self.redis:
            return {}

        key = self._get_key(user_id)
        all_tasks = self.redis.hgetall(key)
        return {tid: json.loads(t_data) for tid, t_data in all_tasks.items()}

    def get_task_status_by_business_id(self, business_task_id: str, user_id: str) -> dict | None:
        """
        Get aggregated status for a business-level task_id.

        Args:
            business_task_id: Business-level task ID
            user_id: User identifier

        Returns:
            Aggregated status dict with status determined by all item statuses:
            - If any item is 'waiting' or 'in_progress' → 'in_progress'
            - If all items are 'completed' → 'completed'
            - If any item is 'failed' → 'failed'
            Returns None if task_id not found.
        """
        if not self.redis:
            return None

        # Get all item_ids for this task_id
        task_items_key = self._get_task_items_key(user_id, business_task_id)
        item_ids = self.redis.smembers(task_items_key)

        if not item_ids:
            return None

        # Get statuses for all items
        key = self._get_key(user_id)
        item_statuses = []
        errors = []
        for item_id in item_ids:
            item_data_json = self.redis.hget(key, item_id)
            if item_data_json:
                item_data = json.loads(item_data_json)
                item_statuses.append(item_data["status"])
                if item_data.get("status") == "failed" and "error" in item_data:
                    errors.append(item_data["error"])

        if not item_statuses:
            return None

        # Aggregate status
        if "failed" in item_statuses:
            aggregated_status = "failed"
        elif "in_progress" in item_statuses or "waiting" in item_statuses:
            aggregated_status = "in_progress"
        elif all(s == "completed" for s in item_statuses):
            aggregated_status = "completed"
        else:
            # Fallback
            aggregated_status = "unknown"

        return {
            "status": aggregated_status,
            "business_task_id": business_task_id,
            "item_count": len(item_ids),
            "item_statuses": item_statuses,
            "errors": errors,
        }

    def get_all_tasks_global(self) -> dict[str, dict[str, dict]]:
        """
        Retrieve all tasks for all users from Redis.

        Returns:
            dict: {user_id: {task_id: task_data, ...}, ...}
        """
        if not self.redis:
            return {}

        all_users_tasks = {}
        cursor: int | str = 0
        while True:
            cursor, keys = self.redis.scan(cursor=cursor, match="memos:task_meta:*", count=100)
            for key in keys:
                # key format: memos:task_meta:{user_id}
                parts = key.split(":")
                if len(parts) < 3:
                    continue
                user_id = parts[2]

                tasks = self.redis.hgetall(key)
                if tasks:
                    user_tasks = {tid: json.loads(t_data) for tid, t_data in tasks.items()}
                    all_users_tasks[user_id] = user_tasks

            if cursor == 0 or cursor == "0":
                break

        return all_users_tasks
