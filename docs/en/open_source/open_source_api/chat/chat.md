---
title: Chat
desc: A RAG closed-loop interface integrating the full "retrieve, generate, store" pipeline, supporting MemCube-based personalized replies and automatic memory accumulation.
---

:::note
For the complete list of API fields, formats, and other information, see the [Chat API documentation](/api_docs/chat/chat).
:::

**API Paths**:
* **Full response**: `POST /product/chat/complete`
* **Streaming response (SSE)**: `POST /product/chat/stream`

**Description**: This endpoint is the core business orchestration entry point of MemOS. It automatically recalls relevant memories from the specified `readable_cube_ids`, generates a reply based on the current context, and can optionally write the dialogue results back into `writable_cube_ids`, enabling the AI application to evolve on its own.


## 1. Core Architecture: ChatHandler Orchestration Flow

1. **Memory Retrieval**: Based on `readable_cube_ids`, the **SearchHandler** is invoked to extract relevant facts, preferences, and tool context from the isolated Cubes.
2. **Context-Augmented Generation**: The retrieved memory fragments are injected into the prompt, and the specified LLM (via `model_name_or_path`) is invoked to generate a targeted reply.
3. **Automatic Memory Loop (Storage)**: If `add_message_on_answer=true` is set, the system invokes the **AddHandler** to asynchronously store the dialogue into the specified Cubes, without requiring the developer to call the add interface manually.

## 2. Key API Parameters

### 2.1 Identity and Context
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`query`** | `str` | Yes | The user's current question. |
| **`user_id`** | `str` | Yes | Unique user identifier, used for authentication and data isolation. |
| `history` | `list` | No | Short-term conversation history, used to maintain coherence within the current session. |
| `session_id` | `str` | No | Session ID. Acts as a "soft signal" to boost the recall weight of memories related to this session. |

### 2.2 MemCube Read/Write Control
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`readable_cube_ids`** | `list` | - | **Read**: List of memory Cubes allowed for retrieval (can span personal and public libraries). |
| **`writable_cube_ids`** | `list` | - | **Write**: List of target Cubes into which automatically generated memories should be stored after the conversation. |
| **`add_message_on_answer`** | `bool` | `true` | Whether to enable automatic write-back. Recommended to keep enabled in order to keep memories continuously updated. |

### 2.3 Algorithm and Model Configuration
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `mode` | `str` | `fast` | Retrieval mode: `fast`, `fine`, or `mixture`. |
| `model_name_or_path` | `str` | - | The LLM model name or path to use. |
| `system_prompt` | `str` | - | Overrides the default system prompt. |
| `temperature` | `float` | - | Sampling temperature, controlling the creativity of generated text. |
| `threshold` | `float` | `0.5` | Relevance threshold for memory recall; memories scoring below this value are filtered out. |

## 3. How It Works

MemOS offers two response modes to choose from:

### 3.1 Full Response (`/complete`)
* **Characteristics**: Waits for the model to generate the entire content and returns it as a single JSON response.
* **Use cases**: Non-interactive tasks, backend logic processing, or simple applications with low real-time requirements.

### 3.2 Streaming Response (`/stream`)
* **Characteristics**: Uses the **Server-Sent Events (SSE)** protocol to push tokens in real time.
* **Use cases**: Chatbots, AI assistants, and other UI interactions that need an immediate typewriter-style feedback effect.

## 4. Quick Start

It is recommended to use the built-in `MemOSClient` from the open-source version. The following example shows how to ask for advice on learning R while leveraging the memory feature:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Initiate a chat request
res = client.chat(
    user_id="dev_user_01",
    query="根据我之前的偏好，推荐一套 R 语言数据清理方案",
    readable_cube_ids=["private_cube_01", "public_kb_r_lang"], # Read: personal preferences + public library
    writable_cube_ids=["private_cube_01"],                      # Write: store into personal space
    add_message_on_answer=True,                                 # Enable automatic memory write-back
    mode="fine"                                                 # Use fine retrieval mode
)

if res:
    print(f"AI reply: {res.data}")
```


:::note
**Developer tip:**
If you need to debug against the `Playground` environment, please use the dedicated debugging stream endpoint /product/chat/stream/playground.
:::
