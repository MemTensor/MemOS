"""
Tree Textual Memory Recall Example
===================================

This example demonstrates how to use MemOS's GraphMemoryRetriever to recall memories
from a shared graph database.

**What you'll learn:**
- How to load embedder and graph database configurations
- How to insert memories into the graph store with embeddings
- How to build a ParsedTaskGoal to guide retrieval
- How to retrieve relevant memories using hybrid search

**Use case:**
You have stored various long-term memories about a user (e.g., "Caroline")
in a graph database, and now you want to answer a natural language question
by retrieving the most relevant memories.

Run this example:
    python examples/basic_modules/tree_textual_memory_recall.py
"""

import json
import os

from memos import log
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.recall import GraphMemoryRetriever
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal


logger = log.get_logger(__name__)

# ============================================================================
# Step 0: Setup - Load configuration files
# ============================================================================
print("=" * 70)
print("Tree Textual Memory Recall Example")
print("=" * 70)

current_dir = os.path.dirname(os.path.abspath(__file__))
config_dir = os.path.join(current_dir, "../data/config")

# Load the shared tree-text memory configuration
# This config includes both embedder settings and graph database settings
config_path = os.path.join(config_dir, "tree_config_shared_database.json")
with open(config_path) as f:
    config_data = json.load(f)

print(f"\n✓ Loaded configuration from: {config_path}")

# ============================================================================
# Step 1: Initialize Embedder
# ============================================================================
# The embedder converts text into vector embeddings for semantic search
embedder_config = EmbedderConfigFactory.model_validate(config_data["embedder"])
embedder = EmbedderFactory.from_config(embedder_config)

print(f"✓ Initialized embedder: {embedder_config.backend}")

# ============================================================================
# Step 2: Initialize Graph Store
# ============================================================================
# The graph store persists memories and supports both graph queries and vector search
graph_config = GraphDBConfigFactory(**config_data["graph_db"])
graph_store = GraphStoreFactory.from_config(graph_config)

print(f"✓ Initialized graph store: {graph_config.backend}")

# ============================================================================
# Step 3: Clean up old mock data (optional)
# ============================================================================
# If you're running this example multiple times, clean up previous test data
# to avoid duplicates. This is optional in production.
print("\nCleaning up old mock data...")
try:
    if hasattr(graph_store, "delete_node_by_prams"):
        graph_store.delete_node_by_prams(filter={"key": "LGBTQ support group"})
        graph_store.delete_node_by_prams(filter={"key": "LGBTQ community"})
        print("✓ Old mock data cleaned")
    else:
        print("⚠ Graph store doesn't support delete_node_by_prams, skipping cleanup")
except Exception as exc:
    print(f"⚠ Cleanup warning: {exc}")

# ============================================================================
# Step 4: Insert mock memories into the graph store
# ============================================================================
# In a real application, these would be memories extracted from user conversations
# or documents. Here we use a few hardcoded examples about "Caroline".
print("\nInserting mock memories...")

mock_memories = [
    {
        "memory": "Caroline joined the LGBTQ support group in 2023.",
        "tags": ["LGBTQ", "support group"],
        "key": "LGBTQ support group",
    },
    {
        "memory": "Caroline has been an active member of the LGBTQ community since college.",
        "tags": ["LGBTQ", "community"],
        "key": "LGBTQ community",
    },
    {
        "memory": "She attended the weekly LGBTQ support group meetings every Friday.",
        "tags": ["LGBTQ", "support group", "meetings"],
        "key": "LGBTQ support group",
    },
]

for idx, mem_data in enumerate(mock_memories, 1):
    # Generate embedding for this memory
    mem_embedding = embedder.embed([mem_data["memory"]])[0]

    # Create a TextualMemoryItem with metadata
    item = TextualMemoryItem(
        memory=mem_data["memory"],
        metadata=TreeNodeTextualMemoryMetadata(
            memory_type="LongTermMemory",  # Can be ShortTermMemory, LongTermMemory, etc.
            key=mem_data["key"],
            tags=mem_data["tags"],
            embedding=mem_embedding,
            sources=[],
        ),
    )

    # Add the memory node to the graph store
    graph_store.add_node(item.id, item.memory, item.metadata.model_dump())
    print(f"  [{idx}/{len(mock_memories)}] Added: {mem_data['memory'][:60]}...")

print("✓ Mock memories inserted successfully")

# ============================================================================
# Step 5: Define a query and retrieval goal
# ============================================================================
# This is the natural language question we want to answer
query = "When did Caroline go to the LGBTQ support group?"
print(f"\n{'=' * 70}")
print(f"Query: {query}")
print(f"{'=' * 70}")

# ParsedTaskGoal provides hints to guide the retrieval process:
# - memories: semantic descriptions of what we're looking for
# - keys: specific keywords to match
# - tags: categorical tags to filter by
parsed_goal = ParsedTaskGoal(
    memories=[
        "Caroline's participation in the LGBTQ community",
        "Historical details of her membership",
        "Specific instances of Caroline's involvement in LGBTQ support groups",
        "Information about Caroline's activities in LGBTQ spaces",
        "Accounts of Caroline's role in promoting LGBTQ+ inclusivity",
    ],
    keys=["Family hiking experiences", "LGBTQ support group"],
    goal_type="retrieval",
    tags=["LGBTQ", "support group"],
)

# ============================================================================
# Step 6: Perform hybrid retrieval
# ============================================================================
# The retriever uses both semantic similarity (embeddings) and graph structure
# to find the most relevant memories
print("\nPerforming hybrid retrieval...")

query_embedding = embedder.embed([query])[0]
retriever = GraphMemoryRetriever(graph_store=graph_store, embedder=embedder)

retrieved_items: list[TextualMemoryItem] = retriever.retrieve(
    query=query,
    parsed_goal=parsed_goal,
    top_k=10,  # Maximum number of memories to retrieve
    memory_scope="LongTermMemory",  # Filter by memory type
    query_embedding=[query_embedding],
)

print(f"✓ Retrieved {len(retrieved_items)} memories")

# ============================================================================
# Step 7: Display results
# ============================================================================
print(f"\n{'=' * 70}")
print("Retrieved Memory Items:")
print(f"{'=' * 70}\n")

if not retrieved_items:
    print("❌ No memories retrieved.")
    print("   This might indicate:")
    print("   - The mock data wasn't inserted correctly")
    print("   - The query doesn't match any stored memories")
    print("   - The retrieval parameters are too restrictive")
else:
    for idx, item in enumerate(retrieved_items, 1):
        print(f"[{idx}] ID: {item.id}")
        print(f"    Memory: {item.memory}")
        print(f"    Tags: {item.metadata.tags if hasattr(item.metadata, 'tags') else 'N/A'}")
        print()

print(f"{'=' * 70}")
print("Example completed successfully!")
print(f"{'=' * 70}\n")
