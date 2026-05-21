---
title: Task Scheduling & Status Monitoring (Scheduler Status)
desc: Monitor the lifecycle of MemOS asynchronous tasks, providing comprehensive observability of task progress, queue backlog, and system load.
---

**Endpoint Path**:
* **System Overview**: `GET /product/scheduler/allstatus`
* **Task Progress Query**: `GET /product/scheduler/status`
* **User Queue Metrics**: `GET /product/scheduler/task_queue_status`

**Description**: This module provides observability into the asynchronous memory production pipeline. Through these endpoints, you can track the completion status of specific tasks in real-time, monitor Redis task queue backlogs, and retrieve the overall scheduler system metrics.

## 1. Core Mechanism: MemScheduler Architecture

In the open-source architecture, **MemScheduler** handles all long-running background tasks (such as LLM memory extraction and vector index construction):

* **State Transitions**: Tasks progress through `waiting`, `in_progress`, `completed`, or `failed` states during their lifecycle.
* **Queue Monitoring**: The system uses Redis Stream for task distribution. Monitoring `pending` (delivered but unacknowledged) and `remaining` (queued) task counts helps assess system processing pressure.
* **Multi-dimensional Observability**: Supports status inspection from three perspectives: single task, single user queue, and full system summary.

## 2. Endpoint Details

### 2.1 Task Progress Query (`/status`)
Retrieve the current execution stage of a specific asynchronous task.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | The unique identifier of the user making the query. |
| `task_id` | `str` | No | Optional. If provided, queries only the status of this specific task. |

**Status Descriptions**:
* `waiting`: Task is queued, awaiting an available Worker.
* `in_progress`: Worker is invoking the LLM for memory extraction or writing to the database.
* `completed`: Memory has been successfully persisted and vector index synchronized.
* `failed`: Task failed.

### 2.2 User Queue Metrics (`/task_queue_status`)
Monitor the task backlog for a specific user in Redis.

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | The user ID whose queue status needs to be checked. |

**Core Metrics**:
* `pending_tasks_count`: Number of tasks delivered to Workers but not yet acknowledged (Ack).
* `remaining_tasks_count`: Total number of tasks still queued and waiting for assignment.
* `stream_keys`: List of matching Redis Stream key names.

### 2.3 System Overview (`/allstatus`)
Retrieve the global running status of the scheduler, typically used for admin dashboard monitoring.

* **Key Return Information**:
    * `scheduler_summary`: Current system load and health status.
    * `all_tasks_summary`: Aggregated statistics of all running and queued tasks.

## 3. How It Works (SchedulerHandler)

When you initiate a status query, the **SchedulerHandler** performs the following:

1. **Cache Lookup**: First, searches the Redis status cache for the real-time progress of the `task_id`.
2. **Queue Confirmation**: If querying queue metrics, the Handler calls Redis statistics commands (such as `XLEN`, `XPENDING`) to analyze the Stream state.
3. **Metrics Aggregation**: For global status requests, the Handler aggregates metrics from all active nodes to generate system-level summary data.

## 4. Quick Start Example

Poll task status using the SDK until completion:

```python
from memos.api.client import MemOSClient
import time

client = MemOSClient(api_key="...", base_url="...")

# 1. System overview: check the health of the entire MemOS system
global_res = client.get_all_scheduler_status()
if global_res:
    print(f"System overview: {global_res.data['scheduler_summary']}")

# 2. Queue metrics monitoring: check task backlog for a specific user
queue_res = client.get_task_queue_status(user_id="dev_user_01")
if queue_res:
    print(f"Remaining tasks: {queue_res.data['remaining_tasks_count']}")
    print(f"Pending unacknowledged tasks: {queue_res.data['pending_tasks_count']}")

# 3. Task progress tracking: poll a specific task until completion
task_id = "task_888999"
while True:
    res = client.get_task_status(user_id="dev_user_01", task_id=task_id)
    if res and res.code == 200:
        current_status = res.data[0]['status']  # data is a list of statuses
        print(f"Task {task_id} current status: {current_status}")

        if current_status in ['completed', 'failed', 'cancelled']:
            break
    time.sleep(2)
```
