"""
MemCube persistence example.

This example demonstrates how to use GeneralMemCube.dump() to save
a statically loaded MemCube to disk.

Important Notes:
- dump() saves the GeneralMemCube object's memory data
- If SingleCubeView wraps the same memory instances (e.g., loaded_naive wraps general's text_mem),
  then View-added memories WILL be included in dump()
- If SingleCubeView uses separate memory instances, then View-added memories will NOT be dumped
- See load_cube.py for an example where View operations persist via dump()
- GeneralMemCube is primarily used for static data persistence;
  for runtime operations, use the View architecture

Usage:
    python examples/mem_cube/dump_cube.py
"""

import os
import shutil

from memos.mem_cube.general import GeneralMemCube


# ===========================================================================
# Load existing MemCube
# ===========================================================================
print("=" * 80)
print("Step 1: Loading MemCube from directory")
print("=" * 80)

mem_cube = GeneralMemCube.init_from_dir("examples/data/mem_cube_2")

print(f"✓ Cube ID: {mem_cube.config.cube_id}")
print(f"✓ User ID: {mem_cube.config.user_id}")

# ===========================================================================
# Check current memory statistics
# ===========================================================================
print("\n" + "=" * 80)
print("Step 2: Memory statistics")
print("=" * 80)

# Get memory items (with safe checks for get_all availability)
# Note: text_mem.get_all() returns dict {"nodes": [...], "edges": [...]}
text_data = (
    mem_cube.text_mem.get_all()
    if mem_cube.text_mem and hasattr(mem_cube.text_mem, "get_all")
    else {}
)
text_nodes = text_data.get("nodes", []) if isinstance(text_data, dict) else []
act_items = (
    mem_cube.act_mem.get_all() if mem_cube.act_mem and hasattr(mem_cube.act_mem, "get_all") else []
)
# Note: LoRAMemory does NOT have get_all() method
para_items = (
    mem_cube.para_mem.get_all()
    if mem_cube.para_mem and hasattr(mem_cube.para_mem, "get_all")
    else []
)
# Note: PreferenceMemory.get_all() returns dict {"explicit_preference": [...], "implicit_preference": [...]}
pref_data = (
    mem_cube.pref_mem.get_all()
    if mem_cube.pref_mem and hasattr(mem_cube.pref_mem, "get_all")
    else {}
)
pref_count = (
    sum(len(v) for v in pref_data.values())
    if isinstance(pref_data, dict)
    else len(pref_data)
    if pref_data
    else 0
)

print(f"  - Text memories: {len(text_nodes)} nodes")
print(f"  - Activation memories: {len(act_items)}")
print(f"  - Parametric memories: {len(para_items) if para_items else 'N/A (no get_all)'}")
print(f"  - Preference memories: {pref_count}")

# Show sample text memory content
if text_nodes:
    print("\n  Sample text memories (showing first 2):")
    for i, node in enumerate(text_nodes[:2], 1):
        memory_text = node.get("memory", str(node))[:100]
        print(f"    [{i}] {memory_text}...")

# ===========================================================================
# Persist to new directory
# ===========================================================================
print("\n" + "=" * 80)
print("Step 3: Dumping MemCube to disk")
print("=" * 80)

output_dir = "tmp/mem_cube_dump"
print(f"Output directory: {output_dir}")

# Clean up existing directory if it exists to avoid MemCubeError on second run
if os.path.exists(output_dir):
    print(f"⚠  Directory {output_dir} already exists, removing it...")
    shutil.rmtree(output_dir)

mem_cube.dump(output_dir)

# ===========================================================================
# Verify dump output
# ===========================================================================
print("\n" + "=" * 80)
print("Step 4: Verifying dump output")
print("=" * 80)

if os.path.exists(output_dir):
    print("✓ Dump successful!")
    print("\nGenerated files:")

    for root, _dirs, files in os.walk(output_dir):
        level = root.replace(output_dir, "").count(os.sep)
        indent = "  " * level
        print(f"{indent}{os.path.basename(root)}/")
        sub_indent = "  " * (level + 1)
        for file in files:
            print(f"{sub_indent}{file}")

    print("\n✓ You can load this dump using:")
    print(f"   mem_cube = GeneralMemCube.init_from_dir('{output_dir}')")
else:
    print("✗ Dump failed - output directory not found")

# ===========================================================================
# Summary
# ===========================================================================
print("\n" + "=" * 80)
print("✅ Dump example completed!")
print("=" * 80)
print("\n📝 Key Points:")
print("  1. GeneralMemCube.dump() saves the current state to disk")
print("  2. The dump includes: config.json + memory directories")
print("  3. If View wraps the same memory instances, View-added memories ARE saved")
print("  4. See load_cube.py for an example where View operations persist via dump()")
print("  5. Use dump() for creating portable MemCube snapshots")
print("\n" + "=" * 80)
