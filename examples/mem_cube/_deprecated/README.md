# Deprecated Examples

⚠️ **These examples are deprecated and no longer maintained.**

## Why deprecated?

These examples demonstrate old APIs that directly access MemCube internals (e.g., `mem_cube.text_mem.get_all()`), which is no longer the recommended approach.

## Current Best Practice

**Use `SingleCubeView` / `CompositeCubeView` for all add/search operations.**

The new View architecture provides:
- ✅ Unified API interface
- ✅ Multi-cube support
- ✅ Better integration with MemOS Server
- ✅ Consistent result format with `cube_id` tracking

## Updated Examples

See the following files in the parent directory:
- **`../load_cube.py`** - Load MemCube and operate via SingleCubeView
- **`../dump_cube.py`** - Persist MemCube to disk

## Migration Guide

### Old approach (deprecated):
```python
mem_cube = GeneralMemCube.init_from_dir("examples/data/mem_cube_2")
items = mem_cube.text_mem.get_all()  # ❌ Direct access
for item in items:
    print(item)
```

### New approach (recommended):
```python
import json
from memos.api.handlers import init_server
from memos.api.product_models import APISearchRequest
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.log import get_logger

logger = get_logger(__name__)

# Initialize server (uses .env configuration)
components = init_server()
naive = components["naive_mem_cube"]

# Create View
view = SingleCubeView(
    cube_id="my_cube",
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)

# Load data from exported JSON
with open("examples/data/mem_cube_tree/textual_memory.json") as f:
    json_data = json.load(f)
naive.text_mem.graph_store.import_graph(json_data, user_name="my_cube")

# Use View API for search
results = view.search_memories(APISearchRequest(
    user_id="user",
    readable_cube_ids=["my_cube"],
    query="your query here",
))
for group in results.get("text_mem", []):
    for mem in group.get("memories", []):
        print(mem.get("metadata", {}).get("memory", "N/A"))
```

> **Note on Embeddings**: The sample data uses **bge-m3** model with **1024 dimensions**.
> Ensure your environment uses the same embedding configuration for accurate search.

---

For more information, see the [MemCube documentation](https://memos-doc.memoryos.ai/open_source/modules/mem_cube).
