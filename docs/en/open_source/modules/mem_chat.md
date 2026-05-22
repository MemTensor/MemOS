---
title: MemChat
desc: MemChat is your "memory diplomat". It coordinates user input, memory retrieval, and LLM generation to create coherent conversations with long-term memory.
---

## 1. Introduction

**MemChat** is the conversation control center of MemOS.

It is not just a chat interface, but a bridge connecting "instant conversation" and "long-term memory". During interactions with users, MemChat is responsible for real-time retrieval of relevant background information from MemCube (Memory Cube), building context, and crystallizing new conversation content into new memories. With it, your Agent is no longer "goldfish memory", but a truly intelligent companion that can understand the past and continuously grow.

---

## 2. Core Capabilities

### Memory-Augmented Chat
Before answering user questions, MemChat automatically retrieves relevant Textual Memory from MemCube and injects it into the Prompt. This enables the Agent to answer questions based on past interaction history or knowledge bases, rather than relying solely on the LLM's pre-trained knowledge.

### Auto-Memorization
After conversation, MemChat uses Extractor LLM to automatically extract valuable information from the conversation flow (such as user preferences, factual knowledge) and store it in MemCube. The entire process is fully automated without manual user intervention.

### Context Management
Automatically manages conversation history window (`max_turns_window`). When conversations become too long, it intelligently trims old context while relying on retrieved long-term memory to maintain conversation coherence, effectively solving the LLM Context Window limitation problem.

### Flexible Configuration
Supports configurable toggles for different types of memory (textual memory, activation memory, etc.) to adapt to different application scenarios.

---

## 3. Code Structure

Core logic is located under `memos/src/memos/mem_chat/`.

*   **`simple.py`**: **Default implementation (SimpleMemChat)**. This is an out-of-the-box REPL (Read-Eval-Print Loop) implementation containing complete "retrieve -> generate -> store" loop logic.
*   **`base.py`**: **Interface definition (BaseMemChat)**. Defines the basic behavior of MemChat, such as `run()` and `mem_cube` properties.
*   **`factory.py`**: **Factory class**. Responsible for instantiating concrete MemChat objects based on configuration (`MemChatConfig`).

---

## 4. Key Interface

The main interaction entry point is the `MemChat` class (typically created by `MemChatFactory`).

### 4.1 Initialization
You need to first create a configuration object, then create an instance through the factory method. After creation, you must mount the `MemCube` instance to `mem_chat.mem_cube`.

### 4.2 `run()`
Starts an interactive command-line conversation loop. Suitable for development and debugging, it handles user input, calls memory retrieval, generates replies, and prints output.

### 4.3 Properties
*   **`mem_cube`**: Associated MemCube object. MemChat reads and writes memories through it.
*   **`chat_llm`**: LLM instance used to generate replies.

---

## 5. Workflow

A typical conversation round in MemChat includes the following steps:

1.  **Receive Input**: Get user text input.
2.  **Memory Recall**: (If `enable_textual_memory` is enabled) Use user input as Query to retrieve Top-K relevant memories from `mem_cube.text_mem`.
3.  **Prompt Construction**: Concatenate system prompt, retrieved memories, and recent conversation history into a complete Prompt.
4.  **Generate Response**: Call `chat_llm` to generate a reply.
5.  **Memorization**: (If `enable_textual_memory` is enabled) Send this round's conversation (User + Assistant) to `mem_cube`'s extractor, extract new memories and store them in the database.

---

## 6. Development Example

Below is a complete code example showing how to configure MemChat and mount a MemCube based on Qdrant and OpenAI.

### 6.1 Code Implementation

```python
import os
import sys

# Ensure src module can be imported
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../src")))

from memos.configs.mem_chat import MemChatConfigFactory
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.mem_chat.factory import MemChatFactory
from memos.mem_cube.general import GeneralMemCube

def get_mem_chat_config() -> MemChatConfigFactory:
    """Generate MemChat configuration"""
    return MemChatConfigFactory.model_validate(
        {
            "backend": "simple",
            "config": {
                "user_id": "user_123",
                "chat_llm": {
                    "backend": "openai",
                    "config": {
                        "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "api_key": os.getenv("OPENAI_API_KEY"),
                        "api_base": os.getenv("OPENAI_API_BASE"),
                    },
                },
                "max_turns_window": 20,
                "top_k": 5,
                "enable_textual_memory": True, # Enable explicit memory
            },
        }
    )

def get_mem_cube_config() -> GeneralMemCubeConfig:
    """Generate MemCube configuration"""
    return GeneralMemCubeConfig.model_validate(
        {
            "user_id": "user03alice",
            "cube_id": "user03alice/mem_cube_tree",
            "text_mem": {
                "backend": "general_text",
                "config": {
                    "cube_id": "user03alice/mem_cube_general",
                    "extractor_llm": {
                        "backend": "openai",
                        "config": {
                            "model_name_or_path": os.getenv("MOS_CHAT_MODEL", "gpt-4o"),
                            "api_key": os.getenv("OPENAI_API_KEY"),
                            "api_base": os.getenv("OPENAI_API_BASE"),
                        },
                    },
                    "vector_db": {
                        "backend": "qdrant",
                        "config": {
                            "collection_name": "user03alice_mem_cube_general",
                            "vector_dimension": 1024,
                        },
                    },
                    "embedder": {
                        "backend": os.getenv("MOS_EMBEDDER_BACKEND", "universal_api"),
                        "config": {
                            "provider": "openai",
                            "api_key": os.getenv("MOS_EMBEDDER_API_KEY", "EMPTY"),
                            "model_name_or_path": os.getenv("MOS_EMBEDDER_MODEL", "bge-m3"),
                            "base_url": os.getenv("MOS_EMBEDDER_API_BASE"),
                        },
                    },
                },
            },
        }
    )

def main():
    print("Initializing MemChat...")
    mem_chat = MemChatFactory.from_config(get_mem_chat_config())

    print("Initializing MemCube...")
    mem_cube = GeneralMemCube(get_mem_cube_config())

    # Critical step: mount the memory cube
    mem_chat.mem_cube = mem_cube

    print("Starting Chat Session...")
    try:
        mem_chat.run()
    finally:
        print("Saving memory cube...")
        mem_chat.mem_cube.dump("new_cube_path")

if __name__ == "__main__":
    main()
```

---

## 7. Configuration Description

When configuring `MemChatConfigFactory`, the following parameters are crucial:

*   **`user_id`**: Required. Used to identify the current user in the conversation, ensuring memory isolation.
*   **`chat_llm`**: Chat model configuration. Recommend using a capable model (such as GPT-4o) for better reply quality and instruction-following ability.
*   **`enable_textual_memory`**: `True` / `False`. Whether to enable textual memory. If enabled, the system will perform retrieval before conversation and storage after conversation.
*   **`max_turns_window`**: Integer. Number of conversation turns to retain in history. History beyond this limit will be truncated, relying on long-term memory to supplement context.
*   **`top_k`**: Integer. How many most relevant memory fragments to retrieve from the memory library and inject into the Prompt each time.
