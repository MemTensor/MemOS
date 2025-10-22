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
from uuid import uuid4
from zep_cloud.client import Zep  # 使用同步客户端
from zep_cloud.types import EntityEdge, EntityNode

load_dotenv()

# Zep配置
ZEP_API_KEY = "z_1dWlkIjoiYTkyYjM4YmUtN2UzYy00NzNlLWIwNDQtZWVjMmJhNzQ0YWFkIn0.7jnpGb_vPRnhKNH5cvDZOooX44Ai5y0RXvvcMa_5BKv7qTbstXyoPvzrbeokQYZHuOgFk54IwBvJ7mFqmChQ8w"  # 确保在.env文件中设置

OPENAI_API_KEY = "sk-DdYCtzDRelaQP5YrYTZJGruuHqof3FU48jG0iLfq0vqvyZSw"
BASE_URL = "http://123.129.219.111:3000/v1"
MODEL_NAME = "gpt-4o-mini"

INPUT_FILE = "./benchmark.jsonl"
OUTPUT_FILE = "./Personamem_zep.jsonl"  # 修改输出文件名

MAX_WORKERS = 1

tokenizer = tiktoken.get_encoding("cl100k_base")

# 从第一段代码中复制的辅助函数
CONTEXT_STRING_TEMPLATE = """
FACTS and ENTITIES represent relevant context to the current conversation.

# These are the most relevant facts for the conversation along with the datetime of the event that the fact refers to.
If a fact mentions something happening a week ago, then the datetime will be the date time of last week and not the datetime
of when the fact was stated.
Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.
    
<FACTS>
{facts}
</FACTS>

# These are the most relevant entities
# ENTITY_NAME: entity summary
<ENTITIES>
{entities}
</ENTITIES>
"""

def format_fact(edge: EntityEdge) -> str:
    valid_at = edge.valid_at if edge.valid_at is not None else "date unknown"
    invalid_at = edge.invalid_at if edge.invalid_at is not None else "present"
    formatted_fact = f"  - {edge.fact} (Date range: {valid_at} - {invalid_at})"
    return formatted_fact

def format_entity(node: EntityNode) -> str:
    formatted_entity = f"  - {node.name}: {node.summary}"
    return formatted_entity

def compose_context_block(edges: list[EntityEdge], nodes: list[EntityNode]) -> str:
    facts = [format_fact(edge) for edge in edges]
    entities = [format_entity(node) for node in nodes]
    return CONTEXT_STRING_TEMPLATE.format(facts='\n'.join(facts), entities='\n'.join(entities))

def remove_parentheses(text):
    """移除括号及其内容"""
    while '(' in text and ')' in text:
        text = re.sub(r'\([^()]*\)', '', text)
    return text

class ZepAPI:
    def __init__(self, api_key: str = ZEP_API_KEY):
        self.client = Zep(api_key=api_key)
    
    def create_graph(self, graph_id: str):
        """创建知识图谱"""
        try:
            self.client.graph.create(graph_id=graph_id)
        except Exception:
            pass  # 图谱可能已存在
    
    def add_messages(self, messages: list, graph_id: str):
        """添加消息到知识图谱"""
        for msg in messages:
            role = msg["role"]
            content = msg["content"]
            self.client.graph.add(
                data=f"{role}: {content}",
                type='message',
                graph_id=graph_id
            )
    
    def search_memories(self, query: str, graph_id: str, top_k: int = 10):
        """搜索相关记忆"""
        # 分别搜索节点和边
        search_results_nodes = self.client.graph.search(
            query=query,
            graph_id=graph_id,
            scope='nodes',
            reranker='cross_encoder',
            limit=top_k
        )
        
        search_results_edges = self.client.graph.search(
            query=query,
            graph_id=graph_id,
            scope='edges',
            reranker='cross_encoder',
            limit=top_k
        )
        
        return search_results_edges.edges, search_results_nodes.nodes

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

def process_line(line_data: tuple, zep_client: ZepAPI, openai_client: OpenAI) -> dict:
    i, line = line_data
    timestamp = int(time.time() * 1000)
    user_id = f"user_line_{i}_{timestamp}"
    graph_id = f"graph_line_{i}_{timestamp}"  # 使用graph_id替代conv_id
    
    try:
        original_data = json.loads(line)
        conversation = original_data.get("chat_history", [])
        question = original_data.get("user_query")
        answer = original_data.get("answer")
        correct_answer = original_data.get("correct_answer_option", "").lower()  # 添加正确选项提取
        
        if not question:
            original_data["response"] = "Question not found in this line."
            return original_data
        
        # 创建知识图谱
        start_time_conv = time.monotonic()
        zep_client.create_graph(graph_id)
        
        # 添加对话历史到Zep知识图谱
        zep_client.add_messages(conversation, graph_id)
        add_conversation_duration = time.monotonic() - start_time_conv
        
        # 等待Zep处理消息 (减少等待时间)
        time.sleep(30)
        
        # 搜索相关记忆
        start_time_search = time.monotonic()
        edges, nodes = zep_client.search_memories(query=question, graph_id=graph_id, top_k=6)
        context_block = compose_context_block(edges, nodes)
        search_memories_duration = time.monotonic() - start_time_search

        memory_tokens_used = len(tokenizer.encode(context_block))
        
        # 构建提示
        PM_ANSWER_PROMPT = f"""
You are a helpful assistant tasked with selecting the best answer to a user question, based solely on summarized conversation memories.

# CONTEXT:
The following are summarized facts and preferences extracted from prior user conversations. Use only these memories to answer the question.

{remove_parentheses(context_block)}

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
            "grapg_id":graph_id,
            "user_query": question,
            "answer": answer,
            "response": assistant_response,
            "predicted_answer": predicted_answer,
            "correct_answer_option": correct_answer,  # 添加正确选项
            "is_correct": is_correct,  # 添加正确性标记
            "metrics": {
                "add_conversation_duration_seconds": add_conversation_duration,
                "search_memories_duration_seconds": search_memories_duration,
                "memory_tokens_used": memory_tokens_used,
                "retrieved_memories_text": context_block
            }
        }
        
        # 添加原始数据中的其他字段
        for key, value in original_data.items():
            if key not in ["question", "answer", "response", "predicted_answer", "metrics"]:
                result[key] = value
        
        return result

    except Exception as e:
        print(f"Error processing line {i + 1} (graph_id: {graph_id}): {e}")
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

    zep_client = ZepAPI()
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
                executor.submit(process_line, (i, line), zep_client, openai_client) 
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