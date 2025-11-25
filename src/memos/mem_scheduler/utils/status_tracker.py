# src/memos/mem_scheduler/utils/status_tracker.py
import json
from datetime import datetime, timezone

from memos.dependency import require_python_package


class TaskStatusTracker:
    @require_python_package(import_name="redis", install_command="pip install redis")
    def __init__(self, redis_client: "redis.Redis"):
        self.redis = redis_client

    def _get_key(self, user_id: str) -> str:
        return f"memos:task_meta:{user_id}"

    def task_submitted(self, task_id: str, user_id: str, task_type: str, mem_cube_id: str):
        key = self._get_key(user_id)
        payload = {
            "status": "waiting",
            "task_type": task_type,
            "mem_cube_id": mem_cube_id,
            "submitted_at": datetime.now(timezone.utc).isoformat(),
        }
        self.redis.hset(key, task_id, json.dumps(payload))

    def task_started(self, task_id: str, user_id: str):
        key = self._get_key(user_id)
        existing_data_json = self.redis.hget(key, task_id)
        if not existing_data_json:
            # 容错处理：如果任务不存在，也创建一个
            payload = {"status": "in_progress", "started_at": datetime.now(timezone.utc).isoformat()}
        else:
            payload = json.loads(existing_data_json)
            payload["status"] = "in_progress"
            payload["started_at"] = datetime.now(timezone.utc).isoformat()
        self.redis.hset(key, task_id, json.dumps(payload))

    def task_completed(self, task_id: str, user_id: str):
        key = self._get_key(user_id)
        existing_data_json = self.redis.hget(key, task_id)
        if not existing_data_json: return
        payload = json.loads(existing_data_json)
        payload["status"] = "completed"
        payload["completed_at"] = datetime.now(timezone.utc).isoformat()
        # 设置该任务条目的过期时间，例如 24 小时
        # 注意：Redis Hash 不能为单个 field 设置 TTL，这里我们可以 通过后台任务清理或在获取时判断时间戳
        # 简单起见，我们暂时依赖一个后台清理任务
        self.redis.hset(key, task_id, json.dumps(payload))

    def task_failed(self, task_id: str, user_id: str, error_message: str):
        key = self._get_key(user_id)
        existing_data_json = self.redis.hget(key, task_id)
        if not existing_data_json:
            payload = {"status": "failed", "error": error_message, "failed_at": datetime.now(timezone.utc).isoformat()}
        else:
            payload = json.loads(existing_data_json)
            payload["status"] = "failed"
            payload["error"] = error_message
            payload["failed_at"] = datetime.now(timezone.utc).isoformat()
        self.redis.hset(key, task_id, json.dumps(payload))

    def get_task_status(self, task_id: str, user_id: str) -> dict | None:
        key = self._get_key(user_id)
        data = self.redis.hget(key, task_id)
        return json.loads(data) if data else None

    def get_all_tasks_for_user(self, user_id: str) -> dict[str, dict]:
        key = self._get_key(user_id)
        all_tasks = self.redis.hgetall(key)
        return {tid: json.loads(t_data) for tid, t_data in all_tasks.items()}
