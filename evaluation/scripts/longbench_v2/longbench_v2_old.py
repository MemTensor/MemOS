import argparse
import json
import os
import re
import sys
import time
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from langchain_text_splitters import Language, RecursiveCharacterTextSplitter
from openai import OpenAI
from tqdm import tqdm


TEMPLATE_RAG = """Please read the following retrieved text chunks and answer the question below.

<text>
$DOC$
</text>

What is the correct answer to this question: $Q$
Choices:
(A) $C_A$
(B) $C_B$
(C) $C_C$
(D) $C_D$

Format your response as follows: "The correct answer is (insert answer here)"."""


PROJECT_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
sys.path.append(str(SCRIPTS_ROOT))
sys.path.append(str(SRC_ROOT))
load_dotenv()


def retry_operation(func, *args, retries=5, delay=2, **kwargs):
    for attempt in range(retries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            traceback.print_exc()
            if attempt < retries - 1:
                func_name = getattr(func, "__name__", "Operation")
                print(f"[Retry] {func_name} failed: {e}. Retrying in {delay}s...")
                time.sleep(delay)
                delay *= 2
            else:
                raise e


def _get_lib_client(lib: str):
    if lib == "mem0":
        from utils.client import Mem0Client  # type: ignore

        return Mem0Client(enable_graph=False)
    if lib == "supermemory":
        from utils.client import SupermemoryClient  # type: ignore

        return SupermemoryClient()
    from utils.client import MemosApiClient  # type: ignore

    return MemosApiClient()


def _get_clients(lib: str = "memos"):
    client = _get_lib_client(lib)
    openai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )
    return client, openai_client


def _dump_dataset_to_local():
    from datasets import load_dataset

    dataset = load_dataset("zai-org/LongBench-v2", split="train")
    out_dir = Path("evaluation/data/longbenchV2")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "longbenchv2_train.json"
    with open(out_path, "w", encoding="utf-8") as f:
        for i in range(len(dataset)):
            s = dataset[i]
            row = {
                "_id": s.get("_id") or s.get("id") or str(i),
                "domain": s.get("domain"),
                "sub_domain": s.get("sub_domain"),
                "difficulty": s.get("difficulty"),
                "length": s.get("length"),
                "question": s.get("question"),
                "choice_A": s.get("choice_A"),
                "choice_B": s.get("choice_B"),
                "choice_C": s.get("choice_C"),
                "choice_D": s.get("choice_D"),
                "answer": s.get("answer"),
                "context": s.get("context") or s.get("document") or s.get("documents"),
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"Saved dataset to {out_path}")
    return dataset


def add_context(client, user_id: str, context: str, lib: str) -> None:
    iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    chunker = RecursiveCharacterTextSplitter.from_language(
        language=Language.PYTHON, chunk_size=5120, chunk_overlap=128
    )
    paragraphs = [p for p in chunker.split_text(context or "") if p.strip()]

    if lib == "memos":
        messages = [{"role": "user", "content": p, "created_at": iso} for p in paragraphs]
        try:
            retry_operation(client.add, messages=messages, user_id=user_id, conv_id=user_id)
            print(f"[Add-memos]: successfully added {len(messages)} chunks to user {user_id}")
        except Exception as e:
            print(f"[Add-memos] failed: {e}")

    elif lib == "mem0":
        messages = [{"role": "user", "content": p} for p in paragraphs]
        ts = int(time.time())
        try:
            retry_operation(
                client.add, messages=messages, user_id=user_id, timestamp=ts, batch_size=10
            )
            print(f"[Add-mem0] user={user_id} total={len(messages)}")
        except Exception as e:
            print(f"[Add-mem0] failed: {e}")

    elif lib == "supermemory":
        iso = datetime.utcnow().isoformat() + "Z"
        content = "\n".join([f"{iso} user: {p}" for p in paragraphs])
        try:
            retry_operation(client.add, content=content, user_id=user_id)
            print(f"[Add-supermemory] user={user_id} total_chars={len(content)}")
        except Exception as e:
            print(f"[Add-supermemory] failed: {e}")


def memos_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    results = retry_operation(client.search, query=query, user_id=user_id, top_k=top_k)
    memories = results["text_mem"][0]["memories"]
    mem_texts = [m["memory"] for m in memories]
    print(f"[Search-memos] user={user_id} top_k={top_k} memories={len(memories)}")
    return mem_texts


