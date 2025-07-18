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
import argparse
import json
import re

from eval.eval_score import eval_acc_and_f1, eval_score, show_results
from eval.extract_answer import extract_answer
from tqdm import tqdm


cached_image_list = dict()


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
# 1.2 Set neo4j config
neo4j_uri = os.getenv("NEO4J_URI", "bolt://47.117.41.207:7687")

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
                "graph_db": {
                    "backend": "neo4j",
                    "config": {
                        "uri": neo4j_uri,
                        "user": "neo4j",
                        "password": "12345678",
                        "db_name": f"db{user_name.replace('-', '')}",
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

mos.add(doc_path="examples/data")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input_path", type=str, default="MMLongBench-Doc/data/samples.json")
    parser.add_argument("--document_path", type=str, default="MMLongBench-Doc/data/documents")
    parser.add_argument("--model_name", type=str, default="gpt-4o")
    parser.add_argument("--max_pages", type=int, default=120)
    parser.add_argument("--resolution", type=int, default=144)
    parser.add_argument("--max_try", type=int, default=10)
    parser.add_argument("--max_tokens", type=int, default=1024)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument(
        "--extractor_prompt_path",
        type=str,
        default="MMLongBench-Doc/eval/prompt_for_answer_extraction.md",
    )
    args = parser.parse_args()

    args.output_path = "MMLongBench-Doc/res.json"

    with open(args.extractor_prompt_path) as f:
        prompt = f.read()
    if os.path.exists(args.output_path):
        with open(args.output_path) as f:
            samples = json.load(f)
    else:
        with open(args.input_path) as f:
            samples = json.load(f)

    for sample in tqdm(samples):
        if sample["evidence_sources"] != "['Pure-text (Plain-text)']":
            continue

        messages = sample["question"]

        try_cnt = 0
        is_success = False
        while True:
            try:
                mos.clear_messages()
                response = mos.chat(messages)
                is_success = True
            except:
                try_cnt += 1
                response = "Failed"
            if is_success or try_cnt > args.max_try:
                break

        sample["response"] = response
        extracted_res = extract_answer(sample["question"], response, prompt)
        sample["extracted_res"] = extracted_res
        # try:
        print("llm res:", extracted_res)
        pred_ans = extracted_res.split("Answer format:")[0].split("Extracted answer:")[1].strip()
        score = eval_score(sample["answer"], pred_ans, sample["answer_format"])
        # except:
        #     pred_ans = "Failed to extract"
        #     score = 0.0
        sample["pred"] = pred_ans
        sample["score"] = score

        acc, f1 = eval_acc_and_f1(samples)
        print("--------------------------------------")
        print("Question: {}".format(sample["question"]))
        print("Response: {}".format(sample["response"]))
        print(
            "Gt: {}\tPred: {}\tScore: {}".format(sample["answer"], sample["pred"], sample["score"])
        )
        print(f"Avg acc: {acc}")
        print(f"Avg f1: {f1}")

        with open(args.output_path, "w") as f:
            json.dump(samples, f)

    show_results(samples, show_path=re.sub("\.json$", ".txt", args.output_path))
