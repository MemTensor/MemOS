---
title: Scheduler Status
desc: Monitor the lifecycle of MemOS asynchronous tasks, including task progress, queue backlog, and system load.
---

**API Paths**:
* **System overview**: `GET /product/scheduler/allstatus`
* **Task status query**: `GET /product/scheduler/status`
* **User queue metrics**: `GET /product/scheduler/task_queue_status`

**Description**: These endpoints provide observability for the asynchronous memory-production pipeline. You can track a specific task, monitor Redis queue backlog, and inspect global scheduler metrics.

## 1. Core Mechanism: MemScheduler

In the open-source architecture, **MemScheduler** handles time-consuming background work such as LLM memory extraction and vector index construction:

* **Status transitions**: A task moves through states such as `waiting`, `in_progress`, `completed`, or `failed`.
* **Queue monitoring**: Task distribution is based on Redis Stream. Monitoring `pending` and `remaining` counts helps estimate processing pressure.
* **Multilevel observability**: Inspect status from three perspectives: a single task, a single user's queue, or a system-wide summary.

## 2. Endpoint Details

### 2.1 Task Status Query (`/status`)

Use this endpoint to track the current execution stage of a specific asynchronous task.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | Unique identifier of the user whose task status is being queried. |
| `task_id` | `str` | No | Optional. If provided, only this task is queried. |

**Status values**:
* `waiting`: The task has entered the queue and is waiting for an available worker.
* `in_progress`: A worker is extracting memory with an LLM or writing to storage.
* `completed`: Memory has been persisted and vector indexes have been synchronized.
* `failed`: The task failed.

### 2.2 User Queue Metrics (`/task_queue_status`)

Use this endpoint to monitor the Redis task backlog for a specific user.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | User ID whose queue status should be queried. |

**Core metrics**:
* `pending_tasks_count`: Number of tasks delivered to workers but not yet acknowledged.
* `remaining_tasks_count`: Number of tasks still queued and waiting for assignment.
* `stream_keys`: Redis Stream keys matched by the query.

### 2.3 System Overview (`/allstatus`)

Use this endpoint to retrieve global scheduler health, typically for an admin dashboard.

* **Core response fields**:
  * `scheduler_summary`: Current scheduler load and health.
  * `all_tasks_summary`: Aggregated statistics for running and queued tasks.

## 3. How It Works (SchedulerHandler)

When you send a status request, **SchedulerHandler** performs the following operations:

1. **Cache lookup**: Reads the latest progress for `task_id` from Redis status cache.
2. **Queue inspection**: For queue metrics, calls Redis commands such as `XLEN` and `XPENDING` to analyze Stream state.
3. **Metric aggregation**: For global status, aggregates metrics from all active nodes into a system-level summary.

## 4. Quick Start

The following example calls the endpoints directly over HTTP and polls a task until it finishes:

```python
import time

import requests

base_url = "http://localhost:8001"  # Replace with your MemOS server address

# 1. System-level overview: check the overall health of the MemOS system
resp = requests.get(f"{base_url}/product/scheduler/allstatus", timeout=10)
resp.raise_for_status()
print(f"System summary: {resp.json()['data']['scheduler_summary']}")

# 2. Queue metrics: check the task backlog of a specific user
resp = requests.get(
    f"{base_url}/product/scheduler/task_queue_status",
    params={"user_id": "dev_user_01"},
    timeout=10,
)
resp.raise_for_status()
queue_data = resp.json()["data"]
print(f"Enqueued tasks: {queue_data['remaining_tasks_count']}")
print(f"Delivered but unacknowledged tasks: {queue_data['pending_tasks_count']}")

# 3. Task progress tracking: poll a specific task until it reaches a terminal state
task_id = "task_888999"
while True:
    resp = requests.get(
        f"{base_url}/product/scheduler/status",
        params={"user_id": "dev_user_01", "task_id": task_id},
        timeout=10,
    )
    resp.raise_for_status()
    items = resp.json()["data"]  # data is a list of status items
    if items:
        current_status = items[0]["status"]
        print(f"Task {task_id} current status: {current_status}")

        if current_status in ["completed", "failed", "cancelled"]:
            break
    time.sleep(2)
```