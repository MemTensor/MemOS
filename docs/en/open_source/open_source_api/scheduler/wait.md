---
title: Advanced Task Synchronization
desc: Provides blocking waits and streaming progress observation so asynchronous tasks for a user are completed before follow-up operations run.
---

**API Paths**:
* **Blocking wait**: `POST /product/scheduler/wait`
* **Real-time progress stream (SSE)**: `GET /product/scheduler/wait/stream`

**Description**: Automation scripts, data migrations, and integration tests often need to ensure that all asynchronous memory extraction tasks, such as LLM fact extraction and vector writes, have fully completed. These endpoints let a client hold the request open until the scheduler detects that the target user's queue is empty.

## 1. Core Mechanism: Scheduler Idle Detection

The system uses **SchedulerHandler** to monitor the underlying **MemScheduler** state in real time:

* **Queue checks**: The system checks Redis Stream tasks for the user, including pending and remaining tasks.
* **Idle detection**: A user is considered idle only when queue counts are zero and no worker is currently processing that user's tasks.
* **Timeout protection**: Set `timeout_seconds` to avoid blocking forever. If the timeout is reached before tasks finish, the endpoint returns the current status and stops waiting.

## 2. Key Parameters

Both endpoints share the following query parameters:

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_name`** | `str` | Yes | - | Target user name or ID. |
| `timeout_seconds` | `num` | No | - | Maximum wait time in seconds. The request returns after this limit. |
| `poll_interval` | `num` | No | - | How often the queue state is checked, in seconds. |

## 3. Response Modes

### 3.1 Blocking Mode (`/wait`)

* **Behavior**: Standard HTTP response. The connection stays open until tasks clear or the request times out.
* **Use Cases**: Automation scripts or ensuring data has been written before calling `search`.

### 3.2 Streaming Mode (`/wait/stream`)

* **Behavior**: Uses **Server-Sent Events (SSE)**.
* **Use Cases**: Admin dashboards that display a dynamic progress bar as the queue drains.

## 4. Quick Start

## 4. Quick Start

The following example calls the endpoints directly over HTTP:

```python
import json

import requests

base_url = "http://localhost:8001"  # Replace with your MemOS server address
user_name = "dev_user_01"

# --- Scenario A: synchronous blocking wait (common in Python automation scripts) ---
print(f"Waiting for user {user_name}'s task queue to drain...")
resp = requests.post(
    f"{base_url}/product/scheduler/wait",
    params={
        "user_name": user_name,
        "timeout_seconds": 300,
        "poll_interval": 2,
    },
    timeout=310,  # client timeout should be slightly larger than timeout_seconds
)
resp.raise_for_status()
result = resp.json()
if result["message"] == "idle":
    print(f"✅ All tasks completed in {result['data']['waited_seconds']} seconds.")
else:
    print(f"⚠️ Wait timed out; {result['data']['running_tasks']} tasks still active.")

# --- Scenario B: streaming progress observation (common for frontend progress bars) ---
print("Listening to the real-time task progress stream...")
resp = requests.get(
    f"{base_url}/product/scheduler/wait/stream",
    params={"user_name": user_name, "timeout_seconds": 300},
    stream=True,
    timeout=310,
)
resp.raise_for_status()

for line in resp.iter_lines(decode_unicode=True):
    # SSE frames are formatted as "data: {...}"
    if not line or not line.startswith("data: "):
        continue
    event = json.loads(line[len("data: "):])

    # Print the current number of active tasks in real time
    print(f"Active tasks: {event['active_tasks']}")
    if event["status"] == "idle":
        print("🎉 Scheduler is idle")
        break
    if event["status"] == "timeout":
        print("⚠️ Stream timed out; scheduler still has active tasks")
        break
```