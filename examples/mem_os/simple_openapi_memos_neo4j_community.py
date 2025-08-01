import os
import time
import uuid

from datetime import datetime

from dotenv import load_dotenv

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


load_dotenv()

# 1. Create MOS Config and set openai config
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to create MOS configuration...")
start_time = time.time()

user_name = str(uuid.uuid4())
print(user_name)

# 1.1 Set openai config
openapi_config = {
    "model_name_or_path": "gpt-4o-mini",
    "temperature": 0.8,
    "max_tokens": 1024,
    "top_p": 0.9,
    "top_k": 50,
    "remove_think_prefix": True,
    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
}
embedder_config = {
    "backend": "universal_api",
    "config": {
        "provider": "openai",
        "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
        "model_name_or_path": "text-embedding-3-large",
        "base_url": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
    },
}
EMBEDDING_DIMENSION = 3072

# 1.2 Set neo4j config
neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")

# 1.3  Create MOS Config
config = {
    "user_id": user_name,
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
            "embedder": embedder_config,
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
# you can set PRO_MODE to True to enable CoT enhancement mos_config.PRO_MODE = True
mos = MOS(mos_config)

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] MOS configuration created successfully, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 2. Initialize memory cube
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to initialize MemCube configuration...")
start_time = time.time()

config = GeneralMemCubeConfig.model_validate(
    {
        "user_id": user_name,
        "cube_id": f"{user_name}",
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
                "embedder": embedder_config,
                "graph_db": {
                    "backend": "neo4j-community",
                    "config": {
                        "uri": neo4j_uri,
                        "user": "neo4j",
                        "password": "12345678",
                        "db_name": "neo4j",
                        "user_name": "alice",
                        "use_multi_db": False,
                        "auto_create": False,
                        "embedding_dimension": EMBEDDING_DIMENSION,
                        "vec_config": {
                            "backend": "qdrant",
                            "config": {
                                "collection_name": "neo4j_vec_db",
                                "vector_dimension": EMBEDDING_DIMENSION,
                                "distance_metric": "cosine",
                                "host": "localhost",
                                "port": 6333,
                            },
                        },
                    },
                },
                "reorganize": True,
            },
        },
        "act_mem": {},
        "para_mem": {},
    },
)

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] MemCube configuration initialization completed, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 3. Initialize the MemCube with the configuration
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to create MemCube instance...")
start_time = time.time()

mem_cube = GeneralMemCube(config)
try:
    mem_cube.dump(f"/tmp/{user_name}/")
    print(
        f"✅ [{datetime.now().strftime('%H:%M:%S')}] MemCube created and saved successfully, time elapsed: {time.time() - start_time:.2f}s\n"
    )
except Exception as e:
    print(
        f"❌ [{datetime.now().strftime('%H:%M:%S')}] MemCube save failed: {e}, time elapsed: {time.time() - start_time:.2f}s\n"
    )

# 4. Register the MemCube
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to register MemCube...")
start_time = time.time()

mos.register_mem_cube(f"/tmp/{user_name}", mem_cube_id=user_name)

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] MemCube registration completed, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 5. Add, get, search memory
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to add single memory...")
start_time = time.time()

mos.add(memory_content="I like playing football.")

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] Single memory added successfully, time elapsed: {time.time() - start_time:.2f}s"
)

print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to get all memories...")
start_time = time.time()

get_all_results = mos.get_all()


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


filtered_results = filter_memory_data(get_all_results)
print(f"Get all results after add memory: {filtered_results['text_mem'][0]['memories']}")

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] Get all memories completed, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 6. Add messages
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to add conversation messages...")
start_time = time.time()

messages = [
    {"role": "user", "content": "I like playing football."},
    {"role": "assistant", "content": "yes football is my favorite game."},
]
mos.add(messages)

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] Conversation messages added successfully, time elapsed: {time.time() - start_time:.2f}s"
)

print(
    f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to get all memories (after adding messages)..."
)
start_time = time.time()

get_all_results = mos.get_all()
filtered_results = filter_memory_data(get_all_results)
print(f"Get all results after add messages: {filtered_results}")

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] Get all memories completed, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 7. Add document
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to add document...")
start_time = time.time()
## 7.1 add pdf for ./tmp/data if use doc mem mos.add(doc_path="./tmp/data/")
start_time = time.time()

get_all_results = mos.get_all()
filtered_results = filter_memory_data(get_all_results)
print(f"Get all results after add doc: {filtered_results}")

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] Get all memories completed, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 8. Search
print(f"🚀 [{datetime.now().strftime('%H:%M:%S')}] Starting to search memories...")
start_time = time.time()

search_results = mos.search(query="my favorite football game", user_id=user_name)
filtered_search_results = filter_memory_data(search_results)
print(f"Search results: {filtered_search_results}")

print(
    f"✅ [{datetime.now().strftime('%H:%M:%S')}] Memory search completed, time elapsed: {time.time() - start_time:.2f}s\n"
)

# 9. Chat
print(f"🎯 [{datetime.now().strftime('%H:%M:%S')}] Starting chat mode...")
while True:
    user_input = input("👤 [You] ").strip()
    if user_input.lower() in ["quit", "exit"]:
        break

    print()
    chat_start_time = time.time()
    response = mos.chat(user_input)
    chat_duration = time.time() - chat_start_time

    print(f"🤖 [Assistant] {response}")
    print(f"⏱️  [Response time: {chat_duration:.2f}s]\n")

print("📢 [System] MemChat has stopped.")
