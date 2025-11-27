import json
import os
import uuid

from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
from tqdm import tqdm

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


load_dotenv()

db_name = "stx-hotpot-001"


user_name = str(uuid.uuid4())

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
# you can set PRO_MODE to True to enable CoT enhancement mos_config.PRO_MODE = True
mos = MOS(mos_config)


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
                "graph_db": {
                    "backend": "neo4j",
                    "config": {
                        "uri": neo4j_uri,
                        "user": "neo4j",
                        "password": "iaarlichunyu",
                        "db_name": db_name,
                        "auto_create": True,
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
                "reorganize": True,
            },
        },
        "act_mem": {},
        "para_mem": {},
    },
)

mem_cube = GeneralMemCube(config)


mos.register_mem_cube(f"/tmp/{user_name}", mem_cube_id=user_name)


with open("evaluation/data/hotpot/hotpot_dev_distractor_v1.json") as f:
    data = json.load(f)


def build_context_text(context_list):
    parts = []
    for title, sentences in context_list:
        text = " ".join(s.strip() for s in sentences if s.strip())
        parts.append(f"{title}: {text}")
    return "\n".join(parts)


def build_and_ask(item):
    qid = item["_id"]
    question = item["question"]

    for title, sentences in item["context"]:
        text = " ".join(s.strip() for s in sentences if s.strip())
        memory_content = f"{title}: {text}"
        mos.add(memory_content=memory_content)

    answer = mos.chat(question).strip()
    return qid, answer


pred_answers = {}

with ThreadPoolExecutor(max_workers=5) as executor:
    futures = {executor.submit(build_and_ask, item): item for item in data}
    for future in tqdm(as_completed(futures), total=len(futures)):
        try:
            qid, answer = future.result()
            pred_answers[qid] = answer
        except Exception as e:
            print(f"Error: {e}")

predictions = {"answer": pred_answers, "sp": []}

with open("evaluation/data/hotpot/output/dev_distractor_pred.json", "w") as f:
    json.dump(predictions, f, ensure_ascii=False, indent=2)
