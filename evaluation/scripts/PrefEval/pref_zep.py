import argparse
import concurrent.futures
import json
import os
import sys
import time

from datetime import datetime

import tiktoken

from dotenv import load_dotenv
from irrelevant_conv import irre_10, irre_300
from openai import OpenAI
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)
load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
BASE_URL = os.getenv("OPENAI_BASE_URL")
MODEL_NAME = os.getenv("MODEL_NAME", "gpt-4o-mini")
tokenizer = tiktoken.get_encoding("cl100k_base")


def add_memory_for_line(
    line_data: tuple,
    mem_client,
    num_irrelevant_turns: int,
    lib: str,
    version: str,
    success_records,
    f,
) -> dict:
    """
    Adds conversation memory for a single line of data to MemOS and returns the data with a persistent user_id.
    """
    i, line = line_data
    user_id = f"{lib}_user_pref_eval_{i}_{version}"

    try:
        original_data = json.loads(line)
        conversation = original_data.get("conversation", [])

        if num_irrelevant_turns == 10:
            conversation = conversation + irre_10
        elif num_irrelevant_turns == 300:
            conversation = conversation + irre_300

        start_time_add = time.monotonic()

        for idx, _ in enumerate(conversation[::2]):
            msg_idx = idx * 2
            record_id = f"{lib}_user_pref_eval_{i}_{version}_{msg_idx!s}"

            if record_id not in success_records:
                mem_client.add(
                    messages=conversation[msg_idx : msg_idx + 2],
                    user_id=user_id,
                    conv_id=None,
                    timestamp=datetime.now().isoformat(),
                )
                f.write(f"{record_id}\n")
                f.flush()

        end_time_add = time.monotonic()
        add_duration = end_time_add - start_time_add

        original_data["user_id"] = user_id
        original_data["metrics"] = {"add_memories_duration_seconds": add_duration}
        return original_data

    except Exception as e:
        print(f"Error adding memory for line {i + 1} (user_id: {user_id}): {e}")
        return None


def search_memory_for_line(line_data: tuple, mem_client, top_k_value: int) -> dict:
    """
    Processes a single line of data, searching memory based on the question.
    """
    i, line = line_data
    try:
        original_data = json.loads(line)

        user_id = original_data.get("user_id")
        question = original_data.get("question")
        metrics_dict = original_data.get("metrics", {})

        if not user_id:
            original_data["error"] = (
                "Error: user_id not found in this line. Please run 'add' mode first."
            )
            return original_data
        if not question:
            original_data["error"] = "Question not found in this line."
            return original_data

        start_time_search = time.monotonic()
        relevant_memories = mem_client.search(query=question, user_id=user_id, top_k=top_k_value)
        search_memories_duration = time.monotonic() - start_time_search
        memories_str = "\n".join(
            f"- {entry.get('memory', '')}" for entry in relevant_memories["text_mem"][0]["memories"]
        )

        memory_tokens_used = len(tokenizer.encode(memories_str))

        metrics_dict.update(
            {
                "search_memories_duration_seconds": search_memories_duration,
                "memory_tokens_used": memory_tokens_used,
                "retrieved_memories_text": memories_str,
            }
        )
        original_data["metrics"] = metrics_dict

        return original_data

    except Exception as e:
        user_id_from_data = json.loads(line).get("user_id", "N/A")
        print(f"Error searching memory for line {i + 1} (user_id: {user_id_from_data}): {e}")
        return None


def generate_response_for_line(line_data: tuple, openai_client: OpenAI) -> dict:
    """
    Generates a response for a single line of data using pre-fetched memories.
    """
    i, line = line_data
    try:
        original_data = json.loads(line)

        question = original_data.get("question")
        metrics_dict = original_data.get("metrics", {})
        memories_str = metrics_dict.get("retrieved_memories_text")

        # If an error occurred in 'add' or 'search' mode, just pass the line through
        if original_data.get("error"):
            return original_data

        if not question:
            original_data["error"] = "Question not found in this line."
            return original_data

        # Check for None, as an empty string (no memories found) is a valid result
        if memories_str is None:
            original_data["error"] = (
                "Error: retrieved_memories_text not found in metrics. "
                "Please run 'search' mode first."
            )
            return original_data

        system_prompt = f"You are a helpful AI. Answer the question based on the query and the following memories:\nUser Memories:\n{memories_str}"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ]

        response = openai_client.chat.completions.create(model=MODEL_NAME, messages=messages)
        assistant_response = response.choices[0].message.content
        original_data["response"] = assistant_response

        return original_data

    except Exception as e:
        user_id_from_data = json.loads(line).get("user_id", "N/A")
        print(f"Error generating response for line {i + 1} (user_id: {user_id_from_data}): {e}")
        return None


