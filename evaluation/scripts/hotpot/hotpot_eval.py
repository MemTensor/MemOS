import importlib.util
import json
import os

from concurrent.futures import ThreadPoolExecutor, as_completed

from datasets import load_dataset
from dotenv import load_dotenv
from tqdm import tqdm

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


load_dotenv()

db_name = "stx-hotpot-001"

openapi_config = {
    "model_name_or_path": "gpt-4o",
    "top_k": 50,
    "remove_think_prefix": True,
    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
}
neo4j_uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
data = load_dataset("hotpotqa/hotpot_qa", "distractor")
base_config = {
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


def init_mos_and_cube(user_name: str) -> MOS:
    cfg = dict(base_config)
    cfg["user_id"] = user_name
    mos_config = MOSConfig(**cfg)
    mos = MOS(mos_config)
    cube_conf = GeneralMemCubeConfig.model_validate(
        {
            "user_id": user_name,
            "cube_id": f"{user_name}",
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
    mem_cube = GeneralMemCube(cube_conf)
    temp_dir = "tmp/" + user_name
    if not os.path.exists(temp_dir) or not os.listdir(temp_dir):
        mem_cube.dump(temp_dir)
    mos.register_mem_cube(temp_dir, mem_cube_id=user_name)
    return mos


def build_context_text(context_list):
    parts = []
    for title, sentences in context_list:
        text = " ".join(s.strip() for s in sentences if s.strip())
        parts.append(f"{title}: {text}")
    return "\n".join(parts)


def build_and_ask(item):
    qid = item.get("_id") or item.get("id")
    question = item["question"]
    mos = init_mos_and_cube(qid)
    ctx = item.get("context")
    if isinstance(ctx, dict):
        titles = ctx.get("title") or []
        sentences_list = ctx.get("sentences") or []
        for title, sentences in zip(titles, sentences_list, strict=False):
            text = " ".join(s.strip() for s in sentences if isinstance(s, str) and s.strip())
            if title or text:
                mos.add(memory_content=f"{title}: {text}")
    else:
        for entry in ctx or []:
            if isinstance(entry, list) and len(entry) >= 2:
                title, sentences = entry[0], entry[1]
            elif isinstance(entry, dict):
                title = entry.get("title", "")
                sentences = entry.get("sentences", [])
            else:
                continue
            text = " ".join(s.strip() for s in sentences if isinstance(s, str) and s.strip())
            if title or text:
                mos.add(memory_content=f"{title}: {text}")
    answer = mos.chat(question, qid).strip()
    print("question:", question)
    print("answer:", answer)
    return qid, answer


pred_answers = {}
output_dir = "evaluation/data/hotpot/output"
os.makedirs(output_dir, exist_ok=True)
pred_path = os.path.join(output_dir, "dev_distractor_pred.json")
gold_path = os.path.join(output_dir, "dev_distractor_gold.json")


def write_gold(data):
    split = data.get("validation")
    items_list = [split[i] for i in range(10)]
    out = []
    for it in items_list:
        qid = it.get("_id") or it.get("id")
        sp = it.get("supporting_facts")
        if isinstance(sp, dict):
            titles = sp.get("title") or []
            sent_ids = sp.get("sent_id") or []
            sp_list = [[t, s] for t, s in zip(titles, sent_ids, strict=False)]
        else:
            sp_list = sp or []
        ctx = it.get("context")
        if isinstance(ctx, dict):
            titles = ctx.get("title") or []
            sentences = ctx.get("sentences") or []
            ctx_list = [[t, s] for t, s in zip(titles, sentences, strict=False)]
        else:
            ctx_list = ctx or []
        out.append(
            {
                "_id": qid,
                "question": it.get("question"),
                "answer": it.get("answer"),
                "supporting_facts": sp_list,
                "context": ctx_list,
            }
        )
    with open(gold_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)


def run_eval():
    spec = importlib.util.spec_from_file_location(
        "hotpot_eval_v1", "evaluation/scripts/hotpot/hotpot_evaluate_v1.py"
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    print("评估分数:")
    m.eval(pred_path, gold_path)


def main():
    interval = 50
    split = data.get("validation")
    items_list = [split[i] for i in range(10)]
    if os.path.exists(pred_path):
        try:
            with open(pred_path, encoding="utf-8") as f:
                prev = json.load(f)
            if isinstance(prev, dict) and isinstance(prev.get("answer"), dict):
                pred_answers.update(prev["answer"])
        except Exception:
            pass
    processed = len(pred_answers)
    print("开始评估，总样本:", len(items_list))
    print("已存在预测:", processed)
    pending_items = []
    for it in items_list:
        qid = it.get("_id") or it.get("id")
        if qid not in pred_answers:
            pending_items.append(it)
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {
            executor.submit(build_and_ask, item): idx for idx, item in enumerate(pending_items)
        }
        for future in tqdm(as_completed(futures), total=len(futures)):
            qid, answer = future.result()
            pred_answers[qid] = answer
            processed += 1
            if processed % 10 == 0:
                print("已完成:", processed, "剩余:", len(items_list) - processed)
            with open(pred_path, "w", encoding="utf-8") as f:
                json.dump({"answer": pred_answers, "sp": {}}, f, ensure_ascii=False, indent=2)
            if processed % interval == 0:
                print("阶段评估，当前进度:", processed)
                run_eval()

    print("最终评估:")
    run_eval()


if __name__ == "__main__":
    main()
