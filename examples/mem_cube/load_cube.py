"""
MemCube loading and View operation example.

This example demonstrates how to:
1. Load a static MemCube from directory using GeneralMemCube.init_from_dir()
2. Properly initialize runtime components (searcher, scheduler) for the loaded data
3. Perform add and search operations via SingleCubeView (recommended approach)
4. Understand the relationship between static loading and runtime memory

Important Notes:
- This example requires a full MemOS service environment (database, LLM, etc.)
- The loaded MemCube needs its own searcher and scheduler initialization
- Components from init_server() must be rebound to the loaded cube to work correctly
- Memories added via View will be stored in the loaded cube's memory backend

Limitations:
- This example requires MemCube with TreeTextMemory (backend: tree_text) for proper search
- GeneralTextMemory (backend: general_text) does not support get_searcher(), search will fail
- feedback_server is NOT rebound (complex initialization required) and is set to None
- This example disables feedback operations to prevent incorrect behavior
- When scheduler is enabled, use stop_consumer() before rebinding, then start() after
- async_mode can be "sync" (no scheduler needed) or "async" (scheduler required)
- For production use with full features, rebuild all components for the loaded cube

Environment Requirements:
- Database connections (configured via env vars)
- LLM API keys (if needed)
- Redis connection (optional, for scheduler background tasks)
- Set API_SCHEDULER_ON=true to enable async processing (recommended)
- Set API_SCHEDULER_ON=false for simple sync-only mode
"""

import os

from memos.api.handlers import init_server
from memos.api.product_models import APIADDRequest, APISearchRequest
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_cube.navie import NaiveMemCube
from memos.multi_mem_cube.single_cube import SingleCubeView


logger = get_logger(__name__)

# ===========================================================================
# Step 1: Load static MemCube data from directory
# ===========================================================================
print("=" * 80)
print("Step 1: Loading MemCube from directory")
print("=" * 80)

general = GeneralMemCube.init_from_dir("examples/data/mem_cube_2")
print(f"✓ Loaded cube_id: {general.config.cube_id}")
print(f"✓ User ID: {general.config.user_id}")

# Check loaded memory statistics (with safe checks for get_all availability)
# Note: text_mem.get_all() returns dict {"nodes": [...], "edges": [...]}
text_data = (
    general.text_mem.get_all() if general.text_mem and hasattr(general.text_mem, "get_all") else {}
)
text_nodes = text_data.get("nodes", []) if isinstance(text_data, dict) else []
act_items = (
    general.act_mem.get_all() if general.act_mem and hasattr(general.act_mem, "get_all") else []
)
print(f"✓ Text memories loaded: {len(text_nodes)} nodes")
print(f"✓ Activation memories loaded: {len(act_items)}")

# Show sample loaded data
if text_nodes:
    print("\n  Sample loaded memories (first 2):")
    for i, node in enumerate(text_nodes[:2], 1):
        memory_text = node.get("memory", str(node))[:80]
        print(f"    [{i}] {memory_text}...")

# ===========================================================================
# Step 2: Initialize server components
# ===========================================================================
print("\n" + "=" * 80)
print("Step 2: Initializing server components")
print("=" * 80)

# Check scheduler configuration
scheduler_enabled = os.getenv("API_SCHEDULER_ON", "true").lower() == "true"
print(f"Scheduler mode: {'ENABLED' if scheduler_enabled else 'DISABLED'}")

# Get base components (LLM, reader, scheduler framework, etc.)
components = init_server()
print("✓ Base components initialized")

# Get scheduler reference
mem_scheduler = components["mem_scheduler"]

# If scheduler was enabled, stop consumer before rebinding to avoid races.
# Use stop_consumer (not stop) so the dispatcher executor is not shut down.
scheduler_was_running = False
if scheduler_enabled:
    print("⚠  Stopping scheduler consumer for safe rebinding...")
    mem_scheduler.stop_consumer()
    scheduler_was_running = True
    print("✓ Scheduler consumer stopped")

# ===========================================================================
# Step 3: Create searcher and rebind scheduler for loaded cube
# ===========================================================================
print("\n" + "=" * 80)
print("Step 3: Binding components to loaded MemCube")
print("=" * 80)

# Wrap loaded memories into NaiveMemCube
loaded_naive = NaiveMemCube(
    text_mem=general.text_mem,
    act_mem=general.act_mem,
    para_mem=general.para_mem,
    pref_mem=general.pref_mem,
)

# Create searcher from loaded text_mem (critical: searcher must point to loaded data)
# Note: Only TreeTextMemory (backend: tree_text) supports get_searcher()
# GeneralTextMemory (backend: general_text) does NOT have get_searcher()
if loaded_naive.text_mem and hasattr(loaded_naive.text_mem, "get_searcher"):
    loaded_searcher = loaded_naive.text_mem.get_searcher(
        manual_close_internet=False, moscube=False, process_llm=components["mem_reader"].llm
    )
    print("✓ Created searcher for loaded MemCube (TreeTextMemory)")
else:
    # FAIL FAST: GeneralTextMemory is NOT supported for this example
    # Reason: components["searcher"] is bound to init_server's default cube,
    # not the loaded cube. Search would return incorrect/empty results.
    print("❌ ERROR: text_mem does not support get_searcher()!")
    print("   This example requires TreeTextMemory (backend: tree_text).")
    print("   GeneralTextMemory (backend: general_text) is NOT supported.")
    print("\n   Why? Searcher from init_server() is bound to the default cube,")
    print("   not your loaded cube. Search would return wrong results.")
    print("\n   Solution: Use a MemCube with TreeTextMemory backend.")
    exit(1)

