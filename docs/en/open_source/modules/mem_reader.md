---
title: "MemReader"
desc: MemReader is your "memory translator". It translates messy user inputs (chat, documents, images) into structured memory fragments the system can understand.
---

## 1. Overview

When building AI applications, we often run into this problem: users send all kinds of things—casual chat messages, PDF documents, and images. **MemReader** turns these raw inputs (Raw Data) into standard memory blocks (Memory Items) with embeddings and metadata by "chewing" and "digesting" them.

In short, it does three things:
1.  **Normalization**: Whether you send a string or JSON, it first converts everything into a standard format.
2.  **Chunking**: It splits long conversations or documents into appropriately sized chunks for downstream processing.
3.  **Extraction**: It calls an LLM to extract unstructured information into structured knowledge points (Fine mode), or directly generates snapshots (Fast mode).

---

## 2. Core Modes

MemReader provides two modes, corresponding to the needs for "speed" and "accuracy":

### ⚡ Fast Mode (speed first)
*   **Characteristics**: **Does not call an LLM**, only performs chunking and embeddings.
*   **Use cases**:
    *   Users are sending messages quickly and the system needs millisecond-level responses.
    *   You only need to keep "snapshots" of the conversation, without deep understanding.
*   **Output**: raw text chunks + vector index + provenance tracking (Sources).

### 🧠 Fine Mode (carefully crafted)
*   **Characteristics**: **Calls an LLM** for deeper analysis.
*   **Use cases**:
    *   Long-term memory writing (needs key facts extracted).
    *   Document analysis (needs core ideas summarized).
    *   Multimodal understanding (needs to understand what's in an image).
*   **Output**: structured facts + key information extraction (Key) + background (Background) + vector index + provenance tracking (Sources) + multimodal details.

---

## 3. Code Structure

MemReader's code structure is straightforward and mainly includes:

*   **`base.py`**: defines the interface contract that all Readers must follow.
*   **`simple_struct.py`**: **the most commonly used implementation**. Focuses on pure-text conversations and local documents; lightweight and efficient.
*   **`multi_modal_struct.py`**: **an all-rounder**. Handles images, file URLs, tool calls, and other complex inputs.
*   **`read_multi_modal/`**: contains various parsers, such as `ImageParser` for images and `FileParser` for files.

---

## 4. How to Choose?

| Your need | Recommended choice | Why |
| :--- | :--- | :--- |
| **Only process plain text chats** | `SimpleStructMemReader` | Simple, direct, and performant. |
| **Need to handle images and file links** | `MultiModalStructMemReader` | Built-in multimodal parsing. |
| **Upgrade from Fast to Fine** | Any Reader's `fine_transfer` method | Supports a progressive "store first, refine later" strategy. |

---

## 5. API Overview

### Unified Factory: `MemReaderFactory`

Don't instantiate readers directly; using the factory pattern is best practice:

```python
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.mem_reader.factory import MemReaderFactory

# Create a Reader from configuration
cfg = MemReaderConfigFactory.model_validate({...})
reader = MemReaderFactory.from_config(cfg)
```

### Core Method: `get_memory()`

This is the method you will call most often.

```python
memories = reader.get_memory(
    scene_data,       # your input data
    type="chat",      # type: chat or doc
    info=user_info,   # user info (user_id, session_id)
    mode="fine"       # mode: fast or fine (highly recommended to specify explicitly!)
)
```

**Return value**: `list[list[TextualMemoryItem]]`

:::note
Why a nested list?
Because a long conversation may be split into multiple windows (Window). The outer list represents windows, and the inner list represents memory items extracted from that window.
:::

---

## 6. Practical Development

### Scenario 1: Processing simple chat logs

This is the most basic usage, with `SimpleStructMemReader`.

```python
# 1. Prepare input: standard OpenAI-style conversation format
conversation = [
    [
        {"role": "user", "content": "I have a meeting tomorrow at 3pm"},
        {"role": "assistant", "content": "What is the meeting about?"},
        {"role": "user", "content": "Discussing the Q4 project deadline"},
    ]
]

# 2. Extract memory (Fine mode)
memories = reader.get_memory(
    conversation,
    type="chat",
    mode="fine",
    info={"user_id": "u1", "session_id": "s1"}
)

# 3. Result
# memories will include extracted facts, e.g., "User has a meeting tomorrow at 3pm about the Q4 project deadline"
```

### Scenario 2: Processing multimodal inputs

When users send images or file links, switch to `MultiModalStructMemReader`.

```python
# 1. Prepare input: a complex message containing files and images
scene_data = [
    [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Check this file and image"},
                # Files support automatic download and parsing via URL
                {"type": "file", "file": {"file_data": "https://example.com/readme.md"}},
                # Images support URL
                {"type": "image_url", "image_url": {"url": "https://example.com/chart.png"}},
            ]
        }
    ]
]

# 2. Extract memory
memories = multimodal_reader.get_memory(
    scene_data,
    type="chat",
    mode="fine", # Only Fine mode invokes the vision model to parse images
    info={"user_id": "u1", "session_id": "s1"}
)
```

### Scenario 3: Progressive optimization (Fine Transfer)

For better UX, you can first store the conversation quickly in Fast mode, then "refine" it into Fine memories when the system is idle.

```python
# 1. Store quickly first (millisecond-level)
fast_memories = reader.get_memory(conversation, mode="fast", ...)

# ... store into the database ...

# 2. Refine asynchronously in the background
refined_memories = reader.fine_transfer_simple_mem(
    fast_memories_flat_list, # Note: pass a flattened list of Items here
    type="chat"
)

# 3. Replace the original fast_memories with refined_memories
```

---

## 7. Configuration Notes

In `.env` or configuration files, you can adjust these key parameters:

*   **`chat_window_max_tokens`**: **sliding window size**. Default is 1024. It determines how much context is packed together for processing. Too small may lose context; too large may exceed the LLM token limit.
*   **`remove_prompt_example`**: **whether to remove examples from the prompt**. True = save tokens but may reduce extraction quality; False = keep few-shot examples for better accuracy but consume more tokens.
*   **`direct_markdown_hostnames`** (multimodal only): **hostname allowlist**. If a file URL's hostname is in this list (e.g., `raw.githubusercontent.com`), the Reader treats it as Markdown text directly instead of trying OCR or conversion, which is more efficient.
