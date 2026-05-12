---
title: "TreeTextMemory: Structured Hierarchical Textual Memory"
desc: >
    Let’s build your first **graph-based, tree-structured memory** in MemOS!
    <br>
    **TreeTextMemory** helps you organize, link, and retrieve memories with rich context and explainability.
    <br>
    [Neo4j](/open_source/modules/memories/neo4j_graph_db) is the current backend, with support for additional graph stores planned in the future.
---


## Table of Contents

- [What You’ll Learn](#what-youll-learn)
- [Core Concepts and Workflow](#core-concepts-and-workflow)
    - [Memory Structure](#memory-structure)
    - [Metadata Fields](#metadata-fields-treenodetextualmemorymetadata)
    - [Core Workflow](#core-workflow)
- [API Reference](#api-reference)
- [Hands-on: From 0 to 1](#hands-on-from-0-to-1)
    - [Create TreeTextMemory Config](#create-treetextmemory-config)
    - [Initialize TreeTextMemory](#initialize-treetextmemory)
    - [Extract Structured Memories](#extract-structured-memories)
    - [Search Memories](#search-memories)
    - [Retrieve Memories from the Internet (Optional)](#retrieve-memories-from-the-internet-optional)
    - [Replace Working Memory](#replace-working-memory)
    - [Backup & Restore](#backup--restore)
    - [Full Code Example](#full-code-example)
- [Why Choose TreeTextMemory](#why-choose-treetextmemory)
- [What’s Next](#whats-next)

## What You’ll Learn

By the end of this guide, you will:
- Extract structured memories from raw text or conversations.
- Store them as **nodes** in a graph database.
- Link memories into **hierarchies** and semantic graphs.
- Search them using **vector similarity + graph traversal**.

## Core Concepts and Workflow

### Memory Structure

Every node in your `TreeTextMemory` is a `TextualMemoryItem`:
- `id`: Unique memory ID (auto-generated if omitted).
- `memory`: the main text.
- `metadata`: includes hierarchy info, embeddings, tags, entities, source, and status.

### Metadata Fields (`TreeNodeTextualMemoryMetadata`)

| Field           | Type                                                  | Description                                |
| --------------- |-------------------------------------------------------| ------------------------------------------ |
| `memory_type`   | `"WorkingMemory"`, `"LongTermMemory"`, `"UserMemory"` | Lifecycle category                         |
| `status`        | `"activated"`, `"archived"`, `"deleted"`              | Node status                                |
| `visibility`    | `"private"`, `"public"`, `"session"`                  | Access scope                               |
| `sources`       | `list[str]`                                           | List of sources (e.g. files, URLs)        |
| `source`        | `"conversation"`, `"retrieved"`, `"web"`, `"file"`    | Original source type                       |
| `confidence`    | `float (0-100)`                                       | Certainty score                            |
| `entities`      | `list[str]`                                           | Mentioned entities or concepts             |
| `tags`          | `list[str]`                                           | Thematic tags                              |
| `embedding`     | `list[float]`                                         | Vector embedding for similarity search     |
| `created_at`    | `str`                                                 | Creation timestamp (ISO 8601)              |
| `updated_at`    | `str`                                                 | Last update timestamp (ISO 8601)           |
| `usage`         | `list[str]`                                           | Usage history                              |
| `background`    | `str`                                                 | Additional context                         |


::note
**Best Practice**<br>
  Use meaningful tags and background — they help organize your graph for
multi-hop reasoning.
::

### Core Workflow

When you run this example, your workflow will:

1. **Extract:** Use an LLM to pull structured memories from raw text.


2. **Embed:** Generate vector embeddings for similarity search.


3. **Store & Link:** Add nodes to your graph database (Neo4j) with relationships.


4. **Search:** Query by vector similarity, then expand results by graph hops.


::note
**Hint**<br>Graph links help retrieve context that pure vector search might miss!
::

## API Reference

### Initialization

```python
TreeTextMemory(config: TreeTextMemoryConfig)
```

### Core Methods

| Method                      | Description                                           |
| --------------------------- | ----------------------------------------------------- |
| `add(memories)`             | Add one or more memories (items or dicts)             |
| `replace_working_memory()`  | Replace all WorkingMemory nodes                       |
| `get_working_memory()`      | Get all WorkingMemory nodes                           |
| `search(query, top_k)`      | Retrieve top-k memories using vector + graph search   |
| `get(memory_id)`            | Fetch single memory by ID                             |
| `get_by_ids(ids)`           | Fetch multiple memories by IDs                        |
| `get_all()`                 | Export the full memory graph as dictionary            |
| `update(memory_id, new)`    | Update a memory by ID                                 |
| `delete(ids)`               | Delete memories by IDs                                |
| `delete_all()`              | Delete all memories and relationships                 |
| `dump(dir)`                 | Serialize the graph to JSON in directory              |
| `load(dir)`                 | Load graph from saved JSON file                       |
| `drop(keep_last_n)`         | Backup graph & drop database, keeping N backups       |

### File Storage

When calling `dump(dir)`, the system writes to:

```
<dir>/<config.memory_filename>
```

This file contains a JSON structure with `nodes` and `edges`. It can be reloaded using `load(dir)`.

---

## Hands-on: From 0 to 1

::steps{}

### Create TreeTextMemory Config
Define:
- your embedder (to create vectors),
- your graph DB backend (Neo4j),
- and your extractor LLM (optional).

```python
from memos.configs.memory import TreeTextMemoryConfig

config = TreeTextMemoryConfig.from_json_file("examples/data/config/tree_config.json")
```


### Initialize TreeTextMemory

```python
from memos.memories.textual.tree import TreeTextMemory

tree_memory = TreeTextMemory(config)
```

### Extract Structured Memories

Use your extractor to parse conversations, files, or docs into `TextualMemoryItem`s.

```python
from memos.mem_reader.simple_struct import SimpleStructMemReader

reader = SimpleStructMemReader.from_json_file("examples/data/config/simple_struct_reader_config.json")

scene_data = [[
    {"role": "user", "content": "Tell me about your childhood."},
    {"role": "assistant", "content": "I loved playing in the garden with my dog."}
]]

memories = reader.get_memory(scene_data, type="chat", info={"user_id": "1234"})
for m_list in memories:
    tree_memory.add(m_list)
```

#### Using MultiModalStructMemReader (Advanced)

`MultiModalStructMemReader` supports processing multimodal content (text, images, URLs, files, etc.) and intelligently routes to different parsers:

```python
from memos.configs.mem_reader import MultiModalStructMemReaderConfig
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader

# Create MultiModal Reader configuration
multimodal_config = MultiModalStructMemReaderConfig(
    llm={
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-4o-mini",
            "api_key": "your-api-key"
        }
    },
    embedder={
        "backend": "openai",
        "config": {
            "model_name_or_path": "text-embedding-3-small",
            "api_key": "your-api-key"
        }
    },
    chunker={
        "backend": "text_splitter",
        "config": {
            "chunk_size": 1000,
            "chunk_overlap": 200
        }
    },
    extractor_llm={
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-4o-mini",
            "api_key": "your-api-key"
        }
    },
    # Optional: specify which domains should return Markdown directly
    direct_markdown_hostnames=["github.com", "docs.python.org"]
)

# Initialize MultiModal Reader
multimodal_reader = MultiModalStructMemReader(multimodal_config)

# ========================================
# Example 1: Process conversations with images
# ========================================
scene_with_image = [[
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "This is my garden"},
            {"type": "image_url", "image_url": {"url": "https://example.com/garden.jpg"}}
        ]
    },
    {
        "role": "assistant",
        "content": "Your garden looks beautiful!"
    }
]]

memories = multimodal_reader.get_memory(
    scene_with_image,
    type="chat",
    info={"user_id": "1234", "session_id": "session_001"}
)
for m_list in memories:
    tree_memory.add(m_list)
print(f"✓ Added {len(memories)} multimodal memories")

# ========================================
# Example 2: Process web URLs
# ========================================
scene_with_url = [[
    {
        "role": "user",
        "content": "Please analyze this article: https://example.com/article.html"
    },
    {
        "role": "assistant",
        "content": "I'll help you analyze this article"
    }
]]

url_memories = multimodal_reader.get_memory(
    scene_with_url,
    type="chat",
    info={"user_id": "1234", "session_id": "session_002"}
)
for m_list in url_memories:
    tree_memory.add(m_list)
print(f"✓ Extracted and added {len(url_memories)} memories from URL")

# ========================================
# Example 3: Process local files
# ========================================
# Supported file types: PDF, DOCX, TXT, Markdown, HTML, etc.
file_paths = [
    "./documents/report.pdf",
    "./documents/notes.md",
    "./documents/data.txt"
]

file_memories = multimodal_reader.get_memory(
    file_paths,
    type="doc",
    info={"user_id": "1234", "session_id": "session_003"}
)
for m_list in file_memories:
    tree_memory.add(m_list)
print(f"✓ Extracted and added {len(file_memories)} memories from files")

# ========================================
# Example 4: Mixed mode (text + images + URLs)
# ========================================
mixed_scene = [[
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "Here's my project documentation:"},
            {"type": "text", "text": "https://github.com/user/project/README.md"},
            {"type": "image_url", "image_url": {"url": "https://example.com/diagram.png"}}
        ]
    }
]]

mixed_memories = multimodal_reader.get_memory(
    mixed_scene,
    type="chat",
    info={"user_id": "1234", "session_id": "session_004"}
)
for m_list in mixed_memories:
    tree_memory.add(m_list)
print(f"✓ Extracted and added {len(mixed_memories)} memories from mixed content")
```

::note
**MultiModal Reader Advantages**<br>
- **Smart Routing**: Automatically identifies content type (image/URL/file) and selects appropriate parser<br>
- **Format Support**: Supports PDF, DOCX, Markdown, HTML, images, and more<br>
- **URL Parsing**: Automatically extracts web content (including GitHub, documentation sites, etc.)<br>
- **Large File Handling**: Automatically chunks oversized files to avoid token limits<br>
- **Context Preservation**: Uses sliding window to maintain context continuity between chunks
::

::note
**Configuration Tips**<br>
- Use the `direct_markdown_hostnames` parameter to specify which domains should return Markdown format<br>
- Supports both `mode="fast"` and `mode="fine"` extraction modes; fine mode extracts more details<br>
- See complete examples: `/examples/mem_reader/multimodal_struct_reader.py`
::

### Search Memories

Try a vector + graph search:
```python
results = tree_memory.search("Talk about the garden", top_k=5)
for i, node in enumerate(results):
    print(f"{i}: {node.memory}")
```

### Retrieve Memories from the Internet (Optional)

You can also fetch real-time web content using search engines such as Google, Bing, or Bocha, and automatically extract them into structured memory nodes. MemOS provides a unified interface for this purpose.

The following example demonstrates how to retrieve web content related to **“Alibaba 2024 ESG report”** and convert it into structured memories:

```python
# Create the embedder
embedder = EmbedderFactory.from_config(
    EmbedderConfigFactory.model_validate({
        "backend": "ollama",
        "config": {"model_name_or_path": "nomic-embed-text:latest"},
    })
)

# Configure the retriever (using BochaAI as an example)
retriever_config = InternetRetrieverConfigFactory.model_validate({
    "backend": "bocha",
    "config": {
        "api_key": "sk-xxx",  # Replace with your BochaAI API Key
        "max_results": 5,
        "reader": {  # Reader config for automatic chunking
            "backend": "simple_struct",
            "config": ...,  # Your mem-reader config
        },
    }
})

# Instantiate the retriever
retriever = InternetRetrieverFactory.from_config(retriever_config, embedder)

# Perform internet search
results = retriever.retrieve_from_internet("Alibaba 2024 ESG report")

# Add results to the memory graph
for m in results:
    tree_memory.add(m)
```

Alternatively, you can configure the `internet_retriever` field directly in the `TreeTextMemoryConfig`. For example:

```json
{
  "internet_retriever": {
    "backend": "bocha",
    "config": {
      "api_key": "sk-xxx",
      "max_results": 5,
      "reader": {
        "backend": "simple_struct",
        "config": ...
      }
    }
  }
}
```

With this setup, when you call `tree_memory.search(query)`, the system will automatically trigger an internet search (via BochaAI, Google, or Bing), and merge the results with local memory nodes in a unified ranked list — no need to manually call `retriever.retrieve_from_internet`.


### Replace Working Memory

Replace your current `WorkingMemory` nodes with new ones:
```python
tree_memory.replace_working_memory(
    [{
        "memory": "User is discussing gardening tips.",
        "metadata": {"memory_type": "WorkingMemory"}
    }]
)
```

### Backup & Restore
Dump your entire tree structure to disk and reload anytime:
```python
tree_memory.dump("tmp/tree_memories")
tree_memory.load("tmp/tree_memories")
```

::


### Full Code Example

This combines all the steps above into one end-to-end example — copy & run!

```python
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.memory import TreeTextMemoryConfig
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.tree import TreeTextMemory

# Setup Embedder
embedder_config = EmbedderConfigFactory.model_validate({
    "backend": "ollama",
    "config": {"model_name_or_path": "nomic-embed-text:latest"}
})
embedder = EmbedderFactory.from_config(embedder_config)

# Create TreeTextMemory
tree_config = TreeTextMemoryConfig.from_json_file("examples/data/config/tree_config.json")
my_tree_textual_memory = TreeTextMemory(tree_config)
my_tree_textual_memory.delete_all()

# Setup Reader
reader_config = SimpleStructMemReaderConfig.from_json_file(
    "examples/data/config/simple_struct_reader_config.json"
)
reader = SimpleStructMemReader(reader_config)

# Extract from conversation
scene_data = [[
    {
        "role": "user",
        "content": "Tell me about your childhood."
    },
    {
        "role": "assistant",
        "content": "I loved playing in the garden with my dog."
    },
]]
memory = reader.get_memory(scene_data, type="chat", info={"user_id": "1234", "session_id": "2222"})
for m_list in memory:
    my_tree_textual_memory.add(m_list)

# Search
results = my_tree_textual_memory.search(
    "Talk about the user's childhood story?",
    top_k=10
)
for i, r in enumerate(results):
    print(f"{i}'th result: {r.memory}")

# [Optional] Add from documents
doc_paths = ["./text1.txt", "./text2.txt"]
doc_memory = reader.get_memory(
  doc_paths, "doc", info={
      "user_id": "your_user_id",
      "session_id": "your_session_id",
  }
)
for m_list in doc_memory:
    my_tree_textual_memory.add(m_list)

# [Optional] Dump & Drop
my_tree_textual_memory.dump("tmp/my_tree_textual_memory")
my_tree_textual_memory.drop()
```

## Why Choose TreeTextMemory

- **Structured Hierarchy:** Organize memories like a mind map — nodes can
have parents, children, and cross-links.
- **Graph-Style Linking:** Beyond pure hierarchy — build multi-hop reasoning
  chains.
- **Semantic Search + Graph Expansion:** Combine the best of vectors and
  graphs.
- **Explainability:** Trace how memories connect, merge, or evolve over time.

::note
**Try This**<br>Add memory nodes from documents or web content. Link them
manually or auto-merge similar nodes!
::

## What’s Next

- **Know more about [Neo4j](/open_source/modules/memories/neo4j_graph_db):** TreeTextMemory is powered by a graph database backend.
  Understanding how Neo4j handles nodes, edges, and traversal will help you design more efficient memory hierarchies, multi-hop reasoning, and context linking strategies.
- **Add [Activation Memory](/open_source/modules/memories/kv_cache_memory):**
  Experiment with
  runtime KV-cache for session
  state.
- **Explore Graph Reasoning:** Build workflows for multi-hop retrieval and answer synthesis.
- **Go Deep:** Check the [API Reference](/api-reference/search-memories) for advanced usage, or run more examples in `examples/`.

Now your agent remembers not just facts — but the connections between them!
