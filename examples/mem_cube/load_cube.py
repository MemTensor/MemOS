"""
MemCube load example using SingleCubeView.

Demonstrates:
1. Initialize server and create SingleCubeView
2. Load memories from dump via graph_store.import_graph()
3. Display loaded memories
4. Search loaded memories (semantic search)

Requirements:
    - MemOS service environment (.env configured)
    - Neo4j graph database (set NEO4J_BACKEND=neo4j in .env)

Note on Embeddings:
    The sample data (examples/data/mem_cube_tree) uses: bge-m3 model, 1024 dimensions.
    For semantic search to work correctly, your environment must use the same
    embedding model and dimension. If different, search results may be inaccurate.
"""

import json
import os

from memos.api.handlers import init_server
from memos.api.product_models import APISearchRequest
from memos.log import get_logger
from memos.multi_mem_cube.single_cube import SingleCubeView


logger = get_logger(__name__)

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
# Step 2: Create SingleCubeView
# =============================================================================
print("\n" + "=" * 60)
print(f"Step 2: Create SingleCubeView (cube_id={EXAMPLE_CUBE_ID})")
print("=" * 60)

naive = components["naive_mem_cube"]
view = SingleCubeView(
    cube_id=EXAMPLE_CUBE_ID,
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)
print("✓ SingleCubeView created")

# =============================================================================
# Step 3: Load memories from dump
# =============================================================================
print("\n" + "=" * 60)
print("Step 3: Load memories from dump")
print("=" * 60)

load_dir = "examples/data/mem_cube_tree"
memory_file = os.path.join(load_dir, "textual_memory.json")

if not os.path.exists(memory_file):
    print(f"❌ File not found: {memory_file}")
    print("   Run dump_cube.py first to create data!")
    exit(1)

with open(memory_file, encoding="utf-8") as f:
    json_data = json.load(f)

# Import graph data into graph_store
text_mem = naive.text_mem
text_mem.graph_store.import_graph(json_data, user_name=EXAMPLE_CUBE_ID)

nodes = json_data.get("nodes", [])
edges = json_data.get("edges", [])
print(f"✓ Imported {len(nodes)} nodes, {len(edges)} edges")

# =============================================================================
# Step 4: Display loaded memories
# =============================================================================
print("\n" + "=" * 60)
print("Step 4: Display loaded memories")
print("=" * 60)

print(f"\nLoaded {len(nodes)} memories:")
for i, node in enumerate(nodes, 1):
    metadata = node.get("metadata", {})
    memory_text = node.get("memory", "N/A")
    mem_type = metadata.get("memory_type", "unknown")
    print(f"\n  [{i}] Type: {mem_type}")
    print(f"      Content: {memory_text[:70]}...")

# =============================================================================
# Step 5: Search loaded memories
# =============================================================================
print("\n" + "=" * 60)
print("Step 5: Search loaded memories")
print("=" * 60)

query = "test memory dump persistence demonstration"
print(f'Query: "{query}"')

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

print(f"\n✓ Found {len(memories)} relevant memories:")
for i, mem in enumerate(memories[:3], 1):
    content = mem.get("metadata", {}).get("memory", "N/A")[:70]
    print(f"  [{i}] {content}...")

# =============================================================================
# Done
# =============================================================================
print("\n" + "=" * 60)
print("✅ Example completed!")
print("=" * 60)
