---
title: Your First Memory
desc: Let’s build your first plaintext memory in MemOS! **GeneralTextMemory** is the easiest way to get hands-on with extracting, embedding, and searching simple text memories.
---

## What You'll Learn

By the end of this guide, you will:
- Extract memories from plain text or chat messages.
- Store them as semantic vectors.
- Search and manage them using vector similarity.

## How It Works

### Memory Structure

Every memory is stored as a `TextualMemoryItem`:
- `memory`: the main text content (e.g., "The user loves tomatoes.")
- `metadata`: extra details to make the memory searchable and manageable — type,
  time, source, confidence, entities, tags, visibility, and updated_at.

These fields make each piece of memory queryable, filterable, and easy to govern.

For each `TextualMemoryItem`:

| Field         | Example                   | What it means                              |
| ------------- | ------------------------- | ------------------------------------------ |
| `type`        | `"opinion"`               | Classify if it's a fact, event, or opinion |
| `memory_time` | `"2025-07-02"`            | When it happened                           |
| `source`      | `"conversation"`          | Where it came from                         |
| `confidence`  | `100.0`                   | Certainty score (0–100)                    |
| `entities`    | `["tomatoes"]`            | Key concepts                               |
| `tags`        | `["food", "preferences"]` | Extra labels for grouping                  |
| `visibility`  | `"private"`               | Who can access it                          |
| `updated_at`  | `"2025-07-02T00:00:00Z"`  | Last modified                              |

::note
**Best Practice**<br>You can define any metadata fields that make sense for your use case!
::



### The Core Steps
When you run this example:

1. **Extract:**
Your messages go through an `extractor_llm`, which returns a JSON list of `TextualMemoryItem`s.

2. **Embed:**
Each memory's `memory` field is turned into an embedding vector via `embedder`.

3. **Store:**
The embeddings are saved into a local **Qdrant** collection.

4. **Search & Manage:**
You can now `search` by semantic similarity, `update` by ID, or `delete` memories.

::note
**Hint**<br>Make sure your embedder's output dimension matches your vector DB's `vector_dimension`.
  Mismatch may cause search errors!
::



::note
**Hint**<br>If your search results are too noisy or irrelevant, check whether your <code>embedder</code> config and vector DB are properly initialized.
::

### Example Flow

**Input Messages:**

```json
[
  {"role": "user", "content": "I love tomatoes."},
  {"role": "assistant", "content": "Great! Tomatoes are healthy."}
]
```

**Extracted Memory:**

```json
{
  "memory": "The user loves tomatoes.",
  "metadata": {
    "type": "opinion",
    "memory_time": "2025-07-02",
    "source": "conversation",
    "confidence": 100.0,
    "entities": ["tomatoes"],
    "tags": ["food", "preferences"],
    "visibility": "private",
    "updated_at": "2025-07-02T00:00:00"
  }
}
```

Here's a minimal script to create, extract, store, and search a memory:

::steps{level="4"}

#### Create a Memory Config

First, create your minimal GeneralTextMemory config.
It contains three key parts:
- extractor_llm: uses an LLM to extract plaintext memories from conversations.
- embedder: turns each memory into a vector.
- vector_db: stores vectors and supports similarity search.

```python
from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

config = MemoryConfigFactory(
    backend="general_text",
    config={
        "extractor_llm": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "qwen3:0.6b",
                "temperature": 0.0,
                "remove_think_prefix": True,
                "max_tokens": 8192,
            },
        },
        "vector_db": {
            "backend": "qdrant",
            "config": {
                "collection_name": "test_textual_memory",
                "distance_metric": "cosine",
                "vector_dimension": 768,
            },
        },
        "embedder": {
            "backend": "ollama",
            "config": {
                "model_name_or_path": "nomic-embed-text:latest",
            },
        },
    },
)

m = MemoryFactory.from_config(config)
```


#### Extract Memories from Messages
Give your LLM a simple dialogue and see how it extracts structured plaintext memories.

```python
memories = m.extract(
    [
        {"role": "user", "content": "I love tomatoes."},
        {"role": "assistant", "content": "Great! Tomatoes are delicious."},
    ]
)
print("Extracted:", memories)
```
You'll get a list of TextualMemoryItem, with each of them like:
```text
TextualMemoryItem(
  id='...',
  memory='The user loves tomatoes.',
  metadata=...
)
```

#### Add Memories to Your Vector DB

Save the extracted memories to your vector DB and demonstrate adding a custom plaintext memory manually (with a custom ID).

```python
m.add(memories)
m.add([
    {
        "id": "a19b6caa-5d59-42ad-8c8a-e4f7118435b4",
        "memory": "User is Chinese.",
        "metadata": {"type": "opinion"},
    }
])
```


#### Search Memories

Now test similarity search!
Type any natural language query and find related memories.
```python
results = m.search("Tell me more about the user", top_k=2)
print("Search results:", results)
```

#### Get Memories by ID

Fetch any memory directly by its ID:
```python
print("Get one by ID:", m.get("a19b6caa-5d59-42ad-8c8a-e4f7118435b4"))
```

#### Update a Memory

Need to fix or refine a memory?
Update it by ID and re-embed the new version.
```python
m.update(
    "a19b6caa-5d59-42ad-8c8a-e4f7118435b4",
    {
        "memory": "User is Canadian.",
        "metadata": {
            "type": "opinion",
            "confidence": 85,
            "memory_time": "2025-05-24",
            "source": "conversation",
            "entities": ["Canadian"],
            "tags": ["happy"],
            "visibility": "private",
            "updated_at": "2025-05-19T00:00:00",
        },
    }
)
print("Updated:", m.get("a19b6caa-5d59-42ad-8c8a-e4f7118435b4"))
```

#### Delete Memories

Remove one or more memories cleanly
```python
m.delete(["a19b6caa-5d59-42ad-8c8a-e4f7118435b4"])
print("Remaining:", m.get_all())
```

#### Dump Memories to Disk

Finally, dump all your memories to local storage:
```python
m.dump("tmp/mem")
print("Memory dumped to tmp/mem")
```
By default, your memories are saved to:
```
<your_dir>/<config.memory_filename>
```
They can be reloaded anytime with `load()`.

::note
By default, your dumped memories are saved to the file path you set in your config.
  Always check <code>config.memory_filename</code> if you want to customize it.
::

::

Now your agent remembers — no more stateless chatbots!

## What's Next?

Ready to level up?

- **Try your own LLM backend:** Swap to OpenAI, HuggingFace, or Ollama.
- **Explore [TreeTextMemory](/open_source/modules/memories/tree_textual_memory):** Build a graph-based,
  hierarchical memory.
- **Add [Activation Memory](/open_source/modules/memories/kv_cache_memory):** Cache key-value
  states for faster inference.
- **Dive deeper:** Check the [API Reference](/api-reference/search-memories) and [Examples](/open_source/getting_started/examples) for advanced workflows.

::note
**Try Graph Textual Memory**<br>Try switching to
<code>TreeTextMemory</code> to add a graph-based, hierarchical structure to your memories.<br>Perfect for scenarios that need explainability and long-term structured knowledge.
::
