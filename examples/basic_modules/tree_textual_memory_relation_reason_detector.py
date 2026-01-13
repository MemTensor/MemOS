"""
Tree Textual Memory Relation & Reasoning Detector Example
==========================================================

This example demonstrates how to use MemOS's RelationAndReasoningDetector to
automatically discover relationships between memories and infer new knowledge.

**What you'll learn:**
- How to initialize embedder, graph store, and LLM for relation detection
- How to create mock memory nodes with rich metadata
- How to detect pairwise relations between memory nodes (e.g., causal, temporal)
- How to infer new facts through multi-hop reasoning chains
- How to generate aggregate concepts from related memories
- How to identify sequential patterns (FOLLOWS relationships)

**Use case:**
You have stored multiple facts about a user (e.g., "Caroline's work stress",
"joining support group", "improved mental health"). This detector can:
1. Find causal links: "Work stress" → "Joining support group" → "Better mental health"
2. Infer new facts: "Support groups help reduce work-related stress"
3. Build aggregate concepts: "Caroline's stress management journey"

Run this example:
    python examples/basic_modules/tree_textual_memory_relation_reason_detector.py
"""

import json
import os
import uuid

from memos import log
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.graph_db import GraphDBConfigFactory
from memos.configs.llm import LLMConfigFactory
from memos.embedders.factory import EmbedderFactory
from memos.graph_dbs.factory import GraphStoreFactory
from memos.graph_dbs.item import GraphDBNode
from memos.llms.factory import LLMFactory
from memos.memories.textual.item import TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.relation_reason_detector import (
    RelationAndReasoningDetector,
)


logger = log.get_logger(__name__)

# ============================================================================
# Step 0: Setup - Load configuration files
# ============================================================================
print("=" * 80)
print("Tree Textual Memory Relation & Reasoning Detector Example")
print("=" * 80)
print("\nThis example will:")
print("  1. Create a set of related memories about Caroline")
print("  2. Detect causal and temporal relationships between them")
print("  3. Infer new knowledge through reasoning chains")
print("  4. Generate aggregate concepts")
print("=" * 80)

current_dir = os.path.dirname(os.path.abspath(__file__))
config_dir = os.path.join(current_dir, "../data/config")

# Load the shared tree-text memory configuration
# This includes embedder, graph DB, and LLM configurations
config_path = os.path.join(config_dir, "tree_config_shared_database.json")
with open(config_path) as f:
    config_data = json.load(f)

print(f"\n✓ Loaded configuration from: {config_path}")

# ============================================================================
# Step 1: Initialize Embedder
# ============================================================================
print("\n[Step 1] Initializing embedder...")

embedder_config = EmbedderConfigFactory.model_validate(config_data["embedder"])
embedder = EmbedderFactory.from_config(embedder_config)

print(f"✓ Embedder initialized: {embedder_config.backend}")

# ============================================================================
# Step 2: Initialize Graph Store
# ============================================================================
print("\n[Step 2] Initializing graph database...")

# Load graph database configuration from the config file
graph_config = GraphDBConfigFactory(**config_data["graph_db"])
graph_store = GraphStoreFactory.from_config(graph_config)

print(f"✓ Graph store initialized: {graph_config.backend}")
print(f"  Connected to: {graph_config.config.get('uri', 'N/A')}")
print(f"  Database: {graph_config.config.get('db_name', 'N/A')}")

# ============================================================================
# Step 3: Initialize LLM
# ============================================================================
print("\n[Step 3] Initializing LLM for relation detection...")

# The LLM analyzes pairs of memories to detect semantic relationships
# (e.g., "causes", "leads to", "happens before", etc.)
# We use the extractor_llm from the config file
llm_config = LLMConfigFactory.model_validate(config_data["extractor_llm"])
llm = LLMFactory.from_config(llm_config)

print(f"✓ LLM initialized: {llm_config.backend}")

