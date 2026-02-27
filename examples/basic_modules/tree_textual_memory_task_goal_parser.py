"""
Tree Textual Memory Task Goal Parser Example
=============================================

This example demonstrates how to use MemOS's TaskGoalParser to parse natural
language queries into structured retrieval goals.

**What you'll learn:**
- How to initialize an LLM for task parsing
- How to parse a natural language query into structured components
- The difference between "fast" and "fine" parsing modes
- How the parser extracts memories, keys, tags, and goal types

**Use case:**
When a user asks "When did Caroline go to the LGBTQ support group?", you need to:
1. Extract semantic descriptions (memories to look for)
2. Identify key phrases and keywords
3. Determine relevant tags for filtering
4. Classify the goal type (retrieval, update, etc.)

The TaskGoalParser does this automatically using an LLM.

Run this example:
    python examples/basic_modules/tree_textual_memory_task_goal_parser.py
"""

import json
import os
import time

from memos import log
from memos.configs.llm import LLMConfigFactory
from memos.llms.factory import LLMFactory
from memos.memories.textual.tree_text_memory.retrieve.task_goal_parser import TaskGoalParser


logger = log.get_logger(__name__)

# ============================================================================
# Step 0: Setup - Load configuration files
# ============================================================================
print("=" * 80)
print("Tree Textual Memory Task Goal Parser Example")
print("=" * 80)

current_dir = os.path.dirname(os.path.abspath(__file__))
config_dir = os.path.join(current_dir, "../data/config")

# Load the shared tree-text memory configuration
config_path = os.path.join(config_dir, "tree_config_shared_database.json")
with open(config_path) as f:
    config_data = json.load(f)

print(f"\n✓ Loaded configuration from: {config_path}")

# ============================================================================
# Step 1: Initialize LLM for Task Parsing
# ============================================================================
print("\n[Step 1] Initializing LLM for task goal parsing...")

# The LLM will analyze the natural language query and extract structured information
# We use the extractor_llm from the config file
llm_config = LLMConfigFactory.model_validate(config_data["extractor_llm"])
llm = LLMFactory.from_config(llm_config)

print(f"✓ LLM initialized: {llm_config.backend}")

# ============================================================================
# Step 2: Define a natural language task/query
# ============================================================================
# This is the user's question that needs to be parsed
task = "When did Caroline go to the LGBTQ support group?"

print("\n[Step 2] Task to parse:")
print(f"  📝 '{task}'")
print()

# ============================================================================
# Step 3: Parse using FAST mode
# ============================================================================
print("[Step 3] Parsing with FAST mode...")
print("  (Fast mode uses a simpler prompt for quick parsing)")

parser = TaskGoalParser(llm)

time_start = time.time()
result_fast = parser.parse(task, mode="fast")
time_fast = time.time() - time_start

print(f"✓ Fast mode parsing completed in {time_fast:.3f}s\n")

# Display fast mode results
print("=" * 80)
print("FAST MODE RESULTS")
print("=" * 80)
print("\n📋 Memories (semantic descriptions):")
if result_fast.memories:
    for idx, mem in enumerate(result_fast.memories, 1):
        print(f"  {idx}. {mem}")
else:
    print("  (None extracted)")

print("\n🔑 Keys (important keywords):")
if result_fast.keys:
    for idx, key in enumerate(result_fast.keys, 1):
        print(f"  {idx}. {key}")
else:
    print("  (None extracted)")

print("\n🏷️  Tags (categorical labels):")
if result_fast.tags:
    print(f"  {', '.join(result_fast.tags)}")
else:
    print("  (None extracted)")

print(f"\n🎯 Goal Type: {result_fast.goal_type}")
print(f"⏱️  Processing Time: {time_fast:.3f}s")

# ============================================================================
# Step 4: Parse using FINE mode
# ============================================================================
print(f"\n{'=' * 80}")
print("[Step 4] Parsing with FINE mode...")
print("  (Fine mode uses more detailed prompts for better accuracy)")

time_start = time.time()
result_fine = parser.parse(task, mode="fine")
time_fine = time.time() - time_start

print(f"✓ Fine mode parsing completed in {time_fine:.3f}s\n")

# Display fine mode results
print("=" * 80)
print("FINE MODE RESULTS")
print("=" * 80)
print("\n📋 Memories (semantic descriptions):")
if result_fine.memories:
    for idx, mem in enumerate(result_fine.memories, 1):
        print(f"  {idx}. {mem}")
else:
    print("  (None extracted)")

print("\n🔑 Keys (important keywords):")
if result_fine.keys:
    for idx, key in enumerate(result_fine.keys, 1):
        print(f"  {idx}. {key}")
else:
    print("  (None extracted)")

print("\n🏷️  Tags (categorical labels):")
if result_fine.tags:
    print(f"  {', '.join(result_fine.tags)}")
else:
    print("  (None extracted)")

print(f"\n🎯 Goal Type: {result_fine.goal_type}")
print(f"⏱️  Processing Time: {time_fine:.3f}s")

# ============================================================================
# Step 5: Compare Results
# ============================================================================
print(f"\n{'=' * 80}")
print("COMPARISON")
print("=" * 80)
print("\nSpeed:")
print(f"  Fast mode: {time_fast:.3f}s")
print(f"  Fine mode: {time_fine:.3f}s")
print(f"  Difference: {abs(time_fast - time_fine):.3f}s")

print("\nExtracted Components:")
print(
    f"  Fast mode: {len(result_fast.memories)} memories, {len(result_fast.keys)} keys, {len(result_fast.tags)} tags"
)
print(
    f"  Fine mode: {len(result_fine.memories)} memories, {len(result_fine.keys)} keys, {len(result_fine.tags)} tags"
)

print(f"\n{'=' * 80}")
print("Example completed successfully!")
print("=" * 80)
print("\n💡 Next steps:")
print("  - Try different queries to see how the parser handles various inputs")
print("  - Use the parsed result as input for GraphMemoryRetriever")
print("  - Experiment with 'fast' vs 'fine' mode based on your accuracy/speed needs")
print("  - The parsed ParsedTaskGoal can be passed directly to retrieval functions\n")
