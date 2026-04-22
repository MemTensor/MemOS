import argparse
import json
import os
import sys

from concurrent.futures import ThreadPoolExecutor, as_completed
from time import time

from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import re

from utils.prompts import PM_ANSWER_PROMPT


def extract_choice_answer(predicted_answer, correct_answer):
    def _extract_only_options(text):
        text = text.lower()
        in_parens = re.findall(r"\(([a-d])\)", text)
        if in_parens:
            return set(in_parens)
        else:
            return set(re.findall(r"\b([a-d])\b", text))

    correct = correct_answer.lower().strip("() ")

    full_response = predicted_answer
    predicted_answer = predicted_answer.strip()

    if "<final_answer>" in predicted_answer:
        predicted_answer = predicted_answer.split("<final_answer>")[-1].strip()
    if predicted_answer.endswith("</final_answer>"):
        predicted_answer = predicted_answer[: -len("</final_answer>")].strip()

    pred_options = _extract_only_options(predicted_answer)

    if pred_options == {correct}:
        return True, predicted_answer

    response_options = _extract_only_options(full_response)
    if response_options == {correct}:
        return True, predicted_answer

    return False, predicted_answer


def pm_response(llm_client, context, question, options):
    prompt = PM_ANSWER_PROMPT.format(
        question=question,
        context=context,
        options=options,
    )
    response = llm_client.chat.completions.create(
        model=os.getenv("CHAT_MODEL"),
        messages=[
            {"role": "system", "content": prompt},
        ],
        temperature=0,
    )
    result = response.choices[0].message.content or ""

    return result


def process_qa(user_id, search_result, num_runs, llm_client):
    search_result = search_result[0]
    question = search_result.get("question")
    context = search_result.get("search_context", "")
    options = search_result.get("all_options", [])

    run_results = []

    for idx in range(num_runs):
        start = time()
        answer = pm_response(llm_client, context, question, options)
        is_correct, answer = extract_choice_answer(answer, search_result.get("golden_answer", ""))
        response_duration_ms = (time() - start) * 1000

        run_results.append(
            {
                "run_id": idx + 1,
                "answer": answer,
                "is_correct": is_correct,
                "response_duration_ms": response_duration_ms,
            }
        )

    response_duration_ms = sum(result["response_duration_ms"] for result in run_results) / num_runs

    print("\n" + "-" * 80)
    print(f"🤖 Processed User: {user_id}")
    print(f"⏱️  Duration: {response_duration_ms:.2f} ms")
    print(f"❓ Question: {question}")
    print(f"💡 Golden Answer: {search_result.get('golden_answer', 'N/A')}")
    for idx, result in enumerate(run_results, start=1):
        print(f"\n🔄 Run {idx}/{num_runs}:")
        print(
            f"💬 Run Answer: {result['answer'][:150]}..."
            if len(result["answer"]) > 150
            else f"💬 Run Answer: {result['answer']}"
        )
        print(f"✅ Run Is Correct: {result['is_correct']}")
        print(f"⏱️  Run Duration: {result['response_duration_ms']:.2f} ms")
    print("-" * 80)

    return {
        "user_id": user_id,
        "category": search_result.get("category"),
        "question": question,
        "results": run_results,
        "golden_answer": search_result.get("golden_answer"),
        "all_options": search_result.get("all_options", []),
        "response_duration_ms": response_duration_ms,
        "search_context": context,
        "search_duration_ms": search_result.get("search_duration_ms"),
        "topic": search_result.get("topic"),
    }


def main(frame, version, num_runs=3, num_workers=4):
    print("\n" + "=" * 80)
    print(f"🚀 PERSONAMEM RESPONSE GENERATION - {frame.upper()} v{version}".center(80))
    print("=" * 80)

    load_dotenv()

    oai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )
    print(f"🔌 Using OpenAI client with model: {os.getenv('CHAT_MODEL')}")

    search_path = f"results/pm/{frame}-{version}/{frame}_pm_search_results.json"
    response_path = f"results/pm/{frame}-{version}/{frame}_pm_responses.json"

    print(f"📂 Loading search results from: {search_path}")
    with open(search_path) as file:
        pm_search_results = json.load(file)
    print(f"📊 Found {len(pm_search_results)} users to process")
    print(f"⚙️  Using {num_workers} worker threads")
    print("-" * 80)

    pm_responses = {}
    start_time = time()

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        future_to_user_id = {}

        for user_id, search_results in pm_search_results.items():
            future = executor.submit(process_qa, user_id, search_results, num_runs, oai_client)
            future_to_user_id[future] = user_id

        for future in tqdm(
            as_completed(future_to_user_id),
            total=len(future_to_user_id),
            desc="📝 Generating responses",
        ):
            user_id = future_to_user_id[future]
            try:
                result = future.result()
                pm_responses[user_id] = result
            except Exception as exc:
                print(f"\033[91m❌ Error processing user {user_id}: {exc}")

    end_time = time()
    elapsed_time = end_time - start_time
    elapsed_sec = int(elapsed_time)

    print("\n" + "=" * 80)
    print("✅ RESPONSE GENERATION COMPLETE".center(80))
    print("=" * 80)
    print(f"⏱️  Total time: {elapsed_sec // 60}m {elapsed_sec % 60}s")
    print(f"📊 Processed: {len(pm_responses)} users")
    print(f"🔄 Framework: {frame} | Version: {version}")

    with open(response_path, "w") as f:
        json.dump(pm_responses, f, indent=4)

    print(f"📁 Responses saved to: \033[1;94m{response_path}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PersonaMem Response Generation Script")
    parser.add_argument(
        "--lib",
        type=str,
        choices=[
            "memos-api-online",
            "zep",
            "mem0",
            "mem0_graph",
            "memos-api",
            "memobase",
            "memu",
            "supermemory",
        ],
        default="memos-api",
    )
    parser.add_argument(
        "--version", type=str, default="default", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--num_runs", type=int, default=3, help="Number of runs for LLM-as-a-Judge evaluation."
    )
    parser.add_argument(
        "--workers", type=int, default=10, help="Number of worker threads to use for processing."
    )

    args = parser.parse_args()
    main(frame=args.lib, version=args.version, num_runs=args.num_runs, num_workers=args.workers)
