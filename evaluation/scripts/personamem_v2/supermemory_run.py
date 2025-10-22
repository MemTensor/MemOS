import os
import json
import time
import tiktoken
import requests
import re
from collections import Counter
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm
import concurrent.futures 

load_dotenv()



OPENAI_API_KEY = "sk-DdYCtzDRelaQP5YrYTZJGruuHqof3FU48jG0iLfq0vqvyZSw"
BASE_URL = "http://123.129.219.111:3000/v1"
MODEL_NAME = "gpt-4o-mini"

INPUT_FILE = "./benchmark.jsonl"
OUTPUT_FILE = "./Personamem_supermemory.jsonl"

MAX_WORKERS = 10

tokenizer = tiktoken.get_encoding("cl100k_base")

class SupermemoryClient:
    def __init__(self):
        from supermemory import Supermemory

        self.client = Supermemory(api_key="sm_uX9U6SQ2YcQtAZoXBmc6BT_IByrArMsTbKjqiNNKyZjnZAzowqeqHNMXlyFMekpRpuxtWXciGOXsoDHPADcgmbE")

    def add(self, messages, user_id):
        content = "\n".join(
            [f" {msg['role']}: {msg['content']}" for msg in messages]
        )
        max_retries = 5
        for attempt in range(max_retries):
            try:
                self.client.memories.add(content=content, container_tag=user_id)
                break
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)  # 指数退避
                else:
                    raise e

    def search(self, query, user_id, top_k):
        max_retries = 10
        for attempt in range(max_retries):
            try:
                results = self.client.search.memories(
                    q=query,
                    container_tag=user_id,
                    threshold=0,
                    rerank=True,
                    rewrite_query=True,
                    limit=top_k,
                )
                context = "\n\n".join([r.memory for r in results.results])
                return context
            except Exception as e:
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)  # 指数退避
                else:
                    raise e

def parse_predicted_answer(response: str) -> str:
    """从响应中提取预测的答案选项 (a, b, c, d)"""
    # 尝试从<final_answer>标签后提取
    final_answer_match = re.search(r'<final_answer>\s*\(([a-d])\)', response)
    if final_answer_match:
        return final_answer_match.group(1).lower()
    
    # 尝试提取括号中的字母
    bracket_match = re.search(r'\(([a-d])\)', response)
    if bracket_match:
        return bracket_match.group(1).lower()
    
    # 尝试提取单独的字母
    letter_match = re.search(r'\b([a-d])\b', response, re.IGNORECASE)
    if letter_match:
        return letter_match.group(1).lower()
    
    # 尝试提取选项格式
    option_match = re.search(r'option\s*([a-d])', response, re.IGNORECASE)
    if option_match:
        return option_match.group(1).lower()
    
    return "unknown"

def process_line(line_data: tuple, mem_client: SupermemoryClient, openai_client: OpenAI) -> dict:
    i, line = line_data
    timestamp = int(time.time() * 1000)
    user_id = f"user_line_{i}_{timestamp}"
    conv_id = f"conv_line_{i}_{timestamp}"
    
    try:
        original_data = json.loads(line)
        conversation = original_data.get("chat_history", [])
        question = original_data.get("user_query")
        answer = original_data.get("answer")
        correct_answer = original_data.get("correct_answer_option", "").lower()  # 提取正确选项并转为小写
        
        if not question:
            original_data["response"] = "Question not found in this line."
            return original_data
        
        
        CHUNK_SIZE = 20  
        chunk_size = max(1, len(conversation) // CHUNK_SIZE) 
        
        start_time_conv = time.monotonic()
        if conversation:
            # 将对话分成多个块
            chunks = [conversation[i:i + chunk_size] for i in range(0, len(conversation), chunk_size)]
            
            # 添加每个块
            for chunk in chunks:
                mem_client.add(chunk, user_id)
        add_conversation_duration = time.monotonic() - start_time_conv
        time.sleep(30)
        # 搜索相关记忆
        start_time_search = time.monotonic()
        relevant_memories = mem_client.search(query=question, user_id=user_id, top_k=6)
        search_memories_duration = time.monotonic() - start_time_search

        memory_tokens_used = len(tokenizer.encode(relevant_memories))
        
        # 构建提示
        PM_ANSWER_PROMPT = f"""
You are a helpful assistant tasked with selecting the best answer to a user question, based solely on summarized conversation memories.

# CONTEXT:
The following are summarized facts and preferences extracted from prior user conversations. Use only these memories to answer the question.

{relevant_memories}

# INSTRUCTIONS:
1. Carefully read and reason over the memory summary.
2. Evaluate each of the four answer choices (a) through (d).
3. Choose the single best-supported answer based on the information in memory.
4. Output ONLY the final choice in the format (a), (b), (c), or (d), placed directly after the token <final_answer>.

# IMPORTANT RULES:
- Your final answer **must appear after** the token <final_answer>.
- Your final answer **must use parentheses**, like (a) or (b).
- Do NOT list multiple choices. Choose only one.
- Do NOT include extra text after <final_answer>. Just output the answer.

# QUESTION:
{question}

# OPTIONS:
{answer}

Final Answer:
<final_answer>
"""
        # 调用大语言模型获取回复
        response = openai_client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": PM_ANSWER_PROMPT}]
        )
        assistant_response = response.choices[0].message.content
        
        # 解析预测的答案
        predicted_answer = parse_predicted_answer(assistant_response)
        
        # 检查预测是否正确
        is_correct = predicted_answer == correct_answer if correct_answer else False
        
        # 构建结果
        result = {
            "user_id":user_id,
            "conv_id":conv_id,
            "user_query": question,
            "answer": answer,
            "response": assistant_response,
            "predicted_answer": predicted_answer,
            "correct_answer_option": correct_answer,
            "is_correct": is_correct,  # 添加正确性标记
            "metrics": {
                "add_conversation_duration_seconds": add_conversation_duration,
                "search_memories_duration_seconds": search_memories_duration,
                "memory_tokens_used": memory_tokens_used,
                "retrieved_memories_text": relevant_memories
            }
        }
        
        # 添加原始数据中的其他字段
        for key, value in original_data.items():
            if key not in ["question", "answer", "response", "predicted_answer", "metrics"]:
                result[key] = value
        
        return result

    except Exception as e:
        print(f"Error processing line {i + 1} (user_id: {user_id}): {e}")
        return None

