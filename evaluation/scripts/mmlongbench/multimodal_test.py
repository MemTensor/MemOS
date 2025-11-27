import os
import shutil

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


load_dotenv()

db_name = "stx-mmlongbench-002"
user_id = "user_dc812220"

# 1.1 Set openai config
openapi_config = {
    "model_name_or_path": "gpt-4o",
    "top_k": 50,
    "remove_think_prefix": True,
    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
}
# 1.2 Set neo4j config
neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")

# 1.3  Create MOS Config
config = {
    "user_id": user_id,
    "chat_model": {
        "backend": "openai",
        "config": openapi_config,
    },
    "mem_reader": {
        "backend": "simple_struct",
        "config": {
            "llm": {
                "backend": "openai",
                "config": openapi_config,
            },
            "embedder": {
                "backend": "universal_api",
                "config": {
                    "provider": "openai",
                    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
                    "model_name_or_path": "text-embedding-3-large",
                    "base_url": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
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

config = GeneralMemCubeConfig.model_validate(
    {
        "user_id": user_id,
        "cube_id": f"{user_id}",
        "text_mem": {
            "backend": "tree_text",
            "config": {
                "extractor_llm": {
                    "backend": "openai",
                    "config": openapi_config,
                },
                "dispatcher_llm": {
                    "backend": "openai",
                    "config": openapi_config,
                },
                "graph_db": {
                    "backend": "neo4j",
                    "config": {
                        "uri": neo4j_uri,
                        "user": "neo4j",
                        "password": "iaarlichunyu",
                        "db_name": db_name,
                        "user_name": user_id,
                        "use_multi_db": False,
                        "auto_create": True,
                        "embedding_dimension": 3072,
                    },
                },
                "embedder": {
                    "backend": "universal_api",
                    "config": {
                        "provider": "openai",
                        "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
                        "model_name_or_path": "text-embedding-3-large",
                        "base_url": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
                    },
                },
                "reorganize": False,
            },
        },
        "act_mem": {},
        "para_mem": {},
    },
)


# Filter out embedding fields, keeping only necessary fields
def filter_memory_data(memories_data):
    filtered_data = {}
    for key, value in memories_data.items():
        if key == "text_mem":
            filtered_data[key] = []
            for mem_group in value:
                # Check if it's the new data structure (list of TextualMemoryItem objects)
                if "memories" in mem_group and isinstance(mem_group["memories"], list):
                    # New data structure: directly a list of TextualMemoryItem objects
                    filtered_memories = []
                    for memory_item in mem_group["memories"]:
                        # Create filtered dictionary
                        filtered_item = {
                            "id": memory_item.id,
                            "memory": memory_item.memory,
                            "metadata": {},
                        }
                        # Filter metadata, excluding embedding
                        if hasattr(memory_item, "metadata") and memory_item.metadata:
                            for attr_name in dir(memory_item.metadata):
                                if not attr_name.startswith("_") and attr_name != "embedding":
                                    attr_value = getattr(memory_item.metadata, attr_name)
                                    if not callable(attr_value):
                                        filtered_item["metadata"][attr_name] = attr_value
                        filtered_memories.append(filtered_item)

                    filtered_group = {
                        "cube_id": mem_group.get("cube_id", ""),
                        "memories": filtered_memories,
                    }
                    filtered_data[key].append(filtered_group)
                else:
                    # Old data structure: dictionary with nodes and edges
                    filtered_group = {
                        "memories": {"nodes": [], "edges": mem_group["memories"].get("edges", [])}
                    }
                    for node in mem_group["memories"].get("nodes", []):
                        filtered_node = {
                            "id": node.get("id"),
                            "memory": node.get("memory"),
                            "metadata": {
                                k: v
                                for k, v in node.get("metadata", {}).items()
                                if k != "embedding"
                            },
                        }
                        filtered_group["memories"]["nodes"].append(filtered_node)
                    filtered_data[key].append(filtered_group)
        else:
            filtered_data[key] = value
    return filtered_data


mem_cube = GeneralMemCube(config)

temp_dir = f"/tmp/{user_id}"
if os.path.exists(temp_dir):
    shutil.rmtree(temp_dir)
mem_cube.dump(temp_dir)
mos.register_mem_cube(temp_dir, mem_cube_id=user_id)


print("start answering...")
user_query = "图8美股变化的影响是什么"
print(f"👤 User query: {user_query}")
response = mos.chat(user_query)
print(f"🤖 Response: {response}")
