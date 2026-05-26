---
title: Add Feedback
desc: Submit user feedback on LLM replies to help MemOS correct, optimize, or delete inaccurate memories in real time.
---


**API Path**: `POST /product/feedback`
**Description**: This endpoint processes user feedback on AI replies or memory content. By analyzing `feedback_content`, the system can automatically locate and modify incorrect facts stored in the **MemCube**, or adjust memory weights based on the user's positive or negative feedback.

## 1. Core Mechanism: Memory Correction Loop

**FeedbackHandler** provides more fine-grained control logic than a regular add interface:

* **Precise Correction**: By providing `retrieved_memory_ids`, the system can target specific retrieval results for correction, avoiding collateral damage to other memories.
* **Contextual Analysis**: Combined with `history` (conversation history), the system can understand the real intent behind the feedback (e.g. "you got it wrong, my current company is A, not B").
* **Result Echo**: When `corrected_answer=true` is enabled, the endpoint will attempt to return a corrected answer generated from the new facts after applying the memory correction.

## 2. Key API Parameters
The core parameters of this endpoint are defined as follows:

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | - | Unique user identifier. |
| **`history`** | `list` | Yes | - | Recent conversation history, used to provide context for the feedback. |
| **`feedback_content`** | `str` | Yes | - | **Core**: The text content of the user's feedback. |
| **`writable_cube_ids`**| `list` | No | - | List of target Cubes on which memory corrections should be applied. |
| `retrieved_memory_ids` | `list` | No | - | Optional. The list of specific memory IDs (from the previous retrieval) that need to be corrected. |
| `async_mode` | `str` | No | `async` | Processing mode: `async` (background processing) or `sync` (real-time processing with wait). |
| `corrected_answer` | `bool` | No | `false` | Whether the system should return a corrected reply after fixing memories. |
| `info` | `dict` | No | - | Additional metadata. |

## 3. How It Works

1. **Conflict Detection**: After receiving the feedback, `FeedbackHandler` compares `history` against the existing memory facts in `writable_cube_ids`.
2. **Locate and Update**:
    * If `retrieved_memory_ids` is provided, the corresponding nodes are updated directly.
    * If no IDs are provided, the system uses semantic matching to find the most relevant outdated memories and either overwrites them or marks them as invalid.
3. **Weight Adjustment**: For ambiguous feedback, the system adjusts the `confidence` or trust level of specific memory entries.
4. **Asynchronous Production**: In `async` mode, the correction logic is executed asynchronously by `MemScheduler`, and the endpoint returns a `task_id` immediately.

## 4. Quick Start Example


```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: correct an AI's wrong memory about the user's occupation
res = client.add_feedback(
    user_id="dev_user_01",
    feedback_content="我不再减肥了，现在不需要控制饮食。",
    history=[
        {"role": "assistant", "content": "您正在减肥中，近期是否控制了摄入食物的热量？"},
        {"role": "user", "content": "我不再减肥了..."}
    ],
    writable_cube_ids=["private_cube_01"],
    # Specify the exact erroneous memory ID for a precision strike
    retrieved_memory_ids=["mem_id_old_job_123"],
    corrected_answer=True # Ask the AI to reply again based on the new facts
)

if res and res.code == 200:
    print(f"Correction progress: {res.message}")
    if res.data:
        print(f"Corrected reply: {res.data}")
```


## 5. Use Cases
### 5.1 Correcting Wrong AI Inferences
Manual intervention: provide a "correct" button in the admin console so administrators can call this endpoint to manually fix incorrect memory entries extracted by the AI.
### 5.2 Updating Outdated User Preferences
Real-time correction by the user: if the user says something like "you got it wrong" or "that's not right" in the chat UI, this endpoint can be triggered automatically, using `is_feedback=True` to perform real-time memory cleanup.

::note
If the feedback involves a public knowledge base, make sure the current user has write permission for that Cube.
::
