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
# The /scheduler/wait endpoint returns a plain dict:
# {"message": "idle"|"timeout", "data": {"running_tasks": int, "waited_seconds": float, ...}}
if res and res.get("message") == "idle":
    print(f"All tasks completed. Waited {res['data']['waited_seconds']}s.")
else:
    print(f"Timeout. Active tasks: {res['data']['running_tasks']}")

# --- Scenario B: Streaming progress observation (commonly used for frontend progress bars) ---
print("Listening to real-time task progress stream...")
# Note: The SSE endpoint returns a Generator of SSE events in the SDK
progress_stream = client.stream_scheduler_progress(
    user_name=user_name,
    timeout_seconds=300
)

for event in progress_stream:
    # SSE event data contains: user_name, active_tasks, elapsed_seconds, status, timed_out
    print(f"Active tasks: {event['active_tasks']}, elapsed: {event['elapsed_seconds']}s")
    if event['status'] == 'idle':
        print("Scheduler is idle")
        break
```

## 5. cURL Examples

### Synchronous Blocking Wait

```bash
# Wait until scheduler is idle for a user (timeout: 300s, poll: 2s)
curl -X POST "http://localhost:8000/product/scheduler/wait" \
  -H "Authorization: Token YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_name": "dev_user_01", "timeout_seconds": 300, "poll_interval": 2.0}'

# Example response (idle):
# {"message": "idle", "data": {"running_tasks": 0, "waited_seconds": 2.15, "timed_out": false, "user_name": "dev_user_01"}}

# Example response (timeout):
# {"message": "timeout", "data": {"running_tasks": 3, "waited_seconds": 300.0, "timed_out": true, "user_name": "dev_user_01"}}
```
Or with Python `requests`:
```python
import requests
res = requests.post(
    "http://localhost:8000/product/scheduler/wait",
    headers={"Authorization": "Token YOUR_API_KEY", "Content-Type": "application/json"},
    json={"user_name": "dev_user_01", "timeout_seconds": 300, "poll_interval": 2.0},
)
print(res.json())
```

### Real-time Progress Stream (SSE)

```bash
# Stream scheduler progress via SSE
curl -N -X GET "http://localhost:8000/product/scheduler/wait/stream?user_name=dev_user_01&timeout_seconds=300" \
  -H "Authorization: Token YOUR_API_KEY"
```
Or with Python `requests`:
```python
import requests
import json

res = requests.get(
    "http://localhost:8000/product/scheduler/wait/stream",
    params={"user_name": "dev_user_01", "timeout_seconds": 300},
    headers={"Authorization": "Token YOUR_API_KEY"},
    stream=True,
)
for line in res.iter_lines(decode_unicode=True):
    if line and line.startswith("data: "):
        event = json.loads(line[len("data: "):])
        print(f"Status: {event['status']}, Active: {event['active_tasks']}")
        if event["status"] == "idle":
            break
```
