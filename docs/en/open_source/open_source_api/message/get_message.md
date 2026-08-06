---
title: Get Messages
desc: Retrieve the raw user-assistant conversation history for a specified session. Used for building chat UIs or extracting original context.
---

::warning
**[Click here for the API Reference](/api_docs/message/get_message)**
<br>
<br>

**This article focuses on functional explanations of the open-source project. For detailed API fields and constraints, please click the link above.**
::

**API Path**: `POST /product/get/message`
**Description**: This API retrieves the raw user-assistant conversation records for a specified session. Unlike the "memory" API which returns summary information, this API returns unprocessed raw text — making it the core interface for building chat history review functionality.

## 1. Memory vs. Message

When developing, please distinguish between these two data types:
* **Get Memory (`/get_memory`)**: Returns system-processed **fact and preference summaries** (e.g., "The user prefers R language for visualization").
* **Get Message (`/get_message`)**: Returns the **raw conversation text** (e.g., "I've been learning R recently, recommend a visualization package").

## 2. Key API Parameters

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `user_id` | `str` | Yes | - | Unique user identifier associated with the messages to retrieve. |
| `conversation_id` | `str` | No | `None` | Unique identifier for the specified conversation. |
| `message_limit_number` | `int` | No | `6` | Limits the number of returned messages. Recommended maximum is 50. |
| `conversation_limit_number`| `int` | No | `6` | Limits the number of returned conversation histories. |
| `source` | `str` | No | `None` | Identifies the source channel of the messages. |

## 3. How It Works

1. **Locate Session**: The system retrieves message records belonging to the user and conversation from the underlying storage based on the provided `conversation_id`.
2. **Slicing**: Based on the `message_limit_number` parameter, the system fetches the specified count in reverse chronological order, ensuring the most recent messages are returned.
3. **Security Isolation**: All requests pass through `RequestContextMiddleware`, which strictly validates `user_id` ownership to prevent unauthorized access.

## 4. Quick Start

Use the built-in `MemOSClient` from the open-source edition to quickly pull conversation history:

```python
from memos.api.client import MemOSClient

# Initialize the client
client = MemOSClient(
    api_key="YOUR_LOCAL_API_KEY",
    base_url="http://localhost:8000/product"
)

# Retrieve the last 10 messages from a specified conversation
res = client.get_message(
    user_id="memos_user_123",
    conversation_id="conv_r_study_001",
    message_limit_number=10
)

if res and res.code == 200:
    # Iterate over the returned message list
    for msg in res.data:
        print(f"[{msg['role']}]: {msg['content']}")
```

## 5. Use Cases
### 5.1 Chat UI History Loading
When a user clicks into a historical conversation, call this API to restore the chat session. We recommend combining it with `message_limit_number` for paginated loading to improve frontend performance.

### 5.2 External Model Context Injection
If you are using custom LLM logic (outside of MemOS's built-in chat API), you can retrieve the raw conversation history through this API and manually append it to your model's `messages` array.

### 5.3 Message Retrospective Analysis
You can periodically export raw conversation records to evaluate AI response quality or analyze users' underlying intentions.