# Reinitialize scheduler's mem_cube reference to loaded cube
# This ensures scheduler operations look up memories in the correct cube
# Pass feedback_server=None to disable feedback (avoid incorrect behavior)
mem_scheduler.init_mem_cube(mem_cube=loaded_naive, searcher=loaded_searcher, feedback_server=None)
print("✓ Scheduler rebound to loaded MemCube")
print("✓ feedback_server set to None (disabled to prevent incorrect operations)")

# Restart scheduler consumer if it was running before rebinding
if scheduler_was_running:
    print("⚠  Restarting scheduler consumer with rebound mem_cube...")
    mem_scheduler.start()
    print("✓ Scheduler consumer restarted and bound to loaded cube")

# ===========================================================================
# Step 4: Construct SingleCubeView with properly bound components
# ===========================================================================
print("\n" + "=" * 80)
print("Step 4: Creating SingleCubeView")
print("=" * 80)

view = SingleCubeView(
    cube_id=general.config.cube_id,
    naive_mem_cube=loaded_naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=mem_scheduler,
    logger=logger,
    searcher=loaded_searcher,  # Use the searcher bound to loaded cube
    feedback_server=None,  # Disable feedback to prevent incorrect operations
)
print(f"✓ SingleCubeView created for cube_id: {general.config.cube_id}")
print("✓ feedback_server disabled (set to None)")

# ===========================================================================
# Step 5: Search loaded memories via View
# ===========================================================================
print("\n" + "=" * 80)
print("Step 5: Searching loaded memories via View")
print("=" * 80)

# Search in loaded data to verify it's accessible
if text_nodes:
    # Use a query that should match loaded content
    search_result = view.search_memories(
        APISearchRequest(
            user_id=general.config.user_id,
            readable_cube_ids=[general.config.cube_id],
            query="what memories exist",  # Generic query to find loaded data
        )
    )

    print("\n✓ Search results from loaded data:")
    print(f"  - text_mem: {len(search_result.get('text_mem', []))} items")
    print(f"  - act_mem: {len(search_result.get('act_mem', []))} items")

    # Show top results from loaded data
    text_mems = search_result.get("text_mem", [])
    if text_mems:
        print(f"\n  Top {min(3, len(text_mems))} results:")
        for i, mem in enumerate(text_mems[:3], 1):
            text = mem.get("memory") or "N/A"  # search_memories returns "memory" field
            print(f"    [{i}] {text[:80]}...")
else:
    print("⚠  No text memories loaded to search")

# ===========================================================================
# Step 6: Add new memories via View
# ===========================================================================
print("\n" + "=" * 80)
print("Step 6: Adding new memories via View")
print("=" * 80)

add_result = view.add_memories(
    APIADDRequest(
        user_id=general.config.user_id,
        writable_cube_ids=[general.config.cube_id],
        messages=[
            {"role": "user", "content": "The weather is nice today, sunny and bright"},
            {"role": "user", "content": "I like to take walks in this kind of weather"},
        ],
        async_mode="async" if scheduler_enabled else "sync",  # Use async if scheduler is enabled
    )
)
print(f"✓ Memories added (mode: {'async' if scheduler_enabled else 'sync'})")

print(f"✓ Added {len(add_result)} new memory items")
for i, mem in enumerate(add_result, 1):
    content = mem.get("memory") or "N/A"  # add_memories returns "memory" field
    print(f"  [{i}] cube_id={mem.get('cube_id')}: {content[:50]}...")

# ===========================================================================
# Step 7: Search again to verify new memories are added
# ===========================================================================
print("\n" + "=" * 80)
print("Step 7: Searching for newly added memories")
print("=" * 80)

search_result_new = view.search_memories(
    APISearchRequest(
        user_id=general.config.user_id,
        readable_cube_ids=[general.config.cube_id],
        query="weather",
    )
)

print("\n✓ Search results (query='weather'):")
print(f"  - text_mem: {len(search_result_new.get('text_mem', []))} items")

text_mems_new = search_result_new.get("text_mem", [])
if text_mems_new:
    print(f"\n  Top {min(3, len(text_mems_new))} results:")
    for i, mem in enumerate(text_mems_new[:3], 1):
        text = mem.get("memory") or "N/A"  # search_memories returns "memory" field
        print(f"    [{i}] {text[:80]}...")

# ===========================================================================
# Summary
# ===========================================================================
print("\n" + "=" * 80)
print("✅ Example completed successfully!")
print("=" * 80)
print("\n📝 What this example demonstrated:")
print("  1. Load existing MemCube data from directory")
print("  2. Properly bind searcher and scheduler to loaded cube")
print("  3. Search and verify loaded data is accessible")
print("  4. Add new memories to the loaded cube via View")
print("  5. All operations use View architecture (recommended approach)")
print("\n⚠️  Important Notes:")
print("  - Searcher and scheduler are bound to the loaded cube")
print("  - feedback_server is DISABLED (set to None) to prevent incorrect operations")
print(
    f"  - Scheduler mode: {'ENABLED (async processing)' if scheduler_enabled else 'DISABLED (sync only)'}"
)
print(f"  - Add operations use async_mode='{'async' if scheduler_enabled else 'sync'}'")
print("  - New memories are added to loaded_naive, which shares memory instances with general")
print("  - Therefore, general.dump() WILL include View-added memories")
print("\n💡 Usage modes:")
print("  - API_SCHEDULER_ON=false: Simple sync mode, no background tasks")
print("  - API_SCHEDULER_ON=true: Full async mode with scheduler (recommended)")
print("  - Scheduler consumer is safely stopped/rebound/restarted (dispatcher stays alive)")
print("\n💡 For production:")
print("  - Use this pattern: stop_consumer() → rebind → start()")
print("  - Rebuild feedback_server with loaded cube's components if needed")
print("  - Or use init_server() components directly without loading external data")
print("\n" + "=" * 80)
