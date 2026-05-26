---
title: Get Suggestion Queries
desc: Automatically generate 3 follow-up dialogue suggestions based on the current conversation context or recent memories in a Cube.
---

# Get Suggestion Queries

**API Path**: `POST /product/suggestions`
**Description**: This endpoint powers the "you might want to ask" feature. The system uses an LLM to generate 3 relevant suggested questions based on the provided conversation context or recent memories in the target **MemCube**, helping the user continue the conversation.

## 1. Core Mechanism: Dual-Mode Generation Strategy

**SuggestionHandler** supports two flexible generation modes depending on the input parameters:

* **Context-based suggestions**:
    * **Trigger condition**: The request includes `message` (conversation records).
    * **Logic**: The system analyzes the most recent dialogue and generates 3 follow-up questions closely related to the current topic.
* **Memory-based discovery suggestions**:
    * **Trigger condition**: `message` is not provided.
    * **Logic**: The system retrieves "recent memories" from the memory store identified by `mem_cube_id` and generates inspirational questions related to the user's recent life and work.



## 2. Key API Parameters

The core parameters are defined as follows:

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | - | Unique user identifier. |
| **`mem_cube_id`** | `str` | Yes | - | **Core parameter**: Specifies the memory space the suggestions are generated from. |
| **`language`** | `str` | No | `zh` | Language of the generated suggestions: `zh` (Chinese) or `en` (English). |
| `message` | `list/str`| No | - | Current conversation context. If provided, context-based suggestions are generated. |

## 3. How It Works (SuggestionHandler)

1. **Context Detection**: `SuggestionHandler` first checks the `message` field. If it has a value, it extracts the essence of the dialogue; if empty, it switches to the underlying `MemCube` to fetch recent activity.
2. **Template Matching**: Based on the `language` parameter, the system automatically switches between the built-in Chinese and English prompt templates.
3. **Model Inference**: The LLM reasons over the background information to ensure the 3 generated questions are both logical and inspirational.
4. **Formatted Output**: The suggested questions are returned as an array, allowing the front end to render them directly as clickable buttons.

## 4. Quick Start Example

Use the SDK to obtain Chinese suggestions for the current conversation:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: generate suggestions based on the previous conversation about "R language"
res = client.get_suggestions(
    user_id="dev_user_01",
    mem_cube_id="private_cube_01",
    language="zh",
    message=[
        {"role": "user", "content": "我想学习 R 语言的可视化。"},
        {"role": "assistant", "content": "推荐您学习 ggplot2 包，它是 R 语言可视化的核心工具。"}
    ]
)

if res and res.code == 200:
    # Example output: ["如何安装 ggplot2？", "有哪些经典的 ggplot2 教程？", "R 语言还有哪些可视化包？"]
    print(f"Suggested questions: {res.data}")
```

## 5. Recommended Use Cases
Conversation guidance: after the AI replies to the user, call this endpoint automatically to display suggestion buttons below the reply, guiding the user to dive deeper.

Cold-start activation: when the user enters a new session without speaking yet, use "memory-based mode" to display past topics the user might be interested in, breaking the silence.
