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
import os
from memos.api.handlers import init_server
from memos.mem_cube.general import GeneralMemCube
from memos.mem_cube.navie import NaiveMemCube
from memos.multi_mem_cube.single_cube import SingleCubeView

# Load static data
general = GeneralMemCube.init_from_dir("examples/data/mem_cube_2")

# Get runtime components
components = init_server()
mem_scheduler = components["mem_scheduler"]

# Stop scheduler consumer if enabled (avoid race conditions)
scheduler_enabled = os.getenv("API_SCHEDULER_ON", "true").lower() == "true"
if scheduler_enabled:
    mem_scheduler.stop_consumer()  # Use stop_consumer, not stop!

# Wrap in NaiveMemCube and rebind scheduler
loaded_naive = NaiveMemCube(
    text_mem=general.text_mem,
    act_mem=general.act_mem,
    para_mem=general.para_mem,
    pref_mem=general.pref_mem,
)
loaded_searcher = loaded_naive.text_mem.get_searcher(...)
mem_scheduler.init_mem_cube(loaded_naive, loaded_searcher, feedback_server=None)

# Restart scheduler if it was enabled
if scheduler_enabled:
    mem_scheduler.start()

# Create View
view = SingleCubeView(
    cube_id=general.config.cube_id,
    naive_mem_cube=loaded_naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=mem_scheduler,
    searcher=loaded_searcher,
    feedback_server=None,
    # ...
)

# Use View API
results = view.search_memories(APISearchRequest(...))  # ✅ View interface
for mem in results["text_mem"]:
    print(mem)
```

---

For more information, see the [MemCube documentation](https://memos-doc.memoryos.ai/open_source/modules/mem_cube).
