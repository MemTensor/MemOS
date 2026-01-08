import json
import os
import re
import sys
import time

from concurrent.futures import ThreadPoolExecutor, as_completed
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


def _get_clients():
    from utils.client import MemosApiClient

    memos_client = MemosApiClient()
    openai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )
    return memos_client, openai_client


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


def add_context(client, user_id: str, context: str) -> None:
    iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    chunker = RecursiveCharacterTextSplitter.from_language(
        language=Language.PYTHON, chunk_size=5120, chunk_overlap=128
    )
    paragraphs = [p for p in chunker.split_text(context or "") if p.strip()]

    messages = [{"role": "user", "content": p, "created_at": iso} for p in paragraphs]
    client.add(messages=messages, user_id=user_id, conv_id=user_id)
    print(f"[memos-add]: successfully added {len(messages)} chunks to user {user_id}")


def memos_search(client, user_id: str, query: str, top_k: int = 30) -> list[str]:
    results = client.search(query=query, user_id=user_id, top_k=top_k)
    memories = results["text_mem"][0]["memories"]
    mem_texts = [m["memory"] for m in memories]
    print(f"[memos-search] user={user_id} top_k={top_k} memories={len(memories)}")
    return mem_texts


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


def llm_answer(oai_client, memories: list[str], question: str, choices: dict) -> str:
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
    resp = oai_client.chat.completions.create(
        model=os.getenv("CHAT_MODEL"), messages=messages, temperature=0.1, max_tokens=128
    )
    return resp.choices[0].message.content or ""


def ingest_sample(client, sample: dict) -> None:
    sample_id = str(sample.get("_id"))
    user_id = sample_id
    context = sample.get("context") or ""
    add_context(client, user_id, str(context))


def evaluate_sample(client, oai_client, sample: dict, top_k: int) -> dict:
    sample_id = str(sample.get("_id"))
    user_id = sample_id
    question = sample.get("question") or ""
    choices = {
        "A": sample.get("choice_A") or "",
        "B": sample.get("choice_B") or "",
        "C": sample.get("choice_C") or "",
        "D": sample.get("choice_D") or "",
    }
    memories = memos_search(client, user_id, str(question), top_k=top_k)
    response = llm_answer(oai_client, memories, str(question), choices)
    pred = extract_answer(response)
    judge = pred == sample.get("answer")
    print("[Question]:", question)
    print("[Choices]:", choices)
    print("[Raw response]:", response)
    print("[Answer]:", pred)
    print("[Ground truth]:", sample.get("answer"))
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
    }
    return out


def print_metrics(results: list[dict]) -> None:
    easy, hard, short, medium, long = 0, 0, 0, 0, 0
    easy_acc, hard_acc, short_acc, medium_acc, long_acc = 0, 0, 0, 0, 0

    for pred in results:
        acc = int(pred.get("judge", False))
        diff = pred.get("difficulty", "easy")
        length = pred.get("length", "short")

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

    print("\n" + "=" * 60)
    print(f"{'Metric':<15} | {'Count':<10} | {'Accuracy (%)':<10}")
    print("-" * 60)
    print(f"{'Overall':<15} | {total:<10} | {o_acc:<10}")
    print(f"{'Easy':<15} | {easy:<10} | {e_acc:<10}")
    print(f"{'Hard':<15} | {hard:<10} | {h_acc:<10}")
    print(f"{'Short':<15} | {short:<10} | {s_acc:<10}")
    print(f"{'Medium':<15} | {medium:<10} | {m_acc:<10}")
    print(f"{'Long':<15} | {long:<10} | {l_acc:<10}")
    print("=" * 60 + "\n")


def main():
    client, oai_client = _get_clients()
    dataset = _dump_dataset_to_local()
    results: list[dict] = []
    os.makedirs("evaluation/data/longbenchV2", exist_ok=True)
    out_json = Path("evaluation/data/longbenchV2/memos_results.json")

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
    print(f"Total dataset size: {len(dataset)}")
    print(f"Already processed: {len(processed_ids)}")
    print(f"Remaining to process: {len(remaining_dataset)}")

    if not remaining_dataset:
        print("All samples have been processed.")
        print_metrics(results)
        return

    with ThreadPoolExecutor(max_workers=8) as executor:
        # Phase 1: Ingestion
        print("Phase 1: Ingesting context...")
        ingest_futures = [
            executor.submit(ingest_sample, client, sample) for sample in remaining_dataset
        ]
        for f in tqdm(as_completed(ingest_futures), total=len(ingest_futures), desc="Ingesting"):
            try:
                f.result()
            except Exception as e:
                print(f"Ingestion Error: {e}")

        # Phase 2: Evaluation
        print("Phase 2: Evaluating...")
        futures = [
            executor.submit(evaluate_sample, client, oai_client, sample, 30)
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
                    print_metrics(results)
            except Exception as e:
                print(f"Evaluation Error: {e}")

    # Final save
    out_json.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(results)} results to {out_json}")
    print_metrics(results)


if __name__ == "__main__":
    main()
