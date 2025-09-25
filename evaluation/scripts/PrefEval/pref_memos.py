import argparse
import concurrent.futures
import json
import os
import sys
import time
import tiktoken
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm

ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)
from utils.memos_api import MemOSAPI

load_dotenv()

memos_key = os.getenv("MEMOS_KEY")
memos_url = os.getenv("MEMOS_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
BASE_URL = os.getenv("OPENAI_BASE_URL")

MODEL_NAME = "gpt-4o-mini"
INPUT_FILE = "./data/prefeval/pref_processed.jsonl"
OUTPUT_FILE = "./data/prefeval/pref_memos.jsonl"

tokenizer = tiktoken.get_encoding("cl100k_base")


def process_line(line_data: tuple, mem_client: MemOSAPI, openai_client: OpenAI) -> dict | None:
    """Processes a single line from the input file."""
    i, line = line_data
    timestamp = int(time.time() * 1000)
    user_id = f"user_line_{i}_{timestamp}"
    conv_id = f"conv_line_{i}_{timestamp}"

    try:
        original_data = json.loads(line)
        conversation = original_data.get("conversation", [])
        question = original_data.get("question")

        if not question:
            original_data["response"] = "Question not found in this line."
            return original_data

        start_time_conv = time.monotonic()
        if conversation:
            mem_client.add(conversation, user_id, conv_id)
        add_conversation_duration = time.monotonic() - start_time_conv

        start_time_search = time.monotonic()
        relevant_memories = mem_client.search(query=question, user_id=user_id, top_k=6)
        search_memories_duration = time.monotonic() - start_time_search

        memories_str = "\n".join(
            f"- {entry.get('memoryValue', '')}"
            for entry in relevant_memories.get("memoryDetailList", [])
        )
        memory_tokens_used = len(tokenizer.encode(memories_str))

        system_prompt = f"You are a helpful AI. Answer the question based on the query and the following memories:\nUser Memories:\n{memories_str}"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ]

        response = openai_client.chat.completions.create(model=MODEL_NAME, messages=messages)
        assistant_response = response.choices[0].message.content
        original_data["response"] = assistant_response

        original_data["metrics"] = {
            "add_conversation_duration_seconds": add_conversation_duration,
            "search_memories_duration_seconds": search_memories_duration,
            "memory_tokens_used": memory_tokens_used,
            "retrieved_memories_text": memories_str,
        }
        return original_data

    except Exception as e:
        print(f"Error processing line {i + 1} (user_id: {user_id}): {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="Process a JSONL file using MemOS and OpenAI.")
    parser.add_argument(
        "--max-workers",
        type=int,
        default=10,
        help="Maximum number of worker threads to use for concurrent processing.",
    )
    args = parser.parse_args()

    max_workers = args.max_workers

    print(f"Starting concurrent processing for file: {INPUT_FILE} (Max workers: {max_workers})")

    try:
        with open(INPUT_FILE, "r", encoding="utf-8") as infile:
            lines = infile.readlines()
    except FileNotFoundError:
        print(f"Error: Input file not found '{INPUT_FILE}'")
        return

    mem_client = MemOSAPI()
    openai_client = OpenAI(api_key=OPENAI_API_KEY, base_url=BASE_URL)

    count = 0
    with open(OUTPUT_FILE, "w", encoding="utf-8") as outfile:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(process_line, (i, line), mem_client, openai_client)
                for i, line in enumerate(lines)
            ]

            pbar = tqdm(
                concurrent.futures.as_completed(futures),
                total=len(lines),
                desc="Processing concurrently...",
            )
            for future in pbar:
                try:
                    result = future.result()
                    if result:
                        outfile.write(json.dumps(result, ensure_ascii=False) + "\n")
                        count += 1
                except Exception as e:
                    print(f"A task failed to execute: {e}")

    print(f"\nProcessing complete! Successfully wrote {count} lines to {OUTPUT_FILE}.")


if __name__ == "__main__":
    main()
