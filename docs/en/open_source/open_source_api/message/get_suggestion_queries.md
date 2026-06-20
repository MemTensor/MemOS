---
title: Get Suggestion Queries
desc: Automatically generate 3 follow-up conversation suggestions based on the current dialogue context or recent memories within a Cube.
---

# Get Suggestion Queries

**API Path**: `POST /product/suggestions`
**Description**: This API implements the "Guess What You Want to Ask" feature. Based on the provided conversation context or recent memories in the target **MemCube**, the system uses a large language model to generate 3 relevant suggested questions, helping users continue the conversation.

## 1. Core Mechanism: Dual-Mode Generation Strategy

**SuggestionHandler** supports two flexible generation modes depending on the input parameters:

* **Context-based Instant Suggestions**:
    * **Trigger**: `message` (conversation records) is provided in the request.
    * **Logic**: The system analyzes the recent conversation content and generates 3 follow-up questions closely related to the current topic.
* **Memory-based Discovery Suggestions**:
    * **Trigger**: No `message` is provided.
    * **Logic**: The system retrieves "recent memories" from the memory space specified by `mem_cube_id` and generates heuristic questions related to the user's recent life and work activities.



## 2. Key API Parameters

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | Yes | - | Unique user identifier. |
| **`mem_cube_id`** | `str` | Yes | - | **Core parameter:** Specifies the memory space on which to base the suggestion generation. |
| **`language`** | `str` | No | `zh` | Language for generated suggestions: `zh` (Chinese) or `en` (English). |
| `message` | `list/str`| No | - | Current conversation context. If provided, context-based suggestions are generated. |

## 3. How It Works (SuggestionHandler)

1. **Context Detection**: `SuggestionHandler` first checks the `message` field. If present, it extracts the conversation essence; if empty, it falls back to the underlying `MemCube` for recent activity.
2. **Template Matching**: The system automatically switches between built-in Chinese and English prompt templates based on the `language` parameter.
3. **Model Inference**: The LLM is called to reason over the background material, ensuring the 3 generated questions are both logical and thought-provoking.
4. **Formatted Output**: Suggested questions are returned as an array for easy frontend rendering as clickable buttons.

## 4. Quick Start

Use the SDK to get Chinese-language suggestions for the current conversation:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Scenario: Generate suggestions based on a recent conversation about "R language"
res = client.get_suggestions(
    user_id="dev_user_01",
    mem_cube_id="private_cube_01",
    language="zh",
    message=[
        {"role": "user", "content": "I want to learn R language visualization."},
        {"role": "assistant", "content": "I recommend learning the ggplot2 package — it's the core tool for R language visualization."}
    ]
)

if res and res.code == 200:
    # Example output: ["How do I install ggplot2?", "What are some classic ggplot2 tutorials?", "What other visualization packages does R have?"]
    print(f"Suggested questions: {res.data}")
```

## 5. Suggested Use Cases
**Conversation Guidance**: After the AI finishes replying to the user, automatically call this API to display suggestion buttons below the reply, guiding the user to explore the topic further.

**Cold Start Activation**: When a user enters a new session and has not yet spoken, use the "memory-based mode" to surface past topics the user may be interested in, breaking the silence.
