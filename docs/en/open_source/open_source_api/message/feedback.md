---
title: Add Feedback
desc: Submit user feedback on LLM responses to help MemOS correct, optimize, or delete inaccurate memories in real time.
---


**API Path**: `POST /product/feedback`
**Description**: This API processes user feedback on AI responses or memory content. By analyzing `feedback_content`, the system can automatically locate and modify incorrect facts stored in **MemCube**, or adjust memory weights based on positive/negative user feedback.

## 1. Core Mechanism: Memory Correction Loop

**FeedbackHandler** provides more fine-grained control logic than the standard add API:

* **Precise Correction**: By providing `retrieved_memory_ids`, the system can directly target specific retrieved results for correction, avoiding collateral changes to other memories.
* **Context Analysis**: Combined with `history` (conversation history), the system understands the real intent behind the feedback (e.g., "You got it wrong, my current company is A, not B").
* **Result Echo**: When `corrected_answer=true`, the API attempts to return a corrected response based on the newly updated facts after processing the memory correction.

## 2. Key API Parameters

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | - | Unique user identifier. |
| **`history`** | `list` | Yes | - | Recent conversation history, used to provide context for the feedback. |
| **`feedback_content`** | `str` | Yes | - | **Core:** The user's feedback text content. |
| **`writable_cube_ids`**| `list` | No | - | Target Cube list where memory corrections should be applied. |
| `retrieved_memory_ids` | `list` | No | - | Optional. List of specific memory IDs from the last retrieval that need to be corrected. |
| `async_mode` | `str` | No | `async` | Processing mode: `async` (background processing) or `sync` (real-time processing with wait). |
| `corrected_answer` | `bool` | No | `false` | Whether the system should return a corrected answer after revising the memories. |
| `info` | `dict` | No | - | Additional metadata. |

## 3. How It Works

1. **Conflict Detection**: After receiving feedback, `FeedbackHandler` compares `history` against existing memory facts in `writable_cube_ids`.
2. **Locate & Update**:
    * If `retrieved_memory_ids` is provided, the corresponding nodes are updated directly.
    * If no IDs are provided, the system uses semantic matching to find the most relevant outdated memories and either overwrites or marks them as invalid.
3. **Weight Adjustment**: For ambiguous feedback, the system adjusts the `confidence` or reliability level of specific memory entries.
4. **Async Production**: In `async` mode, the correction logic is executed asynchronously by `MemScheduler`, and the API immediately returns a `task_id`.

## 4. Quick Start

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: Correct the AI's mistaken memory about the user's occupation
res = client.add_feedback(
    user_id="dev_user_01",
    feedback_content="I am no longer on a diet and don't need to control my food intake anymore.",
    history=[
        {"role": "assistant", "content": "You're on a diet — have you been controlling your calorie intake recently?"},
        {"role": "user", "content": "I'm not on a diet anymore..."}
    ],
    writable_cube_ids=["private_cube_01"],
    # Specify the exact mistaken memory ID for precise correction
    retrieved_memory_ids=["mem_id_old_job_123"],
    corrected_answer=True # Ask the AI to respond again based on the updated facts
)

if res and res.code == 200:
    print(f"Correction progress: {res.message}")
    if res.data:
        print(f"Corrected response: {res.data}")
```


## 5. Use Cases
### 5.1 Correcting Incorrect AI Inferences
**Human intervention**: Provide a "correct" button in the admin panel. When an admin finds an incorrectly extracted memory entry, call this API to manually correct it.
### 5.2 Updating Outdated User Preferences
**Real-time user correction**: In the chat UI, if the user says something like "you remembered wrong" or "that's not right", automatically trigger this API with `is_feedback=True` to clean up memories in real time.

::note
If the feedback involves a public knowledge base, make sure the current user has write permission for that Cube.
::
