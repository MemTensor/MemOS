import argparse
import json
import os
import re
import time
import traceback

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

from evaluation.scripts.utils.prompts import LONGBENCH_V2_ANSWER_PROMPT


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


def extract_answer(response: str) -> str | None:
    response = response.replace("*", "")
    match = re.search(r"The correct answer is \(([A-D])\)", response)
    if match:
        return match.group(1)
    match = re.search(r"The correct answer is ([A-D])", response)
    if match:
        return match.group(1)
    return None


def llm_answer(
    oai_client, model_name, memories: list[str], question: str, choices: dict
) -> tuple[str, int]:
    doc_content = "\n\n".join([f"Retrieved chunk {idx + 1}: {m}" for idx, m in enumerate(memories)])
    prompt = (
        LONGBENCH_V2_ANSWER_PROMPT.replace("$DOC$", doc_content)
        .replace("$Q$", question)
        .replace("$C_A$", choices.get("A", ""))
        .replace("$C_B$", choices.get("B", ""))
        .replace("$C_C$", choices.get("C", ""))
        .replace("$C_D$", choices.get("D", ""))
    )
    messages = [{"role": "user", "content": prompt}]
    resp = retry_operation(
        oai_client.chat.completions.create,
        model=model_name,
        messages=messages,
        temperature=0.1,
        max_tokens=12800,
    )
    return resp.choices[0].message.content or "", resp.usage.prompt_tokens


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


def _load_json_list(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"Invalid json format: {path}")
    return data


def _save_json_list(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def evaluate_one(oai_client, model_name, row: dict) -> dict:
    question = row.get("question") or ""
    choices = row.get("choices") or {}
    memories = row.get("memories_used") or []
    response, prompt_tokens = llm_answer(
        oai_client, model_name, list(memories), str(question), dict(choices)
    )
    pred = extract_answer(response)
    judge = pred == row.get("answer")
    out = dict(row)
    out["response"] = response
    out["pred"] = pred
    out["judge"] = judge
    out["prompt_tokens"] = prompt_tokens
    out.pop("memories_used")
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="LongBench-v2 eval Tool")
    parser.add_argument(
        "--lib",
        "-b",
        required=True,
        choices=["memos", "mem0", "supermemory"],
        help="Product name to evaluate",
    )
    parser.add_argument("--workers", "-w", type=int, default=20, help="Number of parallel threads")
    parser.add_argument(
        "--top-k", "-k", type=int, default=20, help="Top k results to use (default: 20)"
    )
    parser.add_argument("--version-dir", "-v", default=None, help="Version directory name")
    parser.add_argument("--search_results_path", type=str, default=None)
    parser.add_argument("--output_path", type=str, default=None)
    parser.add_argument("--chat-model", type=str, default=None, help="Chat model for evaluation")
    args = parser.parse_args()

    print("=" * 60)
    print("LongBench-v2 Product Eval Tool")
    print("=" * 60)

    start_time = time.time()

    output_dir = os.path.join("evaluation/data/longbench_v2", args.version_dir)
    search_filename = f"{args.lib}_search_results.json"
    search_path = Path(os.path.join(output_dir, search_filename))

    if not search_path.exists():
        raise FileNotFoundError(f"Search results not found: {search_path}")

    search_rows = _load_json_list(search_path)
    output_filename = f"{args.lib}_eval_results.json"
    output_path = Path(os.path.join(output_dir, output_filename))

    results: list[dict] = []
    processed_ids: set[str] = set()

    # Resume from checkpoint
    if output_path.exists():
        try:
            existing = _load_json_list(output_path)
            results = existing
            processed_ids = {str(r.get("_id")) for r in results if r.get("_id")}
            print(f"Loaded {len(results)} existing results from checkpoint.")
        except Exception as e:
            print(f"Error loading checkpoint: {e}")

    pending = [r for r in search_rows if str(r.get("_id")) not in processed_ids]
    print(f"[Eval] total={len(search_rows)} pending={len(pending)} workers={args.workers}")
    if not pending:
        print_metrics(results, time.time() - start_time)
        return

    print("[Response model]: ", args.chat_model)
    oai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [
            executor.submit(evaluate_one, oai_client, args.chat_model, row) for row in pending
        ]
        for idx, f in enumerate(
            tqdm(as_completed(futures), total=len(futures), desc="Evaluating"), start=1
        ):
            try:
                res = f.result()
                results.append(res)
                if idx % 10 == 0:
                    _save_json_list(output_path, results)
            except Exception as e:
                print(f"Evaluation Error: {e}")
                traceback.print_exc()

    _save_json_list(output_path, results)
    print(f"Saved {len(results)} results to {output_path}")
    print_metrics(results, time.time() - start_time)


if __name__ == "__main__":
    main()