def mem0_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    res = retry_operation(client.search, query, user_id, top_k)
    results = res.get("results", [])
    mem_texts = [m.get("memory", "") for m in results if m.get("memory")]
    print(f"[Search-mem0] user={user_id} top_k={top_k} memories={len(mem_texts)}")
    return mem_texts


def supermemory_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    chunk_list = retry_operation(client.search, query, user_id, top_k)
    print(f"[Search-supermemory] user={user_id} top_k={top_k} memories={len(chunk_list)}")
    return chunk_list


def extract_answer(response: str) -> str | None:
    response = response.replace("*", "")
    match = re.search(r"The correct answer is \(([A-D])\)", response)
    if match:
        return match.group(1)
    else:
        match = re.search(r"The correct answer is ([A-D])", response)
        if match:
            return match.group(1)
        else:
            return None


def llm_answer(oai_client, memories: list[str], question: str, choices: dict) -> tuple[str, int]:
    # Join memories to form the retrieved context document
    doc_content = "\n\n".join([f"Retrieved chunk {idx + 1}: {m}" for idx, m in enumerate(memories)])

    prompt = (
        TEMPLATE_RAG.replace("$DOC$", doc_content)
        .replace("$Q$", question)
        .replace("$C_A$", choices.get("A", ""))
        .replace("$C_B$", choices.get("B", ""))
        .replace("$C_C$", choices.get("C", ""))
        .replace("$C_D$", choices.get("D", ""))
    )

    messages = [
        {"role": "user", "content": prompt},
    ]
    resp = retry_operation(
        oai_client.chat.completions.create,
        model=os.getenv("CHAT_MODEL"),
        messages=messages,
        temperature=0.1,
        max_tokens=12800,
    )
    return resp.choices[0].message.content or "", resp.usage.prompt_tokens


def ingest_sample(client, sample: dict, lib: str) -> None:
    sample_id = str(sample.get("_id"))
    user_id = sample_id
    context = sample.get("context") or ""
    add_context(client, user_id, str(context), lib)


def evaluate_sample(client, oai_client, sample: dict, top_k: int, lib: str) -> dict:
    sample_id = str(sample.get("_id"))
    user_id = sample_id
    question = sample.get("question") or ""
    choices = {
        "A": sample.get("choice_A") or "",
        "B": sample.get("choice_B") or "",
        "C": sample.get("choice_C") or "",
        "D": sample.get("choice_D") or "",
    }

    if lib == "memos":
        memories = memos_search(client, user_id, str(question), top_k=top_k)
    elif lib == "mem0":
        memories = mem0_search(client, user_id, str(question), top_k=top_k)
    elif lib == "supermemory":
        memories = supermemory_search(client, user_id, str(question), top_k=top_k)
    else:
        memories = []

    response, prompt_tokens = llm_answer(oai_client, memories, str(question), choices)
    pred = extract_answer(response)
    judge = pred == sample.get("answer")
    print("[Question]:", question)
    print("[Choices]:", choices)
    print("[Raw response]:", response)
    print("[Answer]:", pred)
    print("[Ground truth]:", sample.get("answer"))
    print("[Prompt Tokens]:", prompt_tokens)

    out = {
        "_id": sample_id,
        "domain": sample.get("domain"),
        "sub_domain": sample.get("sub_domain"),
        "difficulty": sample.get("difficulty"),
        "length": sample.get("length"),
        "question": question,
        "choice_A": choices["A"],
        "choice_B": choices["B"],
        "choice_C": choices["C"],
        "choice_D": choices["D"],
        "answer": sample.get("answer"),
        "memories_used": memories,
        "response": response,
        "pred": pred,
        "judge": judge,
        "prompt_tokens": prompt_tokens,
    }
    return out


