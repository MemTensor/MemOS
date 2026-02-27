from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.memory import MemoryConfigFactory
from memos.mem_cube.general import GeneralMemCube
from memos.memories.factory import MemoryFactory


config = GeneralMemCubeConfig.model_validate(
    {
        "user_id": "test_user",
        "cube_id": "test_cube",
        "text_mem": {},  # This can be loaded lazily
        "act_mem": {},  # This can be loaded lazily
        "para_mem": {},  # This can be loaded lazily
    }
)

# Load a MemCube
mem_cube = GeneralMemCube(config)

# Load the text memory lazily
mem_cube.text_mem = MemoryFactory.from_config(
    MemoryConfigFactory(
        backend="naive_text",
        config={
            "extractor_llm": {
                "backend": "ollama",
                "config": {
                    "model_name_or_path": "qwen3:0.6b",
                    "temperature": 0.0,
                    "remove_think_prefix": True,
                },
            }
        },
    )
)

# Print all items in the text memory
print(mem_cube.text_mem.get_all())

# This will raise AttributeError: 'NoneType' object has no attribute 'xxx'
print(f"mem_cube.act_mem = {mem_cube.act_mem}")
print(mem_cube.act_mem.get_all())
