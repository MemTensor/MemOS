import csv
import json
import os
import re
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
from eval.eval_score import eval_acc_and_f1, eval_score, show_results
from eval.extract_answer import extract_answer
from tqdm import tqdm

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


load_dotenv()
openapi_config = {
    "model_name_or_path": "gpt-4o",
    "top_k": 50,
    "remove_think_prefix": True,
    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
}
neo4j_uri = os.getenv("NEO4J_URI", "bolt://47.117.41.207:7687")
db_name = "stx-mmlongbench-004"

doc_paths = [
    f
    for f in os.listdir("evaluation/data/mmlongbench/documents")
    if os.path.isfile(os.path.join("evaluation/data/mmlongbench/documents", f))
]

with open("evaluation/data/mmlongbench/samples.json") as f:
    samples = json.load(f)

RESULTS_PATH = "evaluation/data/mmlongbench/test_results.json"
completed_pairs: set[tuple[str, str]] = set()


def _load_existing_results():
    global completed_pairs
    if os.path.exists(RESULTS_PATH):
        try:
            with open(RESULTS_PATH, encoding="utf-8") as f:
                existing = json.load(f)
            for r in existing:
                did = r.get("doc_id")
                q = r.get("question")
                if did and q:
                    completed_pairs.add((did, q))
            return existing
        except Exception:
            return []
    return []


def _doc_has_pending(doc_file: str) -> bool:
    for s in samples:
        if s.get("doc_id") == doc_file and (doc_file, s.get("question")) not in completed_pairs:
            return True
    return False


def get_user_name(doc_file):
    csv_path = "evaluation/data/mmlongbench/user_doc_map.csv"
    if os.path.exists(csv_path):
        with open(csv_path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            for row in reader:
                uid, path = row[0], row[1]
                base = os.path.basename(path)
                if base == doc_file or os.path.splitext(base)[0] == os.path.splitext(doc_file)[0]:
                    return uid
    return ""


def process_doc(doc_file):
    user_name = get_user_name(doc_file)
    print(user_name, doc_file)
    config = {
        "user_id": user_name,
        "chat_model": {
            "backend": "openai",
            "config": openapi_config,
        },
        "mem_reader": {
            "backend": "simple_struct",
            "config": {
                "llm": {"backend": "openai", "config": openapi_config},
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

    mem_cube_config = GeneralMemCubeConfig.model_validate(
        {
            "user_id": user_name,
            "cube_id": user_name,
            "text_mem": {
                "backend": "tree_text",
                "config": {
                    "extractor_llm": {"backend": "openai", "config": openapi_config},
                    "dispatcher_llm": {"backend": "openai", "config": openapi_config},
                    "graph_db": {
                        "backend": "neo4j",
                        "config": {
                            "uri": neo4j_uri,
                            "user": "neo4j",
                            "password": "iaarlichunyu",
                            "db_name": db_name,
                            "user_name": user_name,
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
        }
    )
    mem_cube = GeneralMemCube(mem_cube_config)

    temp_dir = "tmp/" + doc_file
    if not os.path.exists(temp_dir) or not os.listdir(temp_dir):
        mem_cube.dump(temp_dir)

    mos.register_mem_cube(temp_dir, mem_cube_id=user_name)

    with open("evaluation/scripts/mmlongbench/eval/prompt_for_answer_extraction.md") as f:
        prompt = f.read()

    samples_res = []
    doc_samples = [s for s in samples if s.get("doc_id") == doc_file]
    if len(doc_samples) == 0:
        return []

    for sample in tqdm(doc_samples, desc=f"Processing {doc_file}"):
        if (doc_file, sample.get("question")) in completed_pairs:
            continue
        messages = sample["question"]
        try_cnt, is_success = 0, False

        while True:
            try:
                mos.clear_messages()
                response = mos.chat(messages, user_name)
                is_success = True
            except Exception as e:
                print(f"[{doc_file}] Error:", e)
                traceback.print_exc()
                try_cnt += 1
                response = "Failed"
            if is_success or try_cnt > 5:
                break

        sample["response"] = response
        extracted_res = extract_answer(sample["question"], response, prompt)
        sample["extracted_res"] = extracted_res

        pred_ans = extracted_res.split("Answer format:")[0].split("Extracted answer:")[1].strip()
        score = eval_score(sample["answer"], pred_ans, sample["answer_format"])

        sample["pred"] = pred_ans
        sample["score"] = score
        samples_res.append(sample)

        print("--------------------------------------")
        print(f"Question: {sample['question']}")
        print(f"Response: {sample['response']}")
        print(f"Ground true: {sample['answer']}\tPred: {sample['pred']}\tScore: {sample['score']}")

    return samples_res


if __name__ == "__main__":
    results = _load_existing_results()
    total_samples = len(samples)
    processed_samples = len(completed_pairs)
    pending_samples = total_samples - processed_samples
    sample_doc_ids = [s.get("doc_id") for s in samples if s.get("doc_id")]
    all_docs_in_samples = set(sample_doc_ids)
    processed_docs = {d for d, _ in completed_pairs}
    with ThreadPoolExecutor(max_workers=4) as executor:
        pending_docs = [d for d in doc_paths if _doc_has_pending(d)]
        print("\n" + "=" * 80)
        print("📊 评测进度统计")
        print("=" * 80)
        print(f"✅ 已加载历史结果: {len(results)} 条")
        print(f"📂 数据集总样本: {total_samples}")
        print(f"🧪 已完成样本: {processed_samples}")
        print(f"⏳ 待处理样本: {pending_samples}")
        print(f"📄 数据集中总文档: {len(all_docs_in_samples)}")
        print(f"✔️ 已完成文档: {len(processed_docs)}")
        print(f"➡️ 待处理文档(本次将运行): {len(pending_docs)}")
        print("=" * 80 + "\n")
        future_to_doc = {
            executor.submit(process_doc, doc_file): doc_file for doc_file in pending_docs
        }

        for future in as_completed(future_to_doc):
            doc_file = future_to_doc[future]
            try:
                res = future.result()
                results.extend(res)

                if len(res) > 0:
                    acc, f1 = eval_acc_and_f1(results)
                    print()
                    print(f"Avg acc: {acc}")
                    print(f"Avg f1: {f1}")

                with open(RESULTS_PATH, "w", encoding="utf-8") as f:
                    json.dump(results, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[{doc_file}] failed with {e}")

    acc, f1 = eval_acc_and_f1(results)
    print("--------------------------------------")
    print(f"Final avg acc: {acc}")
    print(f"Final avg f1: {f1}")

    show_results(
        results,
        show_path=re.sub(r"\.json$", ".txt", "evaluation/data/mmlongbench/test_results_report.txt"),
    )
