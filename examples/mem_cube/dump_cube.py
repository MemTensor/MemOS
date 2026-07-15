"""
MemCube dump example using SingleCubeView.

Demonstrates:
1. Initialize server and create SingleCubeView with NEW cube_id
2. Add memories via View
3. Dump ONLY this cube's data to directory

Requirements:
    - MemOS service environment (.env configured)
    - Neo4j graph database (set NEO4J_BACKEND=neo4j in .env)

Note on Embeddings:
    This example exports embeddings along with memory data.
    The sample data uses: bge-m3 model, 1024 dimensions.
    If your environment uses a different embedding model or dimension,
    you may need to re-embed the data after import, or the semantic
    search results may be inaccurate or fail.
"""

import contextlib
import json
import os
import shutil

from memos.api.handlers import init_server
from memos.api.product_models import APIADDRequest
from memos.log import get_logger
from memos.multi_mem_cube.single_cube import SingleCubeView


logger = get_logger(__name__)

# NEW cube_id to avoid dumping existing data
EXAMPLE_CUBE_ID = "example_dump_cube"
EXAMPLE_USER_ID = "example_user"

# =============================================================================
# Step 1: Initialize server
# =============================================================================
print("=" * 60)
print("Step 1: Initialize server")
print("=" * 60)

components = init_server()
print("✓ Server initialized")

# =============================================================================
# Step 2: Create SingleCubeView with NEW cube_id
# =============================================================================
print("\n" + "=" * 60)
print(f"Step 2: Create SingleCubeView (cube_id={EXAMPLE_CUBE_ID})")
print("=" * 60)

naive = components["naive_mem_cube"]
view = SingleCubeView(
    cube_id=EXAMPLE_CUBE_ID,  # NEW cube_id
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)
print("✓ SingleCubeView created")

# =============================================================================
# Step 3: Add memories via View
# =============================================================================
print("\n" + "=" * 60)
print("Step 3: Add memories via SingleCubeView")
print("=" * 60)

result = view.add_memories(
    APIADDRequest(
        user_id=EXAMPLE_USER_ID,
        writable_cube_ids=[EXAMPLE_CUBE_ID],
        messages=[
            {"role": "user", "content": "This is a test memory for dump example"},
            {"role": "user", "content": "Another memory to demonstrate persistence"},
        ],
        async_mode="sync",
    )
)
print(f"✓ Added {len(result)} memories")

# =============================================================================
# Step 4: Dump ONLY this cube's data
# =============================================================================
print("\n" + "=" * 60)
print("Step 4: Dump cube data (filtered by cube_id)")
print("=" * 60)

output_dir = "tmp/mem_cube_dump"
if os.path.exists(output_dir):
    shutil.rmtree(output_dir)
os.makedirs(output_dir, exist_ok=True)

# Export only this cube's data using user_name filter
text_mem = naive.text_mem
json_data = text_mem.graph_store.export_graph(
    include_embedding=True,  # Include embeddings for semantic search
    user_name=EXAMPLE_CUBE_ID,  # Filter by cube_id
)

# Fix embedding format: parse string to list for import compatibility
# (export_graph stores embedding as string in metadata, but add_node expects list)
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

# Save config (user can modify sensitive fields before sharing)
config = components["default_cube_config"].model_copy(deep=True)
config.user_id = EXAMPLE_USER_ID
config.cube_id = EXAMPLE_CUBE_ID
config_file = os.path.join(output_dir, "config.json")
config.to_json_file(config_file)
print(f"✓ Config saved to: {config_file}")

# =============================================================================
# Done
# =============================================================================
print("\n" + "=" * 60)
print("✅ Example completed!")
print("=" * 60)
print(f"\nDumped to: {output_dir}")
print("Run load_cube.py to load this data")
