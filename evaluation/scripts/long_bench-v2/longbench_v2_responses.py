import argparse
import json
import os
import re
import sys

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


def process_sample(search_result, llm_client):
    """Process a single sample: generate answer."""
    start = time()

    context = search_result.get("context", "")
    question = search_result.get("question", "")
    choice_a = search_result.get("choice_A", "")
    choice_b = search_result.get("choice_B", "")
    choice_c = search_result.get("choice_C", "")
    choice_d = search_result.get("choice_D", "")

    # Generate answer
    response = generate_response(
        llm_client, context, question, choice_a, choice_b, choice_c, choice_d
    )

    # Extract answer (A, B, C, or D)
    pred = extract_answer(response)

    response_duration_ms = (time() - start) * 1000

    return {
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
        "response_duration_ms": response_duration_ms,
        "search_duration_ms": search_result.get("search_duration_ms", 0),
    }


def main(frame, version="default", num_workers=10):
    """Main response generation function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH V2 RESPONSE GENERATION - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Load search results
    search_path = (
        f"results/long_bench-v2/{frame}-{version}/{frame}_longbench_v2_search_results.json"
    )
    if not os.path.exists(search_path):
        print(f"❌ Search results not found: {search_path}")
        print("Please run longbench_v2_search.py first")
        return

    with open(search_path, encoding="utf-8") as f:
        search_results = json.load(f)

    # Initialize LLM client
    llm_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"),
        base_url=os.getenv("CHAT_MODEL_BASE_URL"),
    )
    print(f"🔌 Using OpenAI client with model: {os.getenv('CHAT_MODEL')}")

    # Process all samples
    all_responses = []
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = [executor.submit(process_sample, sample, llm_client) for sample in search_results]

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc="Generating responses",
        ):
            result = future.result()
            if result:
                all_responses.append(result)

    # Save responses
    output_path = f"results/long_bench-v2/{frame}-{version}/{frame}_longbench_v2_responses.json"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

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
