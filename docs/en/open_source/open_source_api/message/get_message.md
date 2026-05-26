---
title: Get Messages
desc: Retrieve the raw user/assistant conversation history of a given session, useful for building chat UIs or extracting the original context.
---

::warning
**[Click here to see the API docs directly](/api_docs/message/get_message)**
<br>
<br>

**This document focuses on the functional description of the open-source project; for detailed API fields and limits, please click the link above.**
::

**API Path**: `POST /product/get/message`
**Description**: This endpoint retrieves the raw user/assistant conversation records of a given session. Unlike the "memory" endpoint, which returns processed summaries, this endpoint returns unprocessed raw text, making it the core endpoint for building chat history replay features.

## 1. Memory vs. Message

During development, please distinguish between the following two kinds of data:
* **Get Memory (`/get_memory`)**: Returns **fact and preference summaries** processed by the system (e.g., "the user prefers R for visualization").
* **Get Message (`/get_message`)**: Returns **raw conversation text** (e.g., "I have been learning R recently, can you recommend a visualization package?").

## 2. Key API Parameters
This endpoint supports the following parameters:

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `user_id` | `str` | Yes | - | Unique identifier of the user associated with the messages being retrieved. |
| `conversation_id` | `str` | No | `None` | Unique identifier of the target conversation. |
| `message_limit_number` | `int` | No | `6` | Limits the number of messages returned; recommended maximum is 50. |
| `conversation_limit_number`| `int` | No | `6` | Limits the number of conversation history entries returned. |
| `source` | `str` | No | `None` | Identifies the source channel of the messages. |

## 3. How It Works


1. **Locate the Session**: The system uses the provided `conversation_id` to look up the message records belonging to that user and session in the underlying storage.
2. **Slicing**: Based on `message_limit_number`, the system slices the specified number of messages starting from the most recent ones, ensuring the most recent dialogue is returned.
3. **Security Isolation**: All requests go through the `RequestContextMiddleware`, which strictly validates ownership of `user_id` to prevent unauthorized access.

## 4. Quick Start Example

Use the built-in `MemOSClient` from the open-source version to quickly fetch conversation history:

```python
from memos.api.client import MemOSClient

# Initialize the client
client = MemOSClient(
    api_key="YOUR_LOCAL_API_KEY",
    base_url="http://localhost:8000/product"
)

# Fetch the latest 10 messages from the given conversation
res = client.get_message(
    user_id="memos_user_123",
    conversation_id="conv_r_study_001",
    message_limit_number=10
)

if res and res.code == 200:
    # Iterate through the returned message list
    for msg in res.data:
        print(f"[{msg['role']}]: {msg['content']}")
```

## 5. Use Cases
### 5.1 Loading History in a Chat UI
When the user opens a past conversation, calling this endpoint restores the conversation. It is recommended to combine `message_limit_number` with pagination to improve front-end performance.

### 5.2 Injecting Context into an External Model
If you are using your own LLM logic (rather than the built-in MemOS chat endpoint), you can use this endpoint to obtain the raw conversation history and manually splice it into the model's `messages` array.

### 5.3 Conversation Replay Analysis
You can periodically export raw conversation records to evaluate the quality of AI replies or analyze users' latent intent.
