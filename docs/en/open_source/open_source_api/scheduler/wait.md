---
title: Advanced Task Synchronization
desc: Provides blocking wait and streaming progress observation capabilities, ensuring that all asynchronous tasks for a specified user are fully processed before executing subsequent operations.
---

**Endpoint Path**:
* **Synchronous Blocking Wait**: `POST /product/scheduler/wait`
* **Real-time Progress Stream (SSE)**: `GET /product/scheduler/wait/stream`

**Description**: In automation scripts, data migration, or integration testing scenarios, it is often necessary to ensure that all asynchronous memory extraction tasks (such as LLM fact extraction and vector embedding) have fully completed. This module allows the client to "suspend" the request until the scheduler detects that the target user's task queue is empty.

## 1. Core Mechanism: Scheduler Idle Detection

The system monitors the underlying **MemScheduler** in real-time via the **SchedulerHandler**:

* **Queue Check**: The system checks the Redis Stream for pending and remaining tasks belonging to the user.
* **Idle Determination**: The scheduler is considered idle for that user only when both the queue count is zero and no Worker is currently executing tasks for that user.
* **Timeout Protection**: To prevent indefinite blocking, the endpoint supports a `timeout_seconds` parameter. If the timeout is reached before tasks complete, the endpoint returns the current status and stops waiting.

## 2. Key Parameters

Both endpoints share the following query parameters:

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_name`** | `str` | Yes | - | The target user's name or ID. |
| `timeout_seconds` | `num` | No | - | Maximum wait time (in seconds). The request will auto-return after this duration. |
| `poll_interval` | `num` | No | - | Frequency of internal queue status checks (in seconds). |

## 3. Response Mode Selection

### 3.1 Synchronous Blocking Mode (`/wait`)
* **Characteristics**: Standard HTTP response. The connection remains open until tasks are cleared or a timeout occurs.
* **Use Cases**: Writing automated test scripts or ensuring data is persisted before executing a `search`.

### 3.2 Real-time Streaming Mode (`/wait/stream`)
* **Characteristics**: Based on **Server-Sent Events (SSE)** technology.
* **Use Cases**: Displaying dynamic progress bars in admin dashboards, showing the task queue draining in real-time.

## 4. Quick Start Example

Blocking wait using the open-source SDK:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")
user_name = "dev_user_01"

# --- Scenario A: Synchronous blocking wait (commonly used in Python automation scripts) ---
print(f"Waiting for user {user_name}'s task queue to drain...")
res = client.wait_until_idle(
    user_name=user_name,
    timeout_seconds=300,
    poll_interval=2
)
if res and res.code == 200:
    print("✅ All tasks completed.")

# --- Scenario B: Streaming progress observation (commonly used for frontend progress bars) ---
print("Listening to real-time task progress stream...")
# Note: The SSE endpoint typically returns a Generator in the SDK
progress_stream = client.stream_scheduler_progress(
    user_name=user_name,
    timeout_seconds=300
)

for event in progress_stream:
    # Print the remaining task count in real-time
    print(f"Current queued tasks: {event['remaining_tasks_count']}")
    if event['status'] == 'idle':
        print("🎉 Scheduler is idle")
        break
```
