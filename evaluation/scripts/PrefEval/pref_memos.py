import os
import json
import time
import tiktoken
import requests
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm
import concurrent.futures
import argparse 

load_dotenv()

memos_key = os.getenv("MEMOS_KEY")
memos_url = os.getenv("MEMOS_URL")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
BASE_URL = os.getenv("OPENAI_BASE_URL")

MODEL_NAME = "gpt-4o-mini"
INPUT_FILE = "./data/prefeval/pref_processed.jsonl"
OUTPUT_FILE = "./data/prefeval/pref_memos.jsonl"

tokenizer = tiktoken.get_encoding("cl100k_base")

class MemOSAPI:
    """A client for interacting with the MemOS API."""
    def __init__(self, base_url: str = memos_url, memos_key: str = memos_key):
        self.base_url = base_url
        self.headers = {"Content-Type": "application/json", "Authorization": memos_key}

    def add(self, messages: list[dict], user_id: str | None = None, conv_id: str | None = None):
        """Create memories with retries."""
        retry = 0
        while retry < 10:
            try:
                url = f"{self.base_url}/add/message"
                payload = json.dumps({"messages": messages, "userId": user_id, "conversationId": conv_id})
                response = requests.post(url, data=payload, headers=self.headers)
                response.raise_for_status()
                response_data = response.json()
                if response_data.get('code') == 0:
                    return response.text
                else:
                    raise Exception(f"API Error: {response.text}")
            except Exception as e:
                print(f'Call to memos API "add" failed: {e}, retry {retry}')
                retry += 1
        raise Exception("Failed to add memory after 10 retries.")

    def search(self, query: str, user_id: str | None = None, conv_id: str | None = '', top_k: int = 10):
        """Search memories with retries."""
        retry = 0
        while retry < 10:
            try:
                url = f"{self.base_url}/search/memory"
                payload = json.dumps(
                    {
                        "query": query,
                        "userId": user_id,
                        "conversationId": conv_id,
                        "memoryLimitNumber": top_k
                    }, ensure_ascii=False
                )
                response = requests.post(url, data=payload, headers=self.headers)
                response.raise_for_status()
                response_data = response.json()
                if response_data.get('code') == 0:
                    return response_data.get("data")
                else:
                    raise Exception(f"API Error: {response.text}")
            except Exception as e:
                print(f'Call to memos API "search" failed: {e}, retry {retry}')
                retry += 1
        raise Exception("Failed to search memory after 10 retries.")

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

        memories_str = "\n".join(f"- {entry.get('memoryValue', '')}" for entry in relevant_memories.get('memoryDetailList', []))
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
            "add_conversation_duration_seconds": add_conversation_duration,
            "search_memories_duration_seconds": search_memories_duration,
            "memory_tokens_used": memory_tokens_used,
            "retrieved_memories_text": memories_str
        }
        return original_data

    except Exception as e:
        print(f"Error processing line {i + 1} (user_id: {user_id}): {e}")
        return None

def main():
    parser = argparse.ArgumentParser(description="Process a JSONL file using MemOS and OpenAI.")
    parser.add_argument(
        '--max-workers',
        type=int,
        default=10,
        help='Maximum number of worker threads to use for concurrent processing.'
    )
    args = parser.parse_args()

    max_workers = args.max_workers
    
    print(f"Starting concurrent processing for file: {INPUT_FILE} (Max workers: {max_workers})")
    
    try:
        with open(INPUT_FILE, 'r', encoding='utf-8') as infile:
            lines = infile.readlines()
    except FileNotFoundError:
        print(f"Error: Input file not found '{INPUT_FILE}'")
        return

    mem_client = MemOSAPI()
    openai_client = OpenAI(api_key=OPENAI_API_KEY, base_url=BASE_URL)

    count = 0
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as outfile:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(process_line, (i, line), mem_client, openai_client) 
                for i, line in enumerate(lines)
            ]

            pbar = tqdm(concurrent.futures.as_completed(futures), total=len(lines), desc="Processing concurrently...")
            for future in pbar:
                try:
                    result = future.result()
                    if result:
                        outfile.write(json.dumps(result, ensure_ascii=False) + '\n')
                        count += 1
                except Exception as e:
                    print(f"A task failed to execute: {e}")

    print(f"\nProcessing complete! Successfully wrote {count} lines to {OUTPUT_FILE}.")

if __name__ == "__main__":
    main()