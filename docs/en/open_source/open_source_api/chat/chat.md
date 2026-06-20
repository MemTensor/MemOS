---
title: Chat
desc: An integrated RAG closed-loop API covering retrieval, generation, and storage. Supports MemCube-based personalized responses and automatic memory persistence.
---

:::note
For a complete list of API fields, formats, and other details, see the [Chat API Reference](/api_docs/chat/chat).
:::

**API Paths**:
* **Full Response**: `POST /product/chat/complete`
* **Streaming Response (SSE)**: `POST /product/chat/stream`

**Description**: This API is the core business orchestration entry point of MemOS. It automatically retrieves relevant memories from the specified `readable_cube_ids`, generates a response based on the current context, and optionally writes the conversation result back to `writable_cube_ids`, enabling self-evolution of AI applications.


## 1. Core Architecture: ChatHandler Orchestration Flow

1. **Memory Retrieval**: Calls **SearchHandler** against `readable_cube_ids` to extract relevant facts, preferences, and tool context from isolated Cubes.
2. **Context-Enhanced Generation**: Injects the retrieved memory fragments into the prompt and calls the specified LLM (via `model_name_or_path`) to generate a targeted response.
3. **Automatic Memory Loop (Storage)**: When `add_message_on_answer=true`, the system asynchronously calls **AddHandler** to store this conversation in the specified Cubes — no manual add calls required.

## 2. Key API Parameters

### 2.1 Identity & Context
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| **`query`** | `str` | Yes | The user's current question or input. |
| **`user_id`** | `str` | Yes | Unique user identifier, used for authentication and data isolation. |
| `history` | `list` | No | Short-term conversation history to maintain coherence within the current session. |
| `session_id` | `str` | No | Session ID. Acts as a "soft signal" to boost recall weight of related memories within this session. |

### 2.2 MemCube Read/Write Control
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`readable_cube_ids`** | `list` | - | **Read:** List of memory Cubes allowed for retrieval (can span personal and public libraries). |
| **`writable_cube_ids`** | `list` | - | **Write:** Target Cube list where auto-generated memories should be stored after the conversation. |
| **`add_message_on_answer`** | `bool` | `true` | Whether to enable automatic write-back. Recommended to keep memory continuously updated. |

### 2.3 Algorithm & Model Configuration
| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `mode` | `str` | `fast` | Retrieval mode: `fast`, `fine`, or `mixture`. |
| `model_name_or_path` | `str` | - | Specifies the LLM model name or path to use. |
| `system_prompt` | `str` | - | Overrides the default system prompt. |
| `temperature` | `float` | - | Sampling temperature, controlling the creativity of generated text. |
| `threshold` | `float` | `0.5` | Relevance threshold for memory recall. Memories scoring below this value are discarded. |

## 3. How It Works

MemOS provides two response modes to choose from:

### 3.1 Full Response (`/complete`)
* **Behavior**: Waits for the model to generate the full output, then returns it as a single JSON response.
* **Use Cases**: Non-interactive tasks, backend logic processing, or simple applications with low real-time requirements.

### 3.2 Streaming Response (`/stream`)
* **Behavior**: Uses the **Server-Sent Events (SSE)** protocol to push tokens in real time.
* **Use Cases**: Chatbots, intelligent assistants, and other UI interactions that require a typewriter-style streaming effect.

## 4. Quick Start

We recommend using the built-in `MemOSClient` from the open-source edition. The following example shows how to ask for R language learning advice while leveraging memory:

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# Initiate a chat request
res = client.chat(
    user_id="dev_user_01",
    query="Based on my previous preferences, recommend an R language data cleaning workflow",
    readable_cube_ids=["private_cube_01", "public_kb_r_lang"], # Read: personal preferences + public knowledge base
    writable_cube_ids=["private_cube_01"],                      # Write: persist to personal space
    add_message_on_answer=True,                                 # Enable automatic memory write-back
    mode="fine"                                                 # Use fine-grained retrieval mode
)

if res:
    print(f"AI Response: {res.data}")
```


:::note
**Developer Tip:**
To debug in the `Playground` environment, use the dedicated debug streaming endpoint /product/chat/stream/playground.
:::