# ============================================================================
# Step 4: Create Mock Memory Nodes
# ============================================================================
print("\n[Step 4] Creating mock memory nodes...")
print("  Building a scenario about Caroline's stress and support journey...\n")

# Node A: Caroline's work stress
node_a = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Caroline faced increased workload stress during the project deadline.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,  # Placeholder embedding (real one will be generated)
        key="Workload stress",
        tags=["stress", "workload"],
        type="fact",
        background="Project",
        confidence=0.95,
        updated_at="2024-06-28T09:00:00Z",
    ),
)
# Node B: Improved mental health after joining support group
node_b = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="After joining the support group, Caroline reported improved mental health.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Improved mental health",
        tags=["mental health", "support group"],
        type="fact",
        background="Personal follow-up",
        confidence=0.95,
        updated_at="2024-07-10T12:00:00Z",
    ),
)
print("  ✓ Node B: Improved mental health")

# Node C: General research about support groups
node_c = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Peer support groups are effective in reducing stress for LGBTQ individuals.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Support group benefits",
        tags=["LGBTQ", "support group", "stress"],
        type="fact",
        background="General research",
        confidence=0.95,
        updated_at="2024-06-29T14:00:00Z",
    ),
)
print("  ✓ Node C: Support group benefits")

# Node D: Work pressure → stress (causal chain element)
node_d = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Excessive work pressure increases stress levels among employees.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Work pressure impact",
        tags=["stress", "work pressure"],
        type="fact",
        background="Workplace study",
        confidence=0.9,
        updated_at="2024-06-15T08:00:00Z",
    ),
)
print("  ✓ Node D: Work pressure → stress")

# Node E: Stress → poor sleep (causal chain element)
node_e = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="High stress levels often result in poor sleep quality.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Stress and sleep",
        tags=["stress", "sleep"],
        type="fact",
        background="Health study",
        confidence=0.9,
        updated_at="2024-06-18T10:00:00Z",
    ),
)
print("  ✓ Node E: Stress → poor sleep")

# Node F: Poor sleep → low performance (causal chain element)
node_f = GraphDBNode(
    id=str(uuid.uuid4()),
    memory="Employees with poor sleep show reduced work performance.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=[0.1] * 10,
        key="Sleep and performance",
        tags=["sleep", "performance"],
        type="fact",
        background="HR report",
        confidence=0.9,
        updated_at="2024-06-20T12:00:00Z",
    ),
)
print("  ✓ Node F: Poor sleep → low performance")

# Main Node: The central fact we want to analyze
# This node will be used as the "anchor" to find related memories
node = GraphDBNode(
    id="a88db9ce-3c77-4e83-8d61-aa9ef95c957e",
    memory="Caroline joined an LGBTQ support group to cope with work-related stress.",
    metadata=TreeNodeTextualMemoryMetadata(
        memory_type="LongTermMemory",
        embedding=embedder.embed(
            ["Caroline joined an LGBTQ support group to cope with work-related stress."]
        )[0],  # Generate real embedding for the main node
        key="Caroline LGBTQ stress",
        tags=["LGBTQ", "support group", "stress"],
        type="fact",
        background="Personal",
        confidence=0.95,
        updated_at="2024-07-01T10:00:00Z",
    ),
)
print("  ✓ Main Node: Caroline's support group action\n")

# ============================================================================
# Step 5: Insert Nodes into Graph Store
# ============================================================================
print("[Step 5] Inserting all nodes into graph database...")

all_nodes = [node, node_a, node_b, node_c, node_d, node_e, node_f]
for n in all_nodes:
    graph_store.add_node(n.id, n.memory, n.metadata.dict())

print(f"✓ Successfully inserted {len(all_nodes)} memory nodes into the graph\n")

# ============================================================================
# Step 6: Initialize Relation & Reasoning Detector
# ============================================================================
print("[Step 6] Initializing RelationAndReasoningDetector...")

