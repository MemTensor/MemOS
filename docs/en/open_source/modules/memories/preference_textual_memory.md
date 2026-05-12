---
title: "PreferenceTextMemory: Textual Memory for User Preferences"
desc: "`PreferenceTextMemory` is a textual memory module in MemOS for storing and managing user preferences. It is suitable for scenarios where memory retrieval needs to be based on user preferences."
---

## Table of Contents

- [Why Preference Memory is Needed](#why-preference-memory-is-needed)
  - [Key Features](#key-features)
  - [Application Scenarios](#application-scenarios)
- [Core Concepts and Workflow](#core-concepts-and-workflow)
  - [Memory Structure](#memory-structure)
  - [Metadata Fields (`PreferenceTextualMemoryMetadata`)](#metadata-fields-preferencetextualmemorymetadata)
  - [Core Workflow](#core-workflow)
- [API Reference](#api-reference)
  - [Initialization](#initialization)
  - [Core Methods](#core-methods)
  - [File Storage](#file-storage)
- [Hands-on Practice: From Zero to One](#hands-on-practice-from-zero-to-one)
  - [Create PreferenceTextMemory Configuration](#create-preferencetextmemory-configuration)
  - [Initialize PreferenceTextMemory](#initialize-preferencetextmemory)
  - [Extract Structured Memory](#extract-structured-memory)
  - [Search Memory](#search-memory)
  - [Backup and Restore](#backup-and-restore)
  - [Complete Code Example](#complete-code-example)


## Why Preference Memory is Needed

### Key Features

::list{icon="ph:check-circle-duotone"}
- **Dual Preference Extraction**: Automatically identifies explicit and implicit preferences
- **Semantic Understanding**: Uses vector embeddings to understand the deep meaning of preferences
- **Smart Deduplication**: Automatically detects and merges duplicate or conflicting preferences
- **Precise Retrieval**: Semantic search based on vector similarity
- **Persistent Storage**: Supports vector databases (Qdrant/Milvus)
- **Scalability**: Supports large-scale preference data management
- **Personalization Enhancement**: Maintains independent preference profiles for each user
::

### Application Scenarios

::list{icon="ph:lightbulb-duotone"}
- Personalized conversational agents (remembering user likes/dislikes)
- Intelligent recommendation systems (recommendations based on preferences)
- Customer service systems (providing customized services)
- Content filtering systems (filtering content based on preferences)
- Learning assistance systems (adapting to learning styles)
::


In conclusion, when you need to build systems that can "remember" user preferences and provide personalized services accordingly, `PreferenceTextMemory` is the best choice.
::

## Core Concepts and Workflow
### Memory Structure

In MemOS, preference memory is represented by `PreferenceTextMemory`, where each memory item is a `TextualMemoryItem` stored in Milvus database.
- `id`: Unique memory ID (automatically generated if omitted)
- `memory`: Main text content
- `metadata`: Includes hierarchical structure information, embeddings, tags, entities, sources, and status

Preference memory can be divided into explicit preference memory and implicit preference memory:
- **Explicit Preference Memory**: Preferences that users explicitly express. **Examples**:
    - "I like dark mode"
    - "I don't eat spicy food"
    - "Please use short answers"
    - "I prefer technical documentation over video tutorials"

- **Implicit Preference Memory**: Preferences inferred from user behavior and conversation patterns. **Examples**:
    - User always asks for code examples → prefers practice-oriented learning
    - User frequently requests detailed explanations → prefers in-depth understanding
    - User mentions environmental topics multiple times → concerned about sustainable development

::note
**Intelligent Extraction**<br>
`PreferenceTextMemory` automatically extracts both explicit and implicit preferences from conversations using LLM, no manual annotation required!
::

### Metadata Fields (`PreferenceTextualMemoryMetadata`)

| Field         | Type                                               | Description                         |
| ------------- | -------------------------------------------------- | ----------------------------------- |
| `preference_type`        | `"explicit_preference"`, `"implicit_preference"`                                    | Preference memory type, divided into explicit and implicit preference memory                         |
| `dialog_id`        | `str`                                    | Dialog ID, used to associate preference memory with specific dialogs                         |
| `original_text`        | `str`                                    | Original text containing user preference information                         |
| `embedding`        | `str`                                    | Embedding vector for semantic search and retrieval                         |
| `preference`        | `str`                                    | User preference information              |
| `create_at`        | `str`                                    | Creation timestamp (ISO 8601)                         |
| `mem_cube_id`        | `str`                                    | Memory cube ID, used to associate preference memory with specific memory cubes                         |
| `score`        | `float `                                | Similarity score between preference memory and query in search results   |

### Core Workflow

When you run this example, your workflow will:

1. **Extraction:** Use LLM to extract structured memory from raw text.


2. **Embedding:** Generate vector embeddings for similarity search.


3. **Storage:** Store preference memory in Milvus database while updating metadata fields.


4. **Search:** Return the most relevant preference memories through vector similarity queries.

## API Reference

### Initialization

```python
PreferenceTextMemory(config: PreferenceTextMemoryConfig)
```

### Core Methods

| Method                      | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `get_memory(messages)` | Extract preference memories from original dialogues. |
| `search(query, top_k)` | Retrieve top-k preference memories using vector similarity. |
| `load(dir)` | Load preference memories from stored files. |
| `dump(dir)` | Serialize all preference memories to JSON files in the directory. |
| `add(memories)` | Batch add preference memories to Milvus database.  |
| `get_with_collection_name(collection_name, memory_id)` | Get specific type of preference memory by collection name and memory ID. |
| `get_by_ids_with_collection_name(collection_name, memory_ids)` | Batch get specific type of preference memory by collection name and memory IDs. |
| `get_all()` | Get all preference memories. |
| `get_memory_by_filter(filter)` | Get preference memories based on filter conditions. |
| `delete(memory_ids)` | Delete preference memories by specified IDs. |
| `delete_by_filter(filter)` | Delete preference memories based on filter conditions. |
| `delete_with_collection_name(collection_name, memory_ids)` | Delete all preference memories with specified collection name and IDs. |
| `delete_all()` | Delete all preference memories. |


### File Storage

When calling `dump(dir)`, MemOS will serialize all preference memories to JSON files in the directory:
```
<dir>/<config.memory_filename>
```

---

## Hands-on Practice: From Zero to One

::steps{}

### Create PreferenceTextMemory Configuration
Define:
- Your embedding model (e.g., nomic-embed-text:latest),
- Your Milvus database backend,
- Memory extractor (based on LLM) (optional).

```python
from memos.configs.memory import PreferenceTextMemoryConfig

config = PreferenceTextMemoryConfig.from_json_file("examples/data/config/preference_config.json")
```

### Initialize PreferenceTextMemory

```python
from memos.memories.textual.preference import PreferenceTextMemory

preference_memory = PreferenceTextMemory(config)
```

### Extract Structured Memory

Use the memory extractor to parse dialogues, files, or documents into multiple `TextualMemoryItem`.

```python
scene_data = [[
    {"role": "user", "content": "Tell me about your childhood."},
    {"role": "assistant", "content": "I loved playing in the garden with my dog."}
]]

memories = preference_memory.get_memory(scene_data, type="chat", info={"user_id": "1234"})
preference_memory.add(memories)
```

### Search Memory

```python
results = preference_memory.search("Tell me more about the user", top_k=2)
```

### Backup and Restore
Support persistent storage and on-demand reloading of preference memories:
```python
preference_memory.dump("tmp/pref_memories")
preference_memory.load("tmp/pref_memories")
```

::

### Complete Code Example

This example integrates all the above steps, providing an end-to-end complete workflow — copy and run!

```python
from memos.configs.memory import PreferenceTextMemoryConfig
from memos.memories.textual.preference import PreferenceTextMemory

# Create PreferenceTextMemory
config = PreferenceTextMemoryConfig.from_json_file("examples/data/config/preference_config.json")

preference_memory = PreferenceTextMemory(config)
preference_memory.delete_all()

scene_data = [[
    {"role": "user", "content": "Tell me about your childhood."},
    {"role": "assistant", "content": "I loved playing in the garden with my dog."}
]]

# Extract preference memories from original dialogues and add to Milvus database
memories = preference_memory.get_memory(scene_data, type="chat", info={"user_id": "1234"})
preference_memory.add(memories)

# Search memory
results = preference_memory.search("Tell me more about the user", top_k=2)

# Persist preference memories
preference_memory.dump("tmp/pref_memories")
```
