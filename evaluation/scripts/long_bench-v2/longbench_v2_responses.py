import argparse
import json
import os
import re
import sys
import threading

from concurrent.futures import ThreadPoolExecutor, as_completed
from time import time

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


# RAG-style prompt template aligned with longbench_stx.TEMPLATE_RAG
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


def extract_answer(response):
    """Extract answer from response (A, B, C, or D).

    Logic is kept consistent with longbench_stx.extract_answer.
    """
    response = response.replace("*", "")
    # Try to find "The correct answer is (X)" pattern
    match = re.search(r"The correct answer is \(([A-D])\)", response)
    if match:
        return match.group(1)
    else:
        match = re.search(r"The correct answer is ([A-D])", response)
        if match:
            return match.group(1)
        return None


def llm_answer(llm_client, memories, question, choices):
    """Generate response using RAG-style prompt, aligned with longbench_stx.llm_answer.

    Returns:
        tuple[str, int | None]: (response_text, prompt_tokens)
    """
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

    try:
        response = llm_client.chat.completions.create(
            model=os.getenv("CHAT_MODEL"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=12800,
        )
        text = response.choices[0].message.content or ""
        prompt_tokens = None
        usage = getattr(response, "usage", None)
        if usage is not None:
            # openai>=1.x style: usage.prompt_tokens
            pt = getattr(usage, "prompt_tokens", None)
            if isinstance(pt, int):
                prompt_tokens = pt
            else:
                # fallback for dict-like usage
                try:
                    prompt_tokens = int(usage.get("prompt_tokens"))  # type: ignore[call-arg]
                except Exception:
                    prompt_tokens = None
        return text, prompt_tokens
    except Exception as e:
        print(f"Error generating response: {e}")
        return "", None


def process_sample(search_result, llm_client, success_records, record_file, file_lock):
    """Process a single sample: generate answer.

    This mirrors longbench_stx.evaluate_sample but consumes precomputed search results
    produced by longbench_v2_search.py.
    """
    # Use sample_idx when available, otherwise fall back to _id so that
    # we can work with stx-style search results that only have _id.
    sample_idx = search_result.get("sample_idx")
    sample_key = str(sample_idx) if sample_idx is not None else str(search_result.get("_id", ""))

    # Skip if already processed
    if sample_key and sample_key in success_records:
        return None

    start = time()

    question = search_result.get("question", "")
    choices = {
        "A": search_result.get("choice_A", "") or "",
        "B": search_result.get("choice_B", "") or "",
        "C": search_result.get("choice_C", "") or "",
        "D": search_result.get("choice_D", "") or "",
    }

    # Prefer memories saved by longbench_v2_search; fall back to reconstructing
    # from raw search_results if needed (for old search jsons).
    memories = search_result.get("memories_used")
    if memories is None:
        raw = search_result.get("search_results") or {}
        memories = []
        if isinstance(raw, dict) and raw.get("text_mem"):
            text_mem = raw["text_mem"]
            if text_mem and text_mem[0].get("memories"):
                memories = [
                    m.get("memory", "") for m in text_mem[0]["memories"] if isinstance(m, dict)
                ]

    # Ensure we have a list, even if empty
    memories = memories or []

    # Skip if no retrieved memories and no question
    if not question:
        return None
    if not memories:
        return None

    # Generate answer
    response, prompt_tokens = llm_answer(llm_client, memories, str(question), choices)

    # Extract answer (A, B, C, or D)
    pred = extract_answer(response)

    response_duration_ms = (time() - start) * 1000

    result = {
        # Preserve sample_idx if present for backward compatibility
        "sample_idx": search_result.get("sample_idx"),
        "_id": search_result.get("_id"),
        "domain": search_result.get("domain"),
        "sub_domain": search_result.get("sub_domain"),
        "difficulty": search_result.get("difficulty"),
        "length": search_result.get("length"),
        "question": question,
        "choice_A": choices["A"],
        "choice_B": choices["B"],
        "choice_C": choices["C"],
        "choice_D": choices["D"],
        "answer": search_result.get("answer"),
        "pred": pred,
        "response": response,
        "judge": pred == search_result.get("answer") if pred else False,
        "prompt_tokens": prompt_tokens,
        # Keep full retrieved memories list for inspection / debugging
        "memories_used": memories,
        # Preserve full search results payload (e.g., list of memories)
        "search_results": search_result.get("search_results"),
        "response_duration_ms": response_duration_ms,
        "search_duration_ms": search_result.get("search_duration_ms", 0),
    }

    # Record successful processing (thread-safe)
    if sample_key:
        with file_lock, open(record_file, "a") as f:
            f.write(f"{sample_key}\n")
            f.flush()

    return result


def main(frame, version="default", num_workers=10):
    """Main response generation function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH V2 RESPONSE GENERATION - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Initialize checkpoint file for resume functionality
    checkpoint_dir = os.path.join(
        ROOT_DIR, "evaluation", "results", "long_bench_v2", f"{frame}-{version}"
    )
    os.makedirs(checkpoint_dir, exist_ok=True)
    record_file = os.path.join(checkpoint_dir, "response_success_records.txt")
    search_path = os.path.join(checkpoint_dir, f"{frame}_longbench_v2_search_results.json")
    output_path = os.path.join(checkpoint_dir, f"{frame}_longbench_v2_responses.json")

    # Load search results
    if not os.path.exists(search_path):
        print(f"❌ Search results not found: {search_path}")
        print("Please run longbench_v2_search.py first")
        return

    with open(search_path, encoding="utf-8") as f:
        search_results = json.load(f)

    # Load existing results and success records for resume
    existing_results: dict[str, dict] = {}
    success_records: set[str] = set()
    if os.path.exists(output_path):
        with open(output_path, encoding="utf-8") as f:
            existing_results_list = json.load(f)
            for result in existing_results_list:
                # Use sample_idx if present, otherwise _id as the unique key
                sample_idx = result.get("sample_idx")
                key = str(sample_idx) if sample_idx is not None else str(result.get("_id", ""))
                if key:
                    existing_results[key] = result
                    success_records.add(key)
        print(f"📋 Found {len(existing_results)} existing responses (resume mode)")
    else:
        print("📋 Starting fresh response generation (no checkpoint found)")

    # Load additional success records from checkpoint file
    if os.path.exists(record_file):
        with open(record_file) as f:
            for line in f:
                line = line.strip()
                if line and line not in success_records:
                    success_records.add(line)
        print(f"📋 Total {len(success_records)} samples already processed")

    # Initialize LLM client
    llm_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"),
        base_url=os.getenv("CHAT_MODEL_BASE_URL"),
    )
    print(f"🔌 Using OpenAI client with model: {os.getenv('CHAT_MODEL')}")

    # Process all samples concurrently using ThreadPoolExecutor
    new_results = []
    file_lock = threading.Lock()  # Lock for thread-safe file writing
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = [
            executor.submit(
                process_sample, sample, llm_client, success_records, record_file, file_lock
            )
            for sample in search_results
        ]

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc="Generating responses",
        ):
            result = future.result()
            if result:
                new_results.append(result)
                # Update existing results with new result (keyed by sample_idx or _id)
                sample_idx = result.get("sample_idx")
                key = str(sample_idx) if sample_idx is not None else str(result.get("_id", ""))
                if key:
                    existing_results[key] = result

    # Merge and save all results
    all_responses = list(existing_results.values())

    # Sort by sample_idx when available, otherwise by _id for stability
    def _sort_key(x: dict):
        if x.get("sample_idx") is not None:
            return ("0", int(x.get("sample_idx")))
        return ("1", str(x.get("_id", "")))

    all_responses.sort(key=_sort_key)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_responses, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 80}")
    print(f"✅ RESPONSE GENERATION COMPLETE: Results saved to {output_path}".center(80))
    print(f"{'=' * 80}\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--lib",
        type=str,
        choices=["memos-api", "memos-api-online"],
        default="memos-api",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="default",
        help="Version identifier for loading results",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=10,
        help="Number of parallel workers",
    )
    args = parser.parse_args()

    main(args.lib, args.version, args.workers)
