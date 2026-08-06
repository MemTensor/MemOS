---
title: MemCube
desc: "`MemCube` is your memory container that manages three types of memories: textual memory, activation memory, and parametric memory. It provides a simple interface for loading, saving, and operating on multiple memory modules, making it easy to build, save, and share memory-augmented applications."
---

## What is MemCube?

**MemCube** contains three major types of memory:

- **Textual Memory**: Stores text knowledge, supporting semantic search and knowledge management.
- **Activation Memory**: Stores intermediate reasoning results, accelerating LLM responses.
- **Parametric Memory**: Stores model adaptation weights, used for personalization.

Each memory type can be independently configured and flexibly combined based on application needs.

## Structure

MemCube is defined by a configuration (see `GeneralMemCubeConfig`), which specifies the backend and settings for each memory type. The typical structure is:

```
MemCube
 ├── user_id
 ├── cube_id
 ├── text_mem: TextualMemory
 ├── act_mem: ActivationMemory
 └── para_mem: ParametricMemory
```

All memory modules are accessible via the MemCube interface:

- `mem_cube.text_mem`
- `mem_cube.act_mem`
- `mem_cube.para_mem`

## View Architecture

Starting from MemOS 2.0, runtime operations (add/search) should go through the **View architecture**:

### SingleCubeView

Use this to manage a single MemCube. When you only need one memory space.

```python
from memos.multi_mem_cube.single_cube import SingleCubeView

view = SingleCubeView(
    cube_id="my_cube",
    naive_mem_cube=naive_mem_cube,
    mem_reader=mem_reader,
    mem_scheduler=mem_scheduler,
    logger=logger,
    searcher=searcher,
    feedback_server=feedback_server,  # Optional
)

# Add memories
view.add_memories(add_request)

# Search memories
view.search_memories(search_request)
```

### CompositeCubeView

Use this to manage multiple MemCubes. When you need unified operations across multiple memory spaces.

```python
from memos.multi_mem_cube.composite_cube import CompositeCubeView

# Create multiple SingleCubeViews
view1 = SingleCubeView(cube_id="cube_1", ...)
view2 = SingleCubeView(cube_id="cube_2", ...)

# Composite view for multi-cube operations
composite = CompositeCubeView(cube_views=[view1, view2], logger=logger)

# Search across all cubes
results = composite.search_memories(search_request)
# Results contain cube_id field to identify source
```

## API Request Fields

When using the View architecture for add/search operations, specify these parameters:

| Field | Type | Description |
| :--- | :--- | :--- |
| `writable_cube_ids` | `list[str]` | Target cubes for add operations. Can specify multiple; the system will write to all targets in parallel. |
| `readable_cube_ids` | `list[str]` | Target cubes for search operations. Can search across multiple cubes; results include source information. |
| `async_mode` | `str` | Execution mode: `"sync"` for synchronous processing (wait for results), `"async"` for asynchronous processing (push to background queue, return task ID immediately). |

## Core Methods (`GeneralMemCube`)

**GeneralMemCube** is the standard implementation of MemCube, managing all system memories through a unified interface. Here are the main methods to complete memory lifecycle management.

### Initialization

```python
from memos.mem_cube.general import GeneralMemCube
mem_cube = GeneralMemCube(config)
```

### Static Data Operations

| Method | Description |
| :--- | :--- |
| `init_from_dir(dir)` | Load a MemCube from a local directory |
| `init_from_remote_repo(repo, base_url)` | Load a MemCube from a remote repository (e.g., Hugging Face) |
| `load(dir)` | Load all memories from a directory into the existing instance |
| `dump(dir)` | Save all memories to a directory for persistence |

## File Structure

A MemCube directory contains the following files, with each file corresponding to a memory type:

- `config.json` (MemCube configuration)
- `textual_memory.json` (textual memory)
- `activation_memory.pickle` (activation memory)
- `parametric_memory.adapter` (parametric memory)

## Usage Examples

### Export Example (dump_cube.py)

