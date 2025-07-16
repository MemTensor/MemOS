from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


# 1. Create Mos Config
config = {
    "user_id": "user03alice",
    "chat_model": {
        "backend": "huggingface",
        "config": {
            "model_name_or_path": "Qwen/Qwen3-1.7B",
            "temperature": 0.1,
            "remove_think_prefix": True,
            "max_tokens": 4096,
        },
    },
    "mem_reader": {
        "backend": "simple_struct",
        "config": {
            "llm": {
                "backend": "ollama",
                "config": {
                    "model_name_or_path": "qwen3:0.6b",
                    "temperature": 0.0,
                    "remove_think_prefix": True,
                    "max_tokens": 8192,
                },
            },
            "embedder": {
                "backend": "ollama",
                "config": {
                    "model_name_or_path": "nomic-embed-text:latest",
                },
            },
            "chunker": {
                "backend": "sentence",
                "config": {
                    "tokenizer_or_token_counter": "gpt2",
                    "chunk_size": 512,
                    "chunk_overlap": 128,
                    "min_sentences_per_chunk": 1,
                },
            },
        },
    },
    "max_turns_window": 20,
    "top_k": 5,
    "enable_textual_memory": True,
    "enable_activation_memory": False,
    "enable_parametric_memory": False,
}

mos_config = MOSConfig(**config)
mos = MOS(mos_config)

# 2. Initialize_memory_cube
config = GeneralMemCubeConfig.model_validate(
    {
        "user_id": "user03alice",
        "cube_id": "user03alice/mem_cube_tree",
        "text_mem": {
            "backend": "tree_text",
            "config": {
                "extractor_llm": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "qwen3:1.7b",
                        "temperature": 0.0,
                        "remove_think_prefix": True,
                        "max_tokens": 8192,
                    },
                },
                "dispatcher_llm": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "qwen3:1.7b",
                        "temperature": 0.0,
                        "remove_think_prefix": True,
                        "max_tokens": 8192,
                    },
                },
                "graph_db": {
                    "backend": "neo4j",
                    "config": {
                        "uri": "bolt://localhost:7687",
                        "user": "neo4j",
                        "password": "12345678",
                        "db_name": "user03alice11",
                        "auto_create": True,
                    },
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "nomic-embed-text:latest",
                    },
                },
            },
        },
        "act_mem": {
            "backend": "kv_cache",
            "config": {
                "memory_filename": "activation_memory.pickle",
                "extractor_llm": {
                    "backend": "huggingface",
                    "config": {
                        "model_name_or_path": "Qwen/Qwen3-1.7B",
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "top_p": 0.9,
                        "top_k": 50,
                        "add_generation_prompt": True,
                        "remove_think_prefix": False,
                    },
                },
            },
        },
        "para_mem": {
            "backend": "lora",
            "config": {
                "memory_filename": "parametric_memory.adapter",
                "extractor_llm": {
                    "backend": "huggingface",
                    "config": {
                        "model_name_or_path": "Qwen/Qwen3-1.7B",
                        "temperature": 0.8,
                        "max_tokens": 1024,
                        "top_p": 0.9,
                        "top_k": 50,
                        "add_generation_prompt": True,
                        "remove_think_prefix": False,
                    },
                },
            },
        },
    },
)

# 3. Initialize the MemCube with the configuration
mem_cube = GeneralMemCube(config)
try:
    mem_cube.dump("/tmp/user03alice/mem_cube_5")
except Exception as e:
    print(e)

# 4. Register the MemCube explicitly
mos.register_mem_cube("/tmp/user03alice/mem_cube_5", "user03alice")

# 5. add, get, search memory
mos.add(memory_content="I like playing football.")

get_all_results = mos.get_all()
print(f"Get all results after add memory: {get_all_results}")

# 6. add mesaages
messages = [
    {"role": "user", "content": "I like playing football."},
    {"role": "assistant", "content": "yes football is my favorite game."},
]
mos.add(messages)
get_all_results = mos.get_all()
print(f"Get all results after add mesaages: {get_all_results}")

# 6. add doc
mos.add(doc_path="./examples/data")
get_all_results = mos.get_all()
print(f"Get all results after add doc: {get_all_results}")

search_results = mos.search(query="my favorite football game")
print(f"Search results: {search_results}")

# .chat
while True:
    user_input = input("👤 [You] ").strip()
    print()
    response = mos.chat(user_input)
    print(f"🤖 [Assistant] {response}\n")
print("📢 [System] MemChat has stopped.")
