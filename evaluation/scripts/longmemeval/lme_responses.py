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
from utils.prompts import LME_ANSWER_PROMPT


def lme_response(llm_client, context, question, question_date):
    prompt = LME_ANSWER_PROMPT.format(
        question=question,
        question_date=question_date,
        context=context,
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


def process_qa(user_id, search_result, llm_client):
    start = time()
    search_result = search_result[0]
    question = search_result.get("question")
    question_date = search_result.get("date")
    context = search_result.get("search_context", "")
    anwer = lme_response(llm_client, context, question, question_date)

    response_duration_ms = (time() - start) * 1000

    print("\n" + "-" * 80)
    print(f"🤖 Processed User: {user_id}")
    print(f"⏱️  Duration: {response_duration_ms:.2f} ms")
    print(f"❓ Question: {question}")
    print(f"💬 Answer: {anwer[:150]}..." if len(anwer) > 150 else f"💬 Answer: {anwer}")
    print("-" * 80)

    return {
        "user_id": user_id,
        "category": search_result.get("category"),
        "question": question,
        "answer": anwer,
        "question_date": question_date,
        "golden_answer": search_result.get("golden_answer"),
        "response_duration_ms": response_duration_ms,
        "search_context": context,
        "search_duration_ms": search_result.get("search_duration_ms"),
        "answer_evidences": search_result.get("answer_evidences", []),
    }


def main(frame, version, num_workers=4):
    print("\n" + "=" * 80)
    print(f"🚀 LONGMEMEVAL RESPONSE GENERATION - {frame.upper()} v{version}".center(80))
    print("=" * 80)

    load_dotenv()

    oai_client = OpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )

    print(f"🔌 Using OpenAI client with model: {os.getenv('CHAT_MODEL')}")

    search_path = f"results/lme/{frame}-{version}/{frame}_lme_search_results.json"
    response_path = f"results/lme/{frame}-{version}/{frame}_lme_responses.json"

    print(f"📂 Loading search results from: {search_path}")
    with open(search_path) as file:
        lme_search_results = json.load(file)
    print(f"📊 Found {len(lme_search_results)} users to process")
    print(f"⚙️  Using {num_workers} worker threads")
    print("-" * 80)

    lme_responses = {}
    start_time = time()

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        future_to_user_id = {}

        for user_id, search_results in lme_search_results.items():
            future = executor.submit(process_qa, user_id, search_results, oai_client)
            future_to_user_id[future] = user_id

        for future in tqdm(
            as_completed(future_to_user_id),
            total=len(future_to_user_id),
            desc="📝 Generating responses",
        ):
            user_id = future_to_user_id[future]
            try:
                result = future.result()
                lme_responses[user_id] = result
            except Exception as exc:
                print(f"❌ Error processing user {user_id}: {exc}")

    end_time = time()
    elapsed_time = end_time - start_time
    elapsed_sec = int(elapsed_time)

    print("\n" + "=" * 80)
    print("✅ RESPONSE GENERATION COMPLETE".center(80))
    print("=" * 80)
    print(f"⏱️ Total time: {elapsed_sec // 60}m {elapsed_sec % 60}s")
    print(f"📊 Processed: {len(lme_responses)} users")
    print(f"🔄 Framework: {frame} | Version: {version}")

    with open(response_path, "w") as f:
        json.dump(lme_responses, f, indent=4)

    print(f"📁 Responses saved to: {response_path}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LongMemeval Response Generation Script")
    parser.add_argument(
        "--lib",
        type=str,
        choices=[
            "mem0",
            "mem0_graph",
            "memos-api",
            "memos-api-online",
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
        "--workers", type=int, default=30, help="Number of runs for LLM-as-a-Judge evaluation."
    )

    args = parser.parse_args()
    main(frame=args.lib, version=args.version, num_workers=args.workers)