```python
import json
import os
import shutil

from memos.api.handlers import init_server
from memos.api.product_models import APIADDRequest
from memos.log import get_logger
from memos.multi_mem_cube.single_cube import SingleCubeView

logger = get_logger(__name__)
EXAMPLE_CUBE_ID = "example_dump_cube"
EXAMPLE_USER_ID = "example_user"

# 1. Initialize server
components = init_server()
naive = components["naive_mem_cube"]

# 2. Create SingleCubeView
view = SingleCubeView(
    cube_id=EXAMPLE_CUBE_ID,
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)

# 3. Add memories via View
result = view.add_memories(APIADDRequest(
    user_id=EXAMPLE_USER_ID,
    writable_cube_ids=[EXAMPLE_CUBE_ID],
    messages=[
        {"role": "user", "content": "This is a test memory"},
        {"role": "user", "content": "Another memory to persist"},
    ],
    async_mode="sync",  # Use sync mode to ensure immediate completion
))
print(f"✓ Added {len(result)} memories")

# 4. Export data for the specific cube_id
output_dir = "tmp/mem_cube_dump"
if os.path.exists(output_dir):
    shutil.rmtree(output_dir)
os.makedirs(output_dir, exist_ok=True)

# Export graph data (only data for the current cube_id)
json_data = naive.text_mem.graph_store.export_graph(
    include_embedding=True,  # Include embeddings to support semantic search
    user_name=EXAMPLE_CUBE_ID,  # Filter by cube_id
)

# Fix embedding format: parse string to list for import compatibility
import contextlib
for node in json_data.get("nodes", []):
    metadata = node.get("metadata", {})
    if "embedding" in metadata and isinstance(metadata["embedding"], str):
        with contextlib.suppress(json.JSONDecodeError):
            metadata["embedding"] = json.loads(metadata["embedding"])

print(f"✓ Exported {len(json_data.get('nodes', []))} nodes")

# Save to file
memory_file = os.path.join(output_dir, "textual_memory.json")
with open(memory_file, "w", encoding="utf-8") as f:
    json.dump(json_data, f, indent=2, ensure_ascii=False)
print(f"✓ Saved to: {memory_file}")
```

### Import and Search Example (load_cube.py)

> **Embedding Compatibility Note**: The sample data uses the **bge-m3** model with **1024 dimensions**. If your environment uses a different embedding model or dimension, semantic search after import may be inaccurate or fail. Ensure your `.env` configuration matches the embedding settings used during export.

```python
import json
import os

from memos.api.handlers import init_server
from memos.api.product_models import APISearchRequest
from memos.log import get_logger
from memos.multi_mem_cube.single_cube import SingleCubeView

logger = get_logger(__name__)
EXAMPLE_CUBE_ID = "example_dump_cube"
EXAMPLE_USER_ID = "example_user"

# 1. Initialize server
components = init_server()
naive = components["naive_mem_cube"]

# 2. Create SingleCubeView
view = SingleCubeView(
    cube_id=EXAMPLE_CUBE_ID,
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)

# 3. Load data from file into graph_store
load_dir = "examples/data/mem_cube_tree"
memory_file = os.path.join(load_dir, "textual_memory.json")

with open(memory_file, encoding="utf-8") as f:
    json_data = json.load(f)

naive.text_mem.graph_store.import_graph(json_data, user_name=EXAMPLE_CUBE_ID)

nodes = json_data.get("nodes", [])
print(f"✓ Imported {len(nodes)} nodes")

# 4. Display loaded data
print(f"\nLoaded {len(nodes)} memories:")
for i, node in enumerate(nodes[:3], 1):  # Show first 3
    metadata = node.get("metadata", {})
    memory_text = node.get("memory", "N/A")
    mem_type = metadata.get("memory_type", "unknown")
    print(f"  [{i}] Type: {mem_type}")
    print(f"      Content: {memory_text[:60]}...")

# 5. Semantic search verification
query = "test memory dump persistence demonstration"
print(f'\nSearching: "{query}"')

search_result = view.search_memories(
    APISearchRequest(
        user_id=EXAMPLE_USER_ID,
        readable_cube_ids=[EXAMPLE_CUBE_ID],
        query=query,
    )
)

text_mem_results = search_result.get("text_mem", [])
memories = []
for group in text_mem_results:
    memories.extend(group.get("memories", []))

print(f"✓ Found {len(memories)} relevant memories")
for i, mem in enumerate(memories[:2], 1):  # Show first 2
    print(f"  [{i}] {mem.get('memory', 'N/A')[:60]}...")
```

### Complete Examples

See examples in the code repository:

- `MemOS/examples/mem_cube/dump_cube.py` - Export MemCube data (add + export)
- `MemOS/examples/mem_cube/load_cube.py` - Import MemCube data and perform semantic search (import + search)

### Legacy API Notes

The old approach of directly calling `mem_cube.text_mem.get_all()` is deprecated. Please use the View architecture. Legacy examples have been moved to `MemOS/examples/mem_cube/_deprecated/`.

## Developer Notes

* MemCube enforces schema consistency to ensure safe loading and dumping
* Each memory type can be independently configured, tested, and extended
* See `/tests/mem_cube/` for integration tests and usage examples