relation_detector = RelationAndReasoningDetector(
    graph_store=graph_store,
    llm=llm,
    embedder=embedder,
)

print("✓ Detector initialized and ready\n")

# ============================================================================
# Step 7: Run Relation Detection & Reasoning
# ============================================================================
print("[Step 7] Running relation detection and reasoning...")
print(f"  Analyzing relationships for: '{node.memory[:60]}...'\n")

# This will:
# 1. Find semantically similar nodes using embeddings
# 2. Detect pairwise relations (causal, temporal, etc.) using LLM
# 3. Infer new facts through multi-hop reasoning
# 4. Generate aggregate concepts
# 5. Identify sequential patterns
results = relation_detector.process_node(
    node=node,
    exclude_ids=[node.id],  # Don't compare the node with itself
    top_k=5,  # Consider top 5 most similar nodes
)

print("✓ Analysis complete!\n")

# ============================================================================
# Step 8: Display Results
# ============================================================================
print("=" * 80)
print("ANALYSIS RESULTS")
print("=" * 80)

# Display detected pairwise relations
print("\n📊 [1] Detected Pairwise Relations")
print("-" * 80)
if results["relations"]:
    for idx, rel in enumerate(results["relations"], 1):
        print(f"\n  Relation #{idx}:")
        print(f"    Source: {rel['source_id'][:8]}...")
        print(f"    Target: {rel['target_id'][:8]}...")
        print(f"    Type: {rel['relation_type']}")
else:
    print("  ❌ No pairwise relations detected")
    print("     Try adjusting similarity threshold or adding more related nodes")

# Display inferred new facts
print("\n\n💡 [2] Inferred New Facts (through reasoning)")
print("-" * 80)
if results["inferred_nodes"]:
    for idx, inferred_node in enumerate(results["inferred_nodes"], 1):
        print(f"\n  Inferred Fact #{idx}:")
        print(f"    💬 {inferred_node.memory}")
        print(f"    📌 Sources: {inferred_node.metadata.sources}")
        print(f"    🏷️  Key: {inferred_node.metadata.key}")
else:
    print("  ℹ️  No new facts inferred")
    print("     This is normal if relations are simple or insufficient for reasoning")

# Display sequence links (temporal ordering)
print("\n\n⏱️  [3] Sequence Links (FOLLOWS relationships)")
print("-" * 80)
if results["sequence_links"]:
    for idx, link in enumerate(results["sequence_links"], 1):
        print(f"  {idx}. {link['from_id'][:8]}... → {link['to_id'][:8]}...")
else:
    print("  ℹ️  No sequential patterns detected")

# Display aggregate concepts
print("\n\n🎯 [4] Aggregate Concepts")
print("-" * 80)
if results["aggregate_nodes"]:
    for idx, agg in enumerate(results["aggregate_nodes"], 1):
        print(f"\n  Concept #{idx}:")
        print(f"    📖 {agg.memory}")
        print(f"    🔑 Key: {agg.metadata.key}")
        print(f"    📎 Aggregates from: {agg.metadata.sources}")
else:
    print("  ℹ️  No aggregate concepts generated")
    print("     Aggregates are created when multiple related memories share themes")

print("\n" + "=" * 80)
print("Example completed successfully!")
print("=" * 80)
print("\n💡 Next steps:")
print("  - Modify the mock memories to test different scenarios")
print("  - Adjust top_k parameter to control how many neighbors are considered")
print("  - Experiment with different LLM models for relation detection")
print("  - Check the Neo4j database to visualize the created graph\n")

print("\n=== Aggregate Concepts ===")
if not results["aggregate_nodes"]:
    print("No aggregate concepts generated.")
else:
    for agg in results["aggregate_nodes"]:
        print(f"  Concept Key: {agg.metadata.key}")
        print(f"  Concept Memory: {agg.memory}")
        print(f"  Sources: {agg.metadata.sources}")
        print("------")
