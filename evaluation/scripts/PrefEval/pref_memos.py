import os
import sys
import json
import time
import uuid
import tiktoken
import requests
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm
import concurrent.futures
import argparse  
from irrelevant_conv import irre_10, irre_300

ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)

from utils.client import memos_api_client

load_dotenv()

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
BASE_URL = os.getenv("OPENAI_BASE_URL")
MODEL_NAME = os.getenv("MODEL_NAME", "gpt-4o-mini")

tokenizer = tiktoken.get_encoding("cl100k_base")


def add_memory_for_line(line_data: tuple, mem_client, num_irrelevant_turns: int, lib: str, version: str) -> dict:
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
        
        turns_add = 5
        if conversation:
            for chunk_start in range(0, len(conversation), turns_add * 2):
                chunk = conversation[chunk_start : chunk_start + turns_add * 2]
                mem_client.add(messages=chunk, user_id=user_id, mem_cube_id=user_id, conversation_id=None)
        
        original_data["user_id"] = user_id
        return original_data

    except Exception as e:
        print(f"Error adding memory for line {i + 1} (user_id: {user_id}): {e}")
        return None


def process_line_with_id(line_data: tuple, mem_client, openai_client: OpenAI, top_k_value: int, lib: str, version: str) -> dict:
    """
    Processes a single line of data using a pre-existing user_id, searching memory and generating a response.
    """
    i, line = line_data
    try:
        original_data = json.loads(line)
        
        user_id = original_data.get("user_id")
        question = original_data.get("question")

        if not user_id:
            original_data["response"] = "Error: user_id not found in this line. Please run 'add' mode first."
            return original_data
        if not question:
            original_data["response"] = "Question not found in this line."
            return original_data

        
        start_time_search = time.monotonic()
        relevant_memories = mem_client.search(query=question, user_id=user_id, top_k=top_k_value)
        search_memories_duration = time.monotonic() - start_time_search
        # print(relevant_memories)
        memories_str = "\n".join(f"- {entry.get('memory', '')}" for entry in relevant_memories["text_mem"][0]['memories'])

        
        memory_tokens_used = len(tokenizer.encode(memories_str))
        
        system_prompt = f"You are a helpful AI. Answer the question based on the query and the following memories:\nUser Memories:\n{memories_str}"
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": question}
        ]
        
        response = openai_client.chat.completions.create(model=MODEL_NAME, messages=messages)
        assistant_response = response.choices[0].message.content
        original_data["response"] = assistant_response

        original_data["metrics"] = {
            "search_memories_duration_seconds": search_memories_duration,
            "memory_tokens_used": memory_tokens_used,
            "retrieved_memories_text": memories_str
        }
        return original_data

    except Exception as e:
        user_id_from_data = json.loads(line).get('user_id', 'N/A')
        print(f"Error processing line {i + 1} (user_id: {user_id_from_data}): {e}")
        return None


def main():
    parser = argparse.ArgumentParser(description="Process conversations with MemOS. Run 'add' mode first, then 'process' mode.")
    parser.add_argument("mode", choices=["add", "process"], help="The mode to run the script in ('add' or 'process').")
    parser.add_argument("--input", required=True, help="Path to the input JSONL file.")
    parser.add_argument("--output", required=True, help="Path to the output JSONL file.")
    parser.add_argument("--top-k", type=int, default=10, help="Number of memories to retrieve.")
    parser.add_argument("--add-turn", type=int, choices=[0, 10, 300], default=0, help="Number of irrelevant turns to add (0, 10, or 300).")
    parser.add_argument("--lib", type=str, choices=["memos-api", "memos-local"], default="memos-api", help="Which MemOS library to use.")
    parser.add_argument("--version", type=str, default="0929-1", help="Version identifier for user_id generation.")
    parser.add_argument("--max-workers", type=int, default=20, help="Maximum number of concurrent workers.")
    
    args = parser.parse_args()

    try:
        with open(args.input, 'r', encoding='utf-8') as infile:
            lines = infile.readlines()
    except FileNotFoundError:
        print(f"Error: Input file '{args.input}' not found")
        return

    mem_client = memos_api_client()
    
    if args.mode == "add":
        print(f"Running in 'add' mode. Ingesting memories from '{args.input}'...")
        print(f"Adding {args.add_turn} irrelevant turns.") 
        print(f"Using {args.max_workers} workers.") 
        with open(args.output, 'w', encoding='utf-8') as outfile:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:

                futures = [executor.submit(add_memory_for_line, (i, line), mem_client, args.add_turn, args.lib, args.version) for i, line in enumerate(lines)]
                
                pbar = tqdm(concurrent.futures.as_completed(futures), total=len(lines), desc="Adding memories...")
                for future in pbar:
                    result = future.result()
                    if result:
                        outfile.write(json.dumps(result, ensure_ascii=False) + '\n')
        print(f"\n'add' mode complete! Data with user_id written to '{args.output}'.")

    elif args.mode == "process":
        print(f"Running in 'process' mode. Processing questions from '{args.input}'...")
        print(f"Retrieving top {args.top_k} memories for each query.") 
        print(f"Using {args.max_workers} workers.") 
        openai_client = OpenAI(api_key=OPENAI_API_KEY, base_url=BASE_URL)
        with open(args.output, 'w', encoding='utf-8') as outfile:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:

                futures = [executor.submit(process_line_with_id, (i, line), mem_client, openai_client, args.top_k, args.lib, args.version) for i, line in enumerate(lines)]

                pbar = tqdm(concurrent.futures.as_completed(futures), total=len(lines), desc="Processing questions...")
                for future in pbar:
                    result = future.result()
                    if result:
                        outfile.write(json.dumps(result, ensure_ascii=False) + '\n')
        print(f"\n'process' mode complete! Final results written to '{args.output}'.")


if __name__ == "__main__":
    main()