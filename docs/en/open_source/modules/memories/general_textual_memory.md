---
title: "GeneralTextMemory: General-Purpose Textual Memory"
desc: "`GeneralTextMemory` is a flexible, vector-based textual memory module in MemOS, designed for storing, searching, and managing unstructured knowledge. It is suitable for conversational agents, personal assistants, and any system requiring semantic memory retrieval."
---

## Table of Contents

- [Memory Structure](#memory-structure)
  - [Metadata Fields (`TextualMemoryMetadata`)](#metadata-fields-textualmemorymetadata)
- [API Summary (`GeneralTextMemory`)](#api-summary-generaltextmemory)
  - [Initialization](#initialization)
  - [Core Methods](#core-methods)
- [File Storage](#file-storage)
- [Example Usage](#example-usage)
- [Extension: Internet Retrieval](#extension-internet-retrieval)
- [Advanced: Using MultiModal Reader](#advanced-using-multimodal-reader)
- [Developer Notes](#developer-notes)


## Memory Structure

Each memory is represented as a `TextualMemoryItem`:

| Field      | Type                        | Description                        |
| ---------- | --------------------------- | ---------------------------------- |
| `id`       | `str`                       | UUID (auto-generated if omitted)   |
| `memory`   | `str`                       | The main memory content (required) |
| `metadata` | `TextualMemoryMetadata`     | Metadata for search/filtering      |

### Metadata Fields (`TextualMemoryMetadata`)

| Field         | Type                                               | Description                         |
| ------------- | -------------------------------------------------- | ----------------------------------- |
| `type`        | `"procedure"`, `"fact"`, `"event"`, `"opinion"` | Memory type                         |
| `memory_time` | `str (YYYY-MM-DD)`                                 | Date/time the memory refers to      |
| `source`      | `"conversation"`, `"retrieved"`, `"web"`, `"file"` | Source of the memory                |
| `confidence`  | `float (0-100)`                                    | Certainty/confidence score          |
| `entities`    | `list[str]`                                        | Key entities/concepts               |
| `tags`        | `list[str]`                                        | Thematic tags                       |
| `visibility`  | `"private"`, `"public"`, `"session"`            | Access scope                        |
| `updated_at`  | `str`                                              | Last update timestamp (ISO 8601)    |

All values are validated. Invalid values will raise errors.

### Search Mechanism
Unlike NaiveTextMemory, which relies on keyword matching, GeneralTextMemory utilizes vector-based semantic search.

## Algorithm Comparison

| Feature            | Keyword Matching  | Vector Semantic Search  |
| ------------------ | ---------------------------------- | ------------------------------------------ |
| **Semantic Understanding** | ❌ Doesn't understand synonyms  | ✅ Understands similar concepts            |
| **Resource Usage** | ✅ Extremely low                   | ⚠️ Requires embedding model and vector DB  |
| **Execution Speed** | ✅ Fast (O(n))                    | ⚠️ Slower (indexing + querying)            |
| **Suitable Scale** | < 1K memories                     | 10K - 100K memories                        |
| **Predictability** | ✅ Intuitive results               | ⚠️ Black box model


## API Summary (`GeneralTextMemory`)

### Initialization
```python
GeneralTextMemory(config: GeneralTextMemoryConfig)
```

### Core Methods
| Method                   | Description                                         |
| ------------------------ | --------------------------------------------------- |
| `extract(messages)`      | Extracts memories from message list (LLM-based)     |
| `add(memories)`          | Adds one or more memories (items or dicts)          |
| `search(query, top_k)`   | Retrieves top-k memories using vector similarity    |
| `get(memory_id)`         | Fetch single memory by ID                           |
| `get_by_ids(ids)`        | Fetch multiple memories by IDs                      |
| `get_all()`              | Returns all memories                                |
| `update(memory_id, new)` | Update a memory by ID                               |
| `delete(ids)`            | Delete memories by IDs                              |
| `delete_all()`           | Delete all memories                                 |
| `dump(dir)`              | Serialize all memories to JSON file in directory    |
| `load(dir)`              | Load memories from saved file                       |

## File Storage

When calling `dump(dir)`, the system stores the memories to:

```
<dir>/<config.memory_filename>
```

This file contains a JSON list of all memory items, which can be reloaded using `load(dir)`.

## Example Usage

```python
import os
from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

config = MemoryConfigFactory(
    backend="general_text",
    config={
        "extractor_llm": { ... },
        "vector_db": { ... },
        "embedder": { ... },
    },
)
m = MemoryFactory.from_config(config)

# Extract and add memories
memories = m.extract([
    {"role": "user", "content": "I love tomatoes."},
    {"role": "assistant", "content": "Great! Tomatoes are delicious."},
])
m.add(memories)

# Search
results = m.search("Tell me more about the user", top_k=2)

# Update
m.update(memory_id, {"memory": "User is Canadian.", ...})

# Delete
m.delete([memory_id])

# Dump/load
m.dump("tmp/mem")
m.load("tmp/mem")
```

::note
**Extension: Internet Retrieval**<br>
GeneralTextMemory can be combined with Internet Retrieval to extract content from web pages and add to memory.<br>
View example: [Retrieve Memories from the Internet](./tree_textual_memory#retrieve-memories-from-the-internet-optional)
::

::note
**Advanced: Using MultiModal Reader**<br>
For processing images, URLs, or files within conversations, see the comprehensive MultiModal Reader examples.<br>
View documentation: [Using MultiModalStructMemReader](./tree_textual_memory#using-multimodalstructmemreader-advanced)
::

## Developer Notes

* Uses Qdrant (or compatible) vector DB for fast similarity search
* Embedding and extraction models are configurable (Ollama/OpenAI supported)
* All methods are covered by integration tests in `/tests`
