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

These endpoints are served directly by the open-source Server (`server_api`, router prefix `/product`) and can be called with plain HTTP requests. Note that `user_name`, `timeout_seconds`, and `poll_interval` are query parameters, not a request body. The example below performs a blocking wait:

```python
import json

import requests

# Address of your self-hosted MemOS Server (add an Authorization header if auth is enabled)
base_url = "http://localhost:8000"
user_name = "dev_user_01"

# Scenario A: blocking wait, commonly used in Python automation scripts.
print(f"Waiting for user {user_name}'s task queue to drain...")
resp = requests.post(
    f"{base_url}/product/scheduler/wait",
    params={"user_name": user_name, "timeout_seconds": 300, "poll_interval": 2},
    timeout=310,  # HTTP timeout should be larger than timeout_seconds
)
resp.raise_for_status()
result = resp.json()  # {"message": "idle" | "timeout", "data": {...}}
if result["message"] == "idle":
    print("All tasks have completed.")
else:
    print(f"Timed out with {result['data']['running_tasks']} task(s) still running.")

# Scenario B: streaming progress, commonly used by frontend progress bars.
print("Listening to the live task progress stream...")
with requests.get(
    f"{base_url}/product/scheduler/wait/stream",
    params={"user_name": user_name, "timeout_seconds": 300},
    stream=True,
    timeout=310,
) as resp:
    resp.raise_for_status()
    for line in resp.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data:"):
            continue
        event = json.loads(line.removeprefix("data:").strip())
        # Print the number of active tasks in real time.
        print(f"Active tasks: {event['active_tasks']}, status: {event['status']}")
        if event["status"] in ("idle", "timeout"):
            print("Scheduler is idle" if event["status"] == "idle" else "Stream timed out")
            break
```
