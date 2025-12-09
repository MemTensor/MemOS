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


# Prompt template from LongBench v2
LONGBENCH_V2_PROMPT = """Please read the following text and answer the question below.

<text>
{context}
</text>

What is the correct answer to this question: {question}
Choices:
(A) {choice_A}
(B) {choice_B}
(C) {choice_C}
(D) {choice_D}

Format your response as follows: "The correct answer is (insert answer here)"."""


def extract_answer(response):
    """Extract answer from response (A, B, C, or D)."""
    response = response.replace("*", "")
    # Try to find "The correct answer is (X)" pattern
    match = re.search(r"The correct answer is \(([A-D])\)", response, re.IGNORECASE)
    if match:
        return match.group(1).upper()
    else:
        match = re.search(r"The correct answer is ([A-D])", response, re.IGNORECASE)
        if match:
            return match.group(1).upper()
        else:
            # Try to find standalone A, B, C, or D
            match = re.search(r"\b([A-D])\b", response)
            if match:
                return match.group(1).upper()
    return None


def generate_response(llm_client, context, question, choice_a, choice_b, choice_c, choice_d):
    """Generate response using LLM."""
    prompt = LONGBENCH_V2_PROMPT.format(
        context=context,
        question=question,
        choice_A=choice_a,
        choice_B=choice_b,
        choice_C=choice_c,
        choice_D=choice_d,
    )

    try:
        response = llm_client.chat.completions.create(
            model=os.getenv("CHAT_MODEL"),
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.1,
            max_tokens=128,
        )
        result = response.choices[0].message.content or ""
        return result
    except Exception as e:
        print(f"Error generating response: {e}")
        return ""


def process_sample(search_result, llm_client, success_records, record_file, file_lock):
    """Process a single sample: generate answer."""
    sample_idx = search_result.get("sample_idx")
    # Skip if already processed
    if sample_idx is not None and str(sample_idx) in success_records:
        return None

    start = time()

    context = search_result.get("context", "")
    question = search_result.get("question", "")
    choice_a = search_result.get("choice_A", "")
    choice_b = search_result.get("choice_B", "")
    choice_c = search_result.get("choice_C", "")
    choice_d = search_result.get("choice_D", "")

    # Skip empty/placeholder contexts (e.g., "\n" or whitespace-only)
    if not context or context.strip() == "":
        return None

    # Generate answer
    response = generate_response(
        llm_client, context, question, choice_a, choice_b, choice_c, choice_d
    )

    # Extract answer (A, B, C, or D)
    pred = extract_answer(response)

    response_duration_ms = (time() - start) * 1000

    result = {
        "sample_idx": search_result.get("sample_idx"),
        "_id": search_result.get("_id"),
        "domain": search_result.get("domain"),
        "sub_domain": search_result.get("sub_domain"),
        "difficulty": search_result.get("difficulty"),
        "length": search_result.get("length"),
        "question": question,
        "choice_A": choice_a,
        "choice_B": choice_b,
        "choice_C": choice_c,
        "choice_D": choice_d,
        "answer": search_result.get("answer"),
        "pred": pred,
        "response": response,
        "judge": pred == search_result.get("answer") if pred else False,
        "search_context": context,
        # Preserve full search results payload (e.g., list of memories)
        "search_results": search_result.get("search_results"),
        "response_duration_ms": response_duration_ms,
        "search_duration_ms": search_result.get("search_duration_ms", 0),
    }

    # Record successful processing (thread-safe)
    if sample_idx is not None:
        with file_lock, open(record_file, "a") as f:
            f.write(f"{sample_idx}\n")
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
    existing_results = {}
    success_records = set()
    if os.path.exists(output_path):
        with open(output_path, encoding="utf-8") as f:
            existing_results_list = json.load(f)
            for result in existing_results_list:
                sample_idx = result.get("sample_idx")
                if sample_idx is not None:
                    existing_results[sample_idx] = result
                    success_records.add(str(sample_idx))
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

    # Process all samples
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
                # Update existing results with new result
                sample_idx = result.get("sample_idx")
                if sample_idx is not None:
                    existing_results[sample_idx] = result

    # Merge and save all results
    all_responses = list(existing_results.values())
    # Sort by sample_idx to maintain order
    all_responses.sort(key=lambda x: x.get("sample_idx", 0))

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
