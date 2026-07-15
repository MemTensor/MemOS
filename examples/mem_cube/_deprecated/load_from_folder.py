from memos.mem_cube.general import GeneralMemCube


# Load a MemCube from a directory
mem_cube = GeneralMemCube.init_from_dir("examples/data/mem_cube_2")

# Print all items in the text memory
textual_memory_items = mem_cube.text_mem.get_all()
for memory_item in textual_memory_items:
    print(memory_item)
    print()

# Print all items in the activation memory
activation_memory_items = mem_cube.act_mem.get_all()
for memory_item in activation_memory_items:
    print(memory_item)
    print()

# Dump the memories to a specified directory with MemCube structure
mem_cube.dump("tmp/mem_cube")
