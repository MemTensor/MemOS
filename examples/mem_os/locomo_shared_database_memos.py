import json
import os

from dotenv import load_dotenv

from memos import log
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.product import MOSProduct


load_dotenv()


logger = log.get_logger(__name__)


# === Load conversation ===
with open("evaluation/data/locomo/locomo10.json", encoding="utf-8") as f:
    conversation = json.load(f)
    data = conversation[3]
    speaker_a = data["conversation"]["speaker_a"]
    speaker_b = data["conversation"]["speaker_b"]
    conversation_i = data["conversation"]

db_name = "shared-db-locomo-case"

openapi_config = {
    "model_name_or_path": "gpt-4o-mini",
    "temperature": 0.8,
    "max_tokens": 1024,
    "api_key": "your-api-key-here",
    "api_base": "https://api.openai.com/v1",
}


# === Create MOS Config ===
def get_user_configs(user_name):
    mos_config = MOSConfig(
        user_id=user_name,
        chat_model={"backend": "openai", "config": openapi_config},
        mem_reader={
            "backend": "simple_struct",
            "config": {
                "llm": {"backend": "openai", "config": openapi_config},
                "embedder": {
                    "backend": "universal_api",
                    "config": {
                        "provider": "openai",
                        "api_key": openapi_config["api_key"],
                        "model_name_or_path": "text-embedding-3-large",
                        "base_url": openapi_config["api_base"],
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
        enable_textual_memory=True,
        enable_activation_memory=False,
        enable_parametric_memory=False,
        top_k=5,
        max_turns_window=20,
    )

    return mos_config


# === Get Memory Cube Config ===
def get_mem_cube_config(user_name):
    neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    neo4j_config = {
        "uri": neo4j_uri,
        "user": "neo4j",
        "password": "12345678",
        "db_name": db_name,
        "user_name": "will be updated",
        "use_multi_db": False,
        "embedding_dimension": 3072,
        "auto_create": True,
    }
    cube_config = GeneralMemCubeConfig.model_validate(
        {
            "user_id": user_name,
            "cube_id": f"{user_name}_cube",
            "text_mem": {
                "backend": "tree_text",
                "config": {
                    "extractor_llm": {"backend": "openai", "config": openapi_config},
                    "dispatcher_llm": {"backend": "openai", "config": openapi_config},
                    "graph_db": {"backend": "neo4j", "config": neo4j_config},
                    "embedder": {
                        "backend": "universal_api",
                        "config": {
                            "provider": "openai",
                            "api_key": openapi_config["api_key"],
                            "model_name_or_path": "text-embedding-3-large",
                            "base_url": openapi_config["api_base"],
                        },
                    },
                    "reorganize": True,
                },
            },
        }
    )

    mem_cube = GeneralMemCube(cube_config)
    return mem_cube


# === Initialize MOSProduct ===
root_config = get_user_configs(user_name="system")
mos_product = MOSProduct(default_config=root_config)


# === Register both users ===
users = {}
for speaker in [speaker_a, speaker_b]:
    user_id = speaker.lower() + "_test"
    config = get_user_configs(user_id)
    mem_cube = get_mem_cube_config(user_id)
    result = mos_product.user_register(
        user_id=user_id,
        user_name=speaker,
        interests=f"I'm {speaker}",
        default_mem_cube=mem_cube,
    )
    users[speaker] = {"user_id": user_id, "default_cube_id": result["default_cube_id"]}
    print(f"✅ Registered: {speaker} -> {result}")

# === Process conversation, add to both roles ===
i = 1
MAX_CONVERSATION_FOR_TEST = 3
while (
    f"session_{i}_date_time" in conversation_i and f"session_{i}" in conversation_i
) and i < MAX_CONVERSATION_FOR_TEST:
    session_i = conversation_i[f"session_{i}"]
    session_time = conversation_i[f"session_{i}_date_time"]

    print(f"\n=== Processing Session {i} | Time: {session_time} ===")

    role1_msgs, role2_msgs = [], []

    for m in session_i:
        if m["speaker"] == speaker_a:
            role1_msgs.append(
                {
                    "role": "user",
                    "content": f"{m['speaker']}:{m['text']}",
                    "chat_time": session_time,
                }
            )
            role2_msgs.append(
                {
                    "role": "assistant",
                    "content": f"{m['speaker']}:{m['text']}",
                    "chat_time": session_time,
                }
            )
        elif m["speaker"] == speaker_b:
            role1_msgs.append(
                {
                    "role": "assistant",
                    "content": f"{m['speaker']}:{m['text']}",
                    "chat_time": session_time,
                }
            )
            role2_msgs.append(
                {
                    "role": "user",
                    "content": f"{m['speaker']}:{m['text']}",
                    "chat_time": session_time,
                }
            )

    print(f"\n[Session {i}] {speaker_a} will add {len(role1_msgs)} messages.")
    print(f"[Session {i}] {speaker_b} will add {len(role2_msgs)} messages.")

    mos_product.add(
        user_id=users[speaker_a]["user_id"],
        messages=role1_msgs,
        mem_cube_id=users[speaker_a]["default_cube_id"],
    )
    mos_product.add(
        user_id=users[speaker_b]["user_id"],
        messages=role2_msgs,
        mem_cube_id=users[speaker_b]["default_cube_id"],
    )

    print(f"[Session {i}] Added messages for both roles")

    i += 1

print("\n✅ All messages added for both roles.\n")
mos_product.mem_reorganizer_off()
