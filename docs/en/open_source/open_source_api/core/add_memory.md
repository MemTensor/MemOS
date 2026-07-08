---
title: Add Memory
desc: The core production interface for MemOS. Enables asynchronous memory production for personal memory, knowledge bases, and multi-tenant scenarios through the MemCube isolation mechanism.
---

**Endpoint**: `POST /product/add`
**Description**: This is the primary entry point for storing unstructured data in the system. It supports converting raw data into structured memory fragments via conversation lists, plain text, or metadata. In the open-source version, the system uses **MemCube** to achieve physical isolation and dynamic organization of memories.

## 1. Core Mechanism: MemCube and Isolation

In the open-source architecture, understanding MemCube is essential for effective use of this interface:

* **Isolation Unit**: MemCube is the atomic unit of memory production. Cubes are completely independent of each other — deduplication and conflict resolution only occur within a single Cube.
* **Flexible Mapping**:
    * **Personal Mode**: Pass `user_id` as `writable_cube_ids` to establish a private personal memory store.
    * **Knowledge Base Mode**: Pass the unique identifier (QID) of a knowledge base as `writable_cube_ids` to store content in that knowledge base.
* **Multi-Target Write**: The interface supports writing memories to multiple Cubes simultaneously, enabling cross-domain synchronization.


## 2. Key Parameters

Core parameters are defined as follows:

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | - | Unique user identifier, used for permission validation. |
| **`messages`** | `list/str`| Yes | - | A list of messages or plain text content to be stored. |
| **`writable_cube_ids`** | `list[str]`| Yes | - | **Core parameter**: Specifies the list of target Cube IDs to write to. |
| **`async_mode`** | `str` | No | `async` | Processing mode: `async` (background queue processing) or `sync` (blocks the current request). |
| **`is_feedback`** | `bool` | No | `false` | If `true`, the system automatically routes to the feedback handler to perform memory correction. |
| `session_id` | `str` | No | `default` | Session identifier, used to track conversation context. |
| `custom_tags` | `list[str]`| No | - | Custom tags that can be used as filter conditions in subsequent searches. |
| `info` | `dict` | No | - | Extended metadata. All key-value pairs support subsequent filtered retrieval. |
| `mode` | `str` | No | - | Only takes effect when `async_mode='sync'`. Options: `fast` or `fine`. |

## 3. How It Works (Component & Handler)

When a request reaches the backend, the system dispatches the **AddHandler** to execute the following logic using core components:

1. **Multimodal Parsing**: The `MemReader` component converts `messages` into internal memory objects.
2. **Feedback Routing**: If `is_feedback=True`, the Handler extracts the end of the conversation as feedback and directly corrects existing memories without generating new facts.
3. **Async Dispatch**: In `async` mode, `MemScheduler` pushes the task into the task queue and the interface immediately returns a `task_id`.
4. **Internal Organization**: The algorithm executes organization logic within the target Cube, optimizing memory quality through deduplication and merging.

## 4. Quick Start

The recommended way to interact with this interface is via the `MemOSClient` SDK:

```python
from memos.api.client import MemOSClient

# Initialize the client
client = MemOSClient(api_key="...", base_url="...")

# Scenario 1: Add memory for a personal user
client.add_message(
    user_id="sde_dev_01",
    writable_cube_ids=["user_01_private"],
    messages=[{"role": "user", "content": "I am learning ggplot2 in R."}],
    async_mode="async",
    custom_tags=["Programming", "R"]
)
# Scenario 2: Import content into a knowledge base with feedback enabled
client.add_message(
    user_id="admin_01",
    writable_cube_ids=["kb_finance_2026"],
    messages="The 2026 financial audit process has been updated. Please refer to the attachment.",
    is_feedback=True, # Mark as feedback to correct the old process
    info={"source": "Internal_Portal"}
)
```