def main():
    parser = argparse.ArgumentParser(
        description="Process conversations with MemOS. Run 'add', then 'search', then 'response'."
    )
    parser.add_argument(
        "mode",
        choices=["add", "search", "response"],
        help="The mode to run the script in ('add', 'search', or 'response').",
    )
    parser.add_argument("--input", required=True, help="Path to the input JSONL file.")
    parser.add_argument("--output", required=True, help="Path to the output JSONL file.")
    parser.add_argument(
        "--top-k",
        type=int,
        default=10,
        help="Number of memories to retrieve (used in 'search' mode).",
    )
    parser.add_argument(
        "--add-turn",
        type=int,
        choices=[0, 10, 300],
        default=0,
        help="Number of irrelevant turns to add (used in 'add' mode).",
    )
    parser.add_argument(
        "--lib",
        type=str,
        choices=["zep"],
        default="zep",
        help="Which Zep library to use (used in 'add' mode).",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="0929-1",
        help="Version identifier for user_id generation (used in 'add' mode).",
    )
    parser.add_argument(
        "--max-workers", type=int, default=20, help="Maximum number of concurrent workers."
    )

    args = parser.parse_args()

    try:
        with open(args.input, encoding="utf-8") as infile:
            lines = infile.readlines()
    except FileNotFoundError:
        print(f"Error: Input file '{args.input}' not found")
        return

    from utils.client import ZepClient

    mem_client = ZepClient()

    os.makedirs(f"results/prefeval/{args.lib}_{args.version}", exist_ok=True)
    success_records = set()
    record_file = f"results/prefeval/{args.lib}_{args.version}/success_records.txt"
    if os.path.exists(record_file):
        print(f"Loading existing success records from {record_file}...")
        with open(record_file, encoding="utf-8") as f:
            for i in f.readlines():
                success_records.add(i.strip())
        print(f"Loaded {len(success_records)} records.")

    if args.mode == "add":
        print(f"Running in 'add' mode. Ingesting memories from '{args.input}'...")
        print(f"Adding {args.add_turn} irrelevant turns.")
        print(f"Using {args.max_workers} workers.")
        with (
            open(args.output, "w", encoding="utf-8") as outfile,
            concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor,
            open(record_file, "a+", encoding="utf-8") as f,
        ):
            futures = [
                executor.submit(
                    add_memory_for_line,
                    (i, line),
                    mem_client,
                    args.add_turn,
                    args.lib,
                    args.version,
                    success_records,
                    f,
                )
                for i, line in enumerate(lines)
            ]

            pbar = tqdm(
                concurrent.futures.as_completed(futures),
                total=len(lines),
                desc="Adding memories...",
            )
            for future in pbar:
                result = future.result()
                if result:
                    outfile.write(json.dumps(result, ensure_ascii=False) + "\n")
        print(f"\n'add' mode complete! Data with user_id written to '{args.output}'.")

    elif args.mode == "search":
        print(f"Running in 'search' mode. Searching memories based on '{args.input}'...")
        print(f"Retrieving top {args.top_k} memories for each query.")
        print(f"Using {args.max_workers} workers.")
        with (
            open(args.output, "w", encoding="utf-8") as outfile,
            concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor,
        ):
            futures = [
                executor.submit(search_memory_for_line, (i, line), mem_client, args.top_k)
                for i, line in enumerate(lines)
            ]

            pbar = tqdm(
                concurrent.futures.as_completed(futures),
                total=len(lines),
                desc="Searching memories...",
            )
            for future in pbar:
                result = future.result()
                if result:
                    outfile.write(json.dumps(result, ensure_ascii=False) + "\n")
        print(
            f"\n'search' mode complete! Results with retrieved memories written to '{args.output}'."
        )

    elif args.mode == "response":
        print(f"Running in 'response' mode. Generating responses based on '{args.input}'...")
        print(f"Using {args.max_workers} workers.")
        openai_client = OpenAI(api_key=OPENAI_API_KEY, base_url=BASE_URL)
        with (
            open(args.output, "w", encoding="utf-8") as outfile,
            concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor,
        ):
            futures = [
                executor.submit(generate_response_for_line, (i, line), openai_client)
                for i, line in enumerate(lines)
            ]

            pbar = tqdm(
                concurrent.futures.as_completed(futures),
                total=len(lines),
                desc="Generating responses...",
            )
            for future in pbar:
                result = future.result()
                if result:
                    outfile.write(json.dumps(result, ensure_ascii=False) + "\n")
        print(f"\n'response' mode complete! Final results written to '{args.output}'.")


if __name__ == "__main__":
    main()