def print_metrics(results: list[dict], duration: float) -> None:
    easy, hard, short, medium, long = 0, 0, 0, 0, 0
    easy_acc, hard_acc, short_acc, medium_acc, long_acc = 0, 0, 0, 0, 0
    total_tokens = 0

    for pred in results:
        acc = int(pred.get("judge", False))
        diff = pred.get("difficulty", "easy")
        length = pred.get("length", "short")
        tokens = pred.get("prompt_tokens", 0)
        total_tokens += tokens

        if diff == "easy":
            easy += 1
            easy_acc += acc
        else:
            hard += 1
            hard_acc += acc

        if length == "short":
            short += 1
            short_acc += acc
        elif length == "medium":
            medium += 1
            medium_acc += acc
        else:
            long += 1
            long_acc += acc

    total = len(results)
    if total == 0:
        print("No results to calculate metrics.")
        return

    o_acc = round(100 * (easy_acc + hard_acc) / total, 2)
    e_acc = round(100 * easy_acc / easy, 2) if easy > 0 else 0
    h_acc = round(100 * hard_acc / hard, 2) if hard > 0 else 0
    s_acc = round(100 * short_acc / short, 2) if short > 0 else 0
    m_acc = round(100 * medium_acc / medium, 2) if medium > 0 else 0
    l_acc = round(100 * long_acc / long, 2) if long > 0 else 0
    avg_tokens = round(total_tokens / total, 2)

    print("\n" + "=" * 60)
    print(f"{'Metric':<15} | {'Count':<10} | {'Accuracy (%)':<10}")
    print("-" * 60)
    print(f"{'Overall':<15} | {total:<10} | {o_acc:<10}")
    print(f"{'Easy':<15} | {easy:<10} | {e_acc:<10}")
    print(f"{'Hard':<15} | {hard:<10} | {h_acc:<10}")
    print(f"{'Short':<15} | {short:<10} | {s_acc:<10}")
    print(f"{'Medium':<15} | {medium:<10} | {m_acc:<10}")
    print(f"{'Long':<15} | {long:<10} | {l_acc:<10}")
    print("-" * 60)
    print(f"{'Avg Tokens':<15} | {total:<10} | {avg_tokens:<10}")
    print(f"Total Duration: {duration:.2f} seconds")
    print("=" * 60 + "\n")


def main():
    parser = argparse.ArgumentParser(description="Evaluate LongBench-v2 with different backends.")
    parser.add_argument(
        "--lib",
        type=str,
        default="memos",
        choices=["memos", "mem0", "supermemory"],
        help="Backend library to use (default: memos)",
    )
    args = parser.parse_args()

    start_time = time.time()
    print("[Response model]: ", os.getenv("CHAT_MODEL"))

    client, oai_client = _get_clients(lib=args.lib)
    dataset = _dump_dataset_to_local()
    results: list[dict] = []
    os.makedirs("evaluation/data/longbenchV2", exist_ok=True)
    out_json = Path(f"evaluation/data/longbenchV2/test/{args.lib}_cot_results.json")

    # Checkpoint loading
    processed_ids = set()
    if out_json.exists():
        try:
            with open(out_json, encoding="utf-8") as f:
                existing_results = json.load(f)
                if isinstance(existing_results, list):
                    results = existing_results
                    processed_ids = {r.get("_id") for r in results if r.get("_id")}
                    print(f"Loaded {len(results)} existing results from checkpoint.")
        except Exception as e:
            print(f"Error loading checkpoint: {e}")

    # Filter dataset to skip processed samples
    remaining_dataset = [
        s
        for s in dataset
        if (s.get("_id") or s.get("id") or str(dataset.index(s))) not in processed_ids
    ]

    # Concurrency settings
    max_workers = 4
    print(f"Starting evaluation with {max_workers} workers using backend: {args.lib}")
    print(f"Total dataset size: {len(dataset)}")
    print(f"Already processed: {len(processed_ids)}")
    print(f"Remaining to process: {len(remaining_dataset)}")

    if not remaining_dataset:
        print("All samples have been processed.")
        print_metrics(results, time.time() - start_time)
        return

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Phase 1: Ingestion
        print("Phase 1: Ingesting context...")
        ingest_futures = [
            executor.submit(ingest_sample, client, sample, args.lib) for sample in remaining_dataset
        ]
        for f in tqdm(as_completed(ingest_futures), total=len(ingest_futures), desc="Ingesting"):
            try:
                f.result()
            except Exception as e:
                print(f"Ingestion Error: {e}")

        # Phase 2: Evaluation
        print("Phase 2: Evaluating...")
        futures = [
            executor.submit(evaluate_sample, client, oai_client, sample, 30, args.lib)
            for sample in remaining_dataset
        ]

        # Use tqdm for progress bar
        for f in tqdm(as_completed(futures), total=len(futures), desc="Evaluating"):
            try:
                res = f.result()
                results.append(res)

                # Save intermediate results every 10 samples
                if len(results) % 10 == 0:
                    out_json.write_text(
                        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8"
                    )
                    print_metrics(results, time.time() - start_time)
            except Exception as e:
                print(f"Evaluation Error: {e}")
                traceback.print_exc()

    # Final save
    out_json.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(results)} results to {out_json}")
    print_metrics(results, time.time() - start_time)


if __name__ == "__main__":
    main()