def main():
    """
    Reads a JSONL file and processes all lines concurrently using a thread pool.
    """
    print(f"Starting concurrent processing for file: {INPUT_FILE} (Max workers: {MAX_WORKERS})")
    
    try:
        with open(INPUT_FILE, 'r', encoding='utf-8') as infile:
            lines = infile.readlines()
    except FileNotFoundError:
        print(f"Error: Input file not found '{INPUT_FILE}'")
        return

    mem_client = SupermemoryClient()
    openai_client = OpenAI(api_key=OPENAI_API_KEY, base_url=BASE_URL)
    
    # 用于统计答案选项的计数器
    answer_counter = Counter()
    # 用于统计正确性的计数器
    correct_counter = Counter()
    total_samples = 0
    correct_samples = 0

    count = 0
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as outfile:
        with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            futures = [
                executor.submit(process_line, (i, line), mem_client, openai_client) 
                for i, line in enumerate(lines)
            ]

            pbar = tqdm(concurrent.futures.as_completed(futures), total=len(lines), desc="Processing concurrently...")
            for future in pbar:
                try:
                    result = future.result()
                    if result:
                        # 写入文件
                        outfile.write(json.dumps(result, ensure_ascii=False) + '\n')
                        count += 1
                        
                        # 更新答案统计
                        if 'predicted_answer' in result:
                            predicted = result['predicted_answer']
                            answer_counter[predicted] += 1
                            
                            # 更新正确性统计
                            if 'is_correct' in result and result['is_correct']:
                                correct_counter[predicted] += 1
                                correct_samples += 1
                            
                            total_samples += 1
                except Exception as e:
                    print(f"A task failed to execute: {e}")

    # 打印答案统计结果
    print("\nPredicted answers distribution:")
    for option in ['a', 'b', 'c', 'd', 'unknown']:
        count = answer_counter.get(option, 0)
        percentage = (count / total_samples) * 100 if total_samples > 0 else 0
        print(f"{option.upper()}: {count} ({percentage:.2f}%)")
    
    # 打印正确性统计
    if total_samples > 0:
        overall_accuracy = (correct_samples / total_samples) * 100
        print(f"\nOverall Accuracy: {overall_accuracy:.2f}% ({correct_samples}/{total_samples})")
        
        print("\nAccuracy by option:")
        for option in ['a', 'b', 'c', 'd', 'unknown']:
            total_predicted = answer_counter.get(option, 0)
            correct_predicted = correct_counter.get(option, 0)
            if total_predicted > 0:
                accuracy = (correct_predicted / total_predicted) * 100
                print(f"{option.upper()}: {accuracy:.2f}% ({correct_predicted}/{total_predicted})")
            else:
                print(f"{option.upper()}: No predictions")
    else:
        print("\nNo samples processed for accuracy calculation.")
    
    print(f"\nProcessing complete! Successfully wrote {count} lines to {OUTPUT_FILE}.")


if __name__ == "__main__":
    main()