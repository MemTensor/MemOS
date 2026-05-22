---
title: "NaiveTextMemory: Simple Plain Text Memory"
desc: "The most lightweight memory module in MemOS, designed for rapid prototyping and simple scenarios. No vector database required—quickly retrieve memories using keyword matching."
---

Let's get started with the MemOS memory system in the simplest way possible!

NaiveTextMemory is a lightweight, memory-based, plain-text memory module. It stores memories in an in-memory list and retrieves them using keyword matching. It is the perfect starting point for learning MemOS, as well as an ideal choice for demos, testing, and small-scale applications.

## Table of Contents

- [What You'll Learn](#what-youll-learn)
- [Why Choose NaiveTextMemory](#why-choose-naivetextmemory)
- [Core Concepts](#core-concepts)
    - [Memory Structure](#memory-structure)
    - [Metadata Fields](#metadata-fields-textualmemorymetadata)
    - [Search Mechanism](#search-mechanism)
- [API Reference](#api-reference)
    - [Initialization](#initialization)
    - [Core Methods](#core-methods)
    - [Configuration Parameters](#configuration-parameters)
- [Hands-On Practice](#hands-on-practice)
    - [Quick Start](#quick-start)
    - [Complete Example](#complete-example)
    - [File Storage](#file-storage)
- [Use Case Guide](#use-case-guide)
- [Comparison with Other Memory Modules](#comparison-with-other-memory-modules)
- [Best Practices](#best-practices)
- [Next Steps](#next-steps)

## What You'll Learn

By the end of this guide, you will be able to:
- Automatically extract structured memories from conversations using LLM
- Store and manage memories in memory (no database required)
- Search memories using keyword matching
- Persist and restore memory data
- Understand when to use NaiveTextMemory and when to upgrade to other modules

## Why Choose NaiveTextMemory

### Key Advantages

::list{icon="ph:check-circle-duotone"}
- **Zero Dependencies**: No vector database or embedding model required
- **Fast Startup**: Up and running in just a few lines of code
- **Lightweight & Efficient**: Low resource footprint, fast execution
- **Simple & Intuitive**: Keyword matching with predictable results
- **Easy to Debug**: All memories in memory, easy to inspect
- **Perfect Starting Point**: The best entry point for learning MemOS
::

### Suitable Scenarios

::list{icon="ph:lightbulb-duotone"}
- Rapid prototyping and proof of concept
- Simple conversational agents (< 1000 memories)
- Testing and demo scenarios
- Resource-constrained environments (cannot run embedding models)
- Keyword search scenarios (queries directly match memories)
::

::note
**Performance Tip**<br>
When memory count exceeds 1000, it's recommended to upgrade to [GeneralTextMemory](/open_source/modules/memories/general_textual_memory), which uses vector search for better performance.
::

## Core Concepts

### Memory Structure

Each memory is represented as a `TextualMemoryItem` object with the following fields:

| Field      | Type                        | Required | Description                          |
| ---------- | --------------------------- | -------- | ------------------------------------ |
| `id`       | `str`                       | ✗        | Unique identifier (auto-generated UUID) |
| `memory`   | `str`                       | ✓        | Main text content of the memory      |
| `metadata` | `TextualMemoryMetadata`     | ✗        | Metadata (for categorization, filtering, and retrieval) |

### Metadata Fields (`TextualMemoryMetadata`)

Metadata provides rich contextual information for categorization, filtering, and organizing memories:

| Field         | Type                                               | Default    | Description                        |
| ------------- | -------------------------------------------------- | ---------- | ---------------------------------- |
| `type`        | `"procedure"` / `"fact"` / `"event"` / `"opinion"` | `"fact"`   | Memory type classification         |
| `memory_time` | `str (YYYY-MM-DD)`                                 | Current date | Time associated with the memory  |
| `source`      | `"conversation"` / `"retrieved"` / `"web"` / `"file"` | -          | Source of the memory              |
| `confidence`  | `float (0-100)`                                    | 80.0       | Certainty/confidence score         |
| `entities`    | `list[str]`                                        | `[]`       | Mentioned entities or concepts     |
| `tags`        | `list[str]`                                        | `[]`       | Topic tags                         |
| `visibility`  | `"private"` / `"public"` / `"session"`            | `"private"` | Access control scope              |
| `updated_at`  | `str`                                              | Auto-generated | Last update timestamp (ISO 8601) |

## API Reference

### Initialization

```python
from memos.memories.textual.naive import NaiveTextMemory
from memos.configs.memory import NaiveTextMemoryConfig

memory = NaiveTextMemory(config: NaiveTextMemoryConfig)
```

### Core Methods

| Method                   | Parameters                            | Returns                       | Description                                   |
| ------------------------ | ------------------------------------- | ----------------------------- | --------------------------------------------- |
| `extract(messages)`      | `messages: list[dict]`                | `list[TextualMemoryItem]`     | Extract structured memories from conversation using LLM |
| `add(memories)`          | `memories: list / dict / Item`        | `None`                        | Add one or more memories                      |
| `search(query, top_k)`   | `query: str, top_k: int`              | `list[TextualMemoryItem]`     | Retrieve top-k memories using keyword matching |
| `get(memory_id)`         | `memory_id: str`                      | `TextualMemoryItem`           | Get a single memory by ID                     |
| `get_by_ids(ids)`        | `ids: list[str]`                      | `list[TextualMemoryItem]`     | Batch retrieve memories by ID list            |
| `get_all()`              | -                                     | `list[TextualMemoryItem]`     | Return all memories                           |
| `update(memory_id, new)` | `memory_id: str, new: dict`           | `None`                        | Update content or metadata of specified memory |
| `delete(ids)`            | `ids: list[str]`                      | `None`                        | Delete one or more memories                   |
| `delete_all()`           | -                                     | `None`                        | Clear all memories                            |
| `dump(dir)`              | `dir: str`                            | `None`                        | Serialize memories to JSON file               |
| `load(dir)`              | `dir: str`                            | `None`                        | Load memories from JSON file                  |

### Search Mechanism

Unlike `GeneralTextMemory`'s vector semantic search, `NaiveTextMemory` uses a **keyword matching algorithm**:

::steps{}

#### Step 1: Tokenization
Break down the query and each memory content into lists of tokens

#### Step 2: Calculate Match Score
Count the number of overlapping tokens between query and memory

#### Step 3: Sort
Sort all memories by match count in descending order

#### Step 4: Return Results
Return the top-k memories as search results


::note
**Example Comparison**<br>
Query: "cat" <br>
- **Keyword Matching**: Only matches memories containing "cat"<br>
- **Semantic Search**: Also matches memories about "pet", "kitten", "feline", etc.
::

### Configuration Parameters

**NaiveTextMemoryConfig**

| Parameter          | Type                   | Required | Default                | Description                                    |
| ------------------ | ---------------------- | -------- | ---------------------- | ---------------------------------------------- |
| `extractor_llm`    | `LLMConfigFactory`     | ✓        | -                      | LLM configuration for extracting memories from conversations |
| `memory_filename`  | `str`                  | ✗        | `textual_memory.json`  | Filename for persistent storage                |

**Configuration Example**

```json
{
  "backend": "naive_text",
  "config": {
    "extractor_llm": {
      "backend": "openai",
      "config": {
        "model_name_or_path": "gpt-4o-mini",
        "temperature": 0.8,
        "max_tokens": 1024,
        "api_base": "xxx",
        "api_key": "sk-xxx"
      }
    },
    "memory_filename": "my_memories.json"
  }
}
```

## Hands-On Practice

### Quick Start

Get started with NaiveTextMemory in just 3 steps:

::steps{}

#### Step 1: Create Configuration

```python
from memos.configs.memory import MemoryConfigFactory

config = MemoryConfigFactory(
    backend="naive_text",
    config={
        "extractor_llm": {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": "your-api-key",
                "api_base": "your-api-base"
            },
        },
    },
)
```

#### Step 2: Initialize Memory Module

```python
from memos.memories.factory import MemoryFactory

memory = MemoryFactory.from_config(config)
```

#### Step 3: Extract and Add Memories

```python
# Automatically extract memories from conversation
memories = memory.extract([
    {"role": "user", "content": "I love tomatoes."},
    {"role": "assistant", "content": "Great! Tomatoes are delicious."},
])

# Add to memory store
memory.add(memories)
print(f"✓ Added {len(memories)} memories")
```

::note
**Advanced: Using MultiModal Reader**<br>
If you need to process multimodal content such as images, URLs, or files, use `MultiModalStructMemReader`.<br>
View complete example: [Using MultiModalStructMemReader (Advanced)](./tree_textual_memory#using-multimodalstructmemreader-advanced)
::

::

### Complete Example

Here's a complete end-to-end example demonstrating all core functionality:

```python
from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

# ========================================
# 1. Initialization
# ========================================
config = MemoryConfigFactory(
    backend="naive_text",
    config={
        "extractor_llm": {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": "your-api-key",
            },
        },
    },
)
memory = MemoryFactory.from_config(config)

# ========================================
# 2. Extract and Add Memories
# ========================================
memories = memory.extract([
    {"role": "user", "content": "I love tomatoes."},
    {"role": "assistant", "content": "Great! Tomatoes are delicious."},
])
memory.add(memories)
print(f"✓ Added {len(memories)} memories")

# ========================================
# 3. Search Memories
# ========================================
results = memory.search("tomatoes", top_k=2)
print(f"\n🔍 Found {len(results)} relevant memories:")
for i, item in enumerate(results, 1):
    print(f"  {i}. {item.memory}")

# ========================================
# 4. Get All Memories
# ========================================
all_memories = memory.get_all()
print(f"\n📊 Total {len(all_memories)} memories")

# ========================================
# 5. Update Memory
# ========================================
if memories:
    memory_id = memories[0].id
    memory.update(
        memory_id,
        {
            "memory": "User loves tomatoes.",
            "metadata": {"type": "opinion", "confidence": 95.0}
        }
    )
    print(f"\n✓ Updated memory: {memory_id}")

# ========================================
# 6. Persist to Storage
# ========================================
memory.dump("tmp/mem")
print("\n💾 Memories saved to tmp/mem/textual_memory.json")

# ========================================
# 7. Load Memories
# ========================================
memory.load("tmp/mem")
print("✓ Memories loaded from file")

# ========================================
# 8. Delete Memories
# ========================================
if memories:
    memory.delete([memories[0].id])
    print(f"\n🗑️ Deleted 1 memory")

# Delete all memories
# memory.delete_all()
```

::note
**Extension: Internet Retrieval**<br>
NaiveTextMemory focuses on local memory management. For retrieving information from the internet and adding it to your memory store, see:<br>
[Retrieve Memories from the Internet (Optional)](./tree_textual_memory#retrieve-memories-from-the-internet-optional)
::

### File Storage

When calling `dump(dir)`, the system saves memories to:

```
<dir>/<config.memory_filename>
```

**Default File Structure**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "memory": "User loves tomatoes.",
    "metadata": {
      "type": "opinion",
      "confidence": 95.0,
      "entities": ["user", "tomatoes"],
      "tags": ["food", "preference"],
      "updated_at": "2026-01-14T10:30:00Z"
    }
  },
  ...
]
```

Use `load(dir)` to fully restore all memory data.

::note
**Important Note**<br>
Memories are stored in memory and will be lost after process restart. Remember to call `dump()` regularly to save data!
::

## Use Case Guide

### Best Suited For

::list{icon="ph:check-circle-duotone"}
- **Rapid Prototyping**: No need to configure vector databases, get started in minutes
- **Simple Conversational Agents**: Small-scale applications with < 1000 memories
- **Testing and Demos**: Quickly validate memory extraction and retrieval logic
- **Resource-Constrained Environments**: Scenarios where embedding models or vector databases cannot run
- **Keyword Search**: Scenarios where query content directly matches memory text
- **Learning and Teaching**: The best starting point for understanding MemOS memory system
::

### Not Recommended For

::list{icon="ph:x-circle-duotone"}
- **Large-Scale Applications**: More than 10,000 memories (search performance degrades)
- **Semantic Search Needs**: Need to understand synonyms (e.g., "cat" and "pet")
- **Production Environments**: Strict performance and accuracy requirements
- **Multilingual Scenarios**: Need cross-language semantic understanding
- **Complex Relationship Reasoning**: Need to understand relationships between memories
::

::alert{type="info"}
**Upgrade Path**<br>
For the scenarios not recommended above, consider upgrading to:
- [GeneralTextMemory](/open_source/modules/memories/general_textual_memory) - Vector semantic search, suitable for 10K-100K memories
- [TreeTextMemory](/open_source/modules/memories/tree_textual_memory) - Graph structure storage, supports relationship reasoning and multi-hop queries
::

## Comparison with Other Memory Modules

Choosing the right memory module is crucial for project success. This comparison helps you make the decision:

| Feature            | **NaiveTextMemory**   | **GeneralTextMemory**      | **TreeTextMemory**          |
| ------------------ | --------------------- | -------------------------- | --------------------------- |
| **Search Method**  | Keyword matching      | Vector semantic search     | Graph structure + vector search |
| **Dependencies**   | LLM only              | LLM + Embedder + Vector DB | LLM + Embedder + Graph DB   |
| **Suitable Scale** | < 1K                  | 1K - 100K                  | 10K - 1M                    |
| **Query Complexity** | O(n) linear scan    | O(log n) approximate NN    | O(log n) + graph traversal  |
| **Semantic Understanding** | ❌            | ✅                          | ✅                           |
| **Relationship Reasoning** | ❌            | ❌                          | ✅                           |
| **Multi-Hop Queries** | ❌                 | ❌                          | ✅                           |
| **Storage Backend** | In-memory list       | Vector DB (Qdrant, etc.)   | Graph DB (Neo4j/PolarDB)    |
| **Configuration Complexity** | Low ⭐       | Medium ⭐⭐                | High ⭐⭐⭐                 |
| **Learning Curve** | Minimal               | Moderate                   | Steep                       |
| **Production Ready** | ❌ Prototype/demo only | ✅ Suitable for most cases | ✅ Suitable for complex apps |

::alert{type="success"}
**Selection Guide**<br>
- **Just getting started?** → Start with NaiveTextMemory<br>
- **Need semantic search?** → Use GeneralTextMemory<br>
- **Need relationship reasoning?** → Choose TreeTextMemory
::

## Best Practices

Follow these recommendations to make the most of NaiveTextMemory:

::steps{}

### 1. Persist Data Regularly

```python
# Save immediately after critical operations
memory.add(new_memories)
memory.dump("tmp/mem")  # ✓ Persist immediately

# Regular automatic backups
import schedule
schedule.every(10).minutes.do(lambda: memory.dump("tmp/mem"))
```

### 2. Control Memory Scale

```python
# Regularly clean old memories
if len(memory.get_all()) > 1000:
    old_memories = sorted(
        memory.get_all(),
        key=lambda m: m.metadata.updated_at
    )[:100]  # Oldest 100

    memory.delete([m.id for m in old_memories])
    print("✓ Cleaned 100 old memories")
```

### 3. Optimize Search Queries

```python
# ❌ Poor: Vague query
results = memory.search("thing", top_k=5)

# ✅ Good: Use specific keywords
results = memory.search("tomato", top_k=5)
```

### 4. Use Metadata Wisely

```python
# Set clear metadata when adding memories
memory.add({
    "memory": "User prefers dark mode",
    "metadata": {
        "type": "opinion",          # ✓ Clear classification
        "tags": ["UI", "preference"],  # ✓ Easy filtering
        "confidence": 90.0,         # ✓ Mark confidence
        "entities": ["user", "dark mode"]  # ✓ Entity annotation
    }
})
```

### 5. Plan Upgrade Path

```python
# Monitor memory count and upgrade timely
memory_count = len(memory.get_all())
if memory_count > 800:
    print("⚠️ Memory count approaching limit, consider upgrading to GeneralTextMemory")
    # Migration code reference:
    # 1. Export existing memories: memory.dump("backup")
    # 2. Create GeneralTextMemory configuration
    # 3. Import memories to new module
```

::

## Next Steps

Congratulations! You've mastered the core usage of NaiveTextMemory. Next, you can:

::list{icon="ph:arrow-right-duotone"}
- **Upgrade to Vector Search**: Learn about [GeneralTextMemory](/open_source/modules/memories/general_textual_memory)'s semantic retrieval capabilities
- **Explore Graph Structure**: Understand [TreeTextMemory](/open_source/modules/memories/tree_textual_memory)'s relationship reasoning features
- **Integrate into Applications**: Check [Complete API Documentation](/api-reference/search-memories) to build production-grade applications
- **Run Example Code**: Browse the `/examples/` directory for more practical cases
- **Learn Graph Databases**: If you need advanced features, learn about [Neo4j](/open_source/modules/memories/neo4j_graph_db) or [PolarDB](/open_source/modules/memories/polardb_graph_db)
::

::alert{type="success"}
**Tip**<br>
NaiveTextMemory is the perfect starting point for learning MemOS. When your application needs more powerful features, you can seamlessly migrate to other memory modules!
::
