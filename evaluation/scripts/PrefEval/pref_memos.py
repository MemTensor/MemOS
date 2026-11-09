import argparse
import concurrent.futures
import json
import os
import sys
import time
import traceback

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
BASE_URL = os.getenv("OPENAI_API_BASE")
MODEL_NAME = os.getenv("MODEL_NAME", "gpt-4o-mini")
tokenizer = tiktoken.get_encoding("cl100k_base")


def add_memory_for_line(
    line_data, mem_client, num_irrelevant_turns, lib, version, success_records, f
):
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
                    batch_size=2,
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


def search_memory_for_line(line_data, mem_client, top_k_value):
    """
    Processes a single line of data, searching memory based on the question.
    """

    i, line = line_data
    # Pre-declare so the except handler can reuse the already-parsed dict
    # rather than re-parsing ``line`` (which would discard any intermediate
    # state already set on ``original_data``).
    original_data = None
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

        # Defensively extract the first text_mem bucket's memories. An empty
        # ``text_mem`` list (or a bucket without a ``memories`` key) is a
        # valid "no retrieved text memories" state — not an error — and the
        # row must still flow to the response/judge stages.
        text_mem_entries: list = []
        if isinstance(relevant_memories, dict):
            text_mem_list = relevant_memories.get("text_mem") or []
            if text_mem_list and isinstance(text_mem_list[0], dict):
                text_mem_entries = text_mem_list[0].get("memories") or []
        pref_string = (
            relevant_memories.get("pref_string", "") if isinstance(relevant_memories, dict) else ""
        )
        # Build the memories blob so an empty ``text_mem`` + empty
        # ``pref_string`` yields ``""`` instead of a bare ``"\n"``. Downstream
        # (and plain ``if not memories_str`` truthiness checks) then correctly
        # treat the "no memories retrieved" case.
        memory_lines = [f"- {entry.get('memory', '')}" for entry in text_mem_entries]
        if pref_string:
            memory_lines.append(pref_string)
        memories_str = "\n".join(memory_lines).strip()

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
        # Preserve the sample instead of returning ``None`` and letting the
        # writer gate silently drop it. The row carries an ``error`` field so
        # the response stage passes it through, and ``retrieved_memories_text``
        # is set to an empty string so the row's downstream contract matches
        # the "no memories retrieved" case the response stage already handles.
        #
        # Reuse ``original_data`` whenever the top-level ``json.loads`` already
        # succeeded (the common case: a ``mem_client.search`` / tokenizer /
        # metrics-update failure). Only fall back to re-parsing when the parse
        # itself was the raising statement.
        if original_data is not None:
            fallback_data = original_data
        else:
            try:
                fallback_data = json.loads(line)
            except Exception:
                fallback_data = None
        user_id_from_data = fallback_data.get("user_id", "N/A") if fallback_data else "N/A"
        # Log the full traceback so the originating frame (e.g. ``mem_client``,
        # ``tokenizer.encode``, ``metrics_dict.update``) is diagnosable even
        # after the exception has been swallowed into the row's ``error`` field.
        print(
            f"Error searching memory for line {i + 1} "
            f"(user_id: {user_id_from_data}): {e}\n{traceback.format_exc()}"
        )
        if fallback_data is None:
            return None
        fallback_data.setdefault("metrics", {})["retrieved_memories_text"] = ""
        new_error = f"search_error: {e}"
        prev_error = fallback_data.get("error")
        fallback_data["error"] = f"{prev_error}; {new_error}" if prev_error else new_error
        return fallback_data


def generate_response_for_line(line_data, openai_client, lib):
    """
    Generates a response for a single line of data using pre-fetched memories.
    """
    from utils.prompts import PREFEVAL_ANSWER_PROMPT

    i, line = line_data
    # Pre-declare so the except handler can reuse the already-parsed dict
    # rather than re-parsing ``line`` and losing any intermediate state
    # (e.g. ``metrics`` fields already populated earlier).
    original_data = None
    try:
        original_data = json.loads(line)

        question = original_data.get("question")
        metrics_dict = original_data.get("metrics", {})
        memories_str = metrics_dict.get("retrieved_memories_text")

        # If an error occurred in 'add' or 'search' mode, pass the line
        # through. pref_eval.py reads ``data["response"]`` on every row, so
        # we guarantee the key exists even for already-flagged failures.
        if original_data.get("error"):
            original_data.setdefault("response", "")
            return original_data

        if not question:
            original_data["error"] = "Question not found in this line."
            original_data.setdefault("response", "")
            return original_data

        # Check for None, as an empty string (no memories found) is a valid result
        if memories_str is None:
            original_data["error"] = (
                "Error: retrieved_memories_text not found in metrics. "
                "Please run 'search' mode first."
            )
            original_data.setdefault("response", "")
            return original_data

        system_prompt = PREFEVAL_ANSWER_PROMPT.format(context=memories_str)
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question},
        ]

        response = openai_client.chat.completions.create(model=MODEL_NAME, messages=messages)
        assistant_response = response.choices[0].message.content
        original_data["response"] = assistant_response

        return original_data

    except Exception as e:
        # Preserve the sample instead of returning ``None`` and letting the
        # writer gate silently drop it. The row keeps a ``response`` placeholder
        # so ``pref_eval.py``'s judge still sees it (and classifies the empty
        # response as an Unhelpful Response, the correct accounting for an
        # upstream API failure).
        #
        # Reuse ``original_data`` whenever the top-level ``json.loads`` already
        # succeeded; re-parse ``line`` only if the parse itself was the raising
        # statement. Reusing the parsed dict preserves intermediate state (for
        # instance, ``metrics`` that was already populated by the search stage
        # and read from ``line``).
        if original_data is not None:
            fallback_data = original_data
        else:
            try:
                fallback_data = json.loads(line)
            except Exception:
                fallback_data = None
        user_id_from_data = fallback_data.get("user_id", "N/A") if fallback_data else "N/A"
        print(
            f"Error generating response for line {i + 1} "
            f"(user_id: {user_id_from_data}): {e}\n{traceback.format_exc()}"
        )
        if fallback_data is None:
            return None
        new_error = f"response_error: {e}"
        prev_error = fallback_data.get("error")
        # Preserve any pre-existing ``error`` (e.g. flagged by the search
        # stage) instead of silently discarding it.
        fallback_data["error"] = f"{prev_error}; {new_error}" if prev_error else new_error
        fallback_data.setdefault("response", "")
        return fallback_data


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
        choices=["memos-api", "memos-api-online"],
        default="memos-api",
        help="Which MemOS library to use (used in 'add' mode).",
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

    from utils.client import MemosApiClient, MemosApiOnlineClient

    if args.lib == "memos-api":
        mem_client = MemosApiClient()
    elif args.lib == "memos-api-online":
        mem_client = MemosApiOnlineClient()

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
            open(record_file, "a+", encoding="utf-8") as record_f,
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
                    record_f,
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
                executor.submit(generate_response_for_line, (i, line), openai_client, args.lib)
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
