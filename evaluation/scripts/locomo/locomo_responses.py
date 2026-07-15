import argparse
import asyncio
import json
import os
import sys

from time import time

import pandas as pd

from dotenv import load_dotenv
from openai import AsyncOpenAI
from prompts import ANSWER_PROMPT_MEM0, ANSWER_PROMPT_MEMOS, ANSWER_PROMPT_ZEP
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


async def locomo_response(frame, llm_client, context: str, question: str) -> str:
    if frame == "zep":
        prompt = ANSWER_PROMPT_ZEP.format(
            context=context,
            question=question,
        )
    elif frame == "mem0" or frame == "mem0_graph":
        prompt = ANSWER_PROMPT_MEM0.format(
            context=context,
            question=question,
        )
    else:
        prompt = ANSWER_PROMPT_MEMOS.format(
            context=context,
            question=question,
        )
    response = await llm_client.chat.completions.create(
        model=os.getenv("CHAT_MODEL"),
        messages=[
            {"role": "system", "content": prompt},
        ],
        temperature=0,
    )
    result = response.choices[0].message.content or ""

    return result


async def process_qa(frame, qa, search_result, oai_client):
    start = time()
    query = qa.get("question")
    gold_answer = qa.get("answer")
    qa_category = qa.get("category")

    context = search_result.get("context")

    answer = await locomo_response(frame, oai_client, context, query)

    response_duration_ms = (time() - start) * 1000

    print(f"Processed question: {query}")
    print(f"Answer: {answer}")
    return {
        "question": query,
        "answer": answer,
        "category": qa_category,
        "golden_answer": gold_answer,
        "search_context": search_result.get("context", ""),
        "response_duration_ms": response_duration_ms,
        "search_duration_ms": search_result.get("duration_ms", 0),
    }


async def main(frame, version="default"):
    search_path = f"results/locomo/{frame}-{version}/{frame}_locomo_search_results.json"
    response_path = f"results/locomo/{frame}-{version}/{frame}_locomo_responses.json"

    load_dotenv()
    oai_client = AsyncOpenAI(
        api_key=os.getenv("CHAT_MODEL_API_KEY"), base_url=os.getenv("CHAT_MODEL_BASE_URL")
    )

    locomo_df = pd.read_json("data/locomo/locomo10.json")
    with open(search_path) as file:
        locomo_search_results = json.load(file)

    num_users = 10

    all_responses = {}
    for group_idx in range(num_users):
        qa_set = locomo_df["qa"].iloc[group_idx]
        qa_set_filtered = [qa for qa in qa_set if qa.get("category") != 5]

        group_id = f"locomo_exp_user_{group_idx}"
        search_results = locomo_search_results.get(group_id)

        matched_pairs = []
        for qa in qa_set_filtered:
            question = qa.get("question")
            matching_result = next(
                (result for result in search_results if result.get("query") == question), None
            )
            if matching_result:
                matched_pairs.append((qa, matching_result))
            else:
                print(f"Warning: No matching search result found for question: {question}")

        tasks = [
            process_qa(frame, qa, search_result, oai_client)
            for qa, search_result in tqdm(
                matched_pairs,
                desc=f"Processing {group_id}",
                total=len(matched_pairs),
            )
        ]

        responses = await asyncio.gather(*tasks)
        all_responses[group_id] = responses

    os.makedirs("data", exist_ok=True)

    with open(response_path, "w") as f:
        json.dump(all_responses, f, indent=2)
        print("Save response results")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
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
        "--version",
        type=str,
        default="default",
        help="Version identifier for loading results (e.g., 1010)",
    )
    args = parser.parse_args()
    lib = args.lib
    version = args.version
    asyncio.run(main(lib, version))
