import os
import json
import time
import tiktoken
import re
from collections import Counter
from dotenv import load_dotenv
from openai import OpenAI
from tqdm import tqdm
import concurrent.futures
import yaml
import mirix
from mirix import Mirix, EmbeddingConfig, LLMConfig

# load_dotenv()

# # Mirix 配置
# MIRIX_CONFIG_PATH = "/mnt/afs/codes/chl/chl/prefeval/config.yaml"


# OPENAI_API_KEY = "sk-DdYCtzDRelaQP5YrYTZJGruuHqof3FU48jG0iLfq0vqvyZSw"
# BASE_URL = "http://123.129.219.111:3000/v1"
# MODEL_NAME = "gpt-4o-mini"

# INPUT_FILE = "./benchmark.jsonl"
# OUTPUT_FILE = "./Personamem_mirix.jsonl"  # 修改输出文件名

# MAX_WORKERS = 1

# tokenizer = tiktoken.get_encoding("cl100k_base")

# def get_mirix_client(config_path, load_from=None):
#     """创建并配置 Mirix 客户端"""
#     if os.path.exists(os.path.expanduser(f"~/.mirix")):
#         os.system(f"rm -rf ~/.mirix/*")

#     with open(config_path, "r") as f:
#         agent_config = yaml.safe_load(f)

#     os.environ['OPENAI_API_KEY'] = agent_config['api_key']
    
#     embedding_default_config = EmbeddingConfig(
#         embedding_model=agent_config['embedding_model_name'],
#         embedding_endpoint_type="openai",
#         embedding_endpoint=agent_config['model_endpoint'],
#         embedding_dim=1536,
#         embedding_chunk_size=8191,
#     )

#     llm_default_config = LLMConfig(
#         model=agent_config['model_name'],
#         model_endpoint_type="openai",
#         model_endpoint=agent_config['model_endpoint'],
#         api_key=agent_config['api_key'],
#         model_wrapper=None,
#         context_window=128000,
#     )

#     def embedding_default_config_func(cls, model_name=None, provider=None):
#         return embedding_default_config

#     def llm_default_config_func(cls, model_name=None, provider=None):
#         return llm_default_config

#     mirix.EmbeddingConfig.default_config = embedding_default_config_func
#     mirix.LLMConfig.default_config = llm_default_config_func

#     assistant = Mirix(
#         api_key=agent_config['api_key'], 
#         config_path=config_path, 
#         model=agent_config['model_name'], 
#         load_from=load_from
#     )
#     return assistant

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

# def process_line(line_data: tuple, mirix_client: Mirix, openai_client: OpenAI) -> dict:
#     i, line = line_data
#     timestamp = int(time.time() * 1000)
#     session_id = f"session_{i}_{timestamp}"
    
#     try:
#         original_data = json.loads(line)
#         conversation = original_data.get("chat_history", [])
#         question = original_data.get("user_query")
#         answer = original_data.get("answer")
        
#         if not question:
#             original_data["response"] = "Question not found in this line."
#             return original_data
        
#         # 将对话历史转换为字符串格式
#         conversation_str = "\n".join(
#             f"{msg['role']}: {msg['content']}" for msg in conversation
#         )
        
#         # 添加对话历史到 Mirix
#         start_time_conv = time.monotonic()
#         mirix_client.add(conversation_str)
#         add_conversation_duration = time.monotonic() - start_time_conv
        
#         # 等待 Mirix 处理消息
#         time.sleep(5)
        
#         # 构建提问字符串
#         question_with_options = f"{question}\nOptions:\n{answer}"
        
#         # 使用 Mirix 获取回答
#         start_time_search = time.monotonic()
#         response = mirix_client.chat(question_with_options)
#         search_memories_duration = time.monotonic() - start_time_search

#         # 获取响应内容
#         assistant_response = response.content if hasattr(response, 'content') else str(response)
        
#         # 解析预测的答案
#         predicted_answer = parse_predicted_answer(assistant_response)
        
#         # 构建结果
#         result = {
#             "user_query": question,
#             "answer": answer,
#             "response": assistant_response,
#             "predicted_answer": predicted_answer,
#             "metrics": {
#                 "add_conversation_duration_seconds": add_conversation_duration,
#                 "search_memories_duration_seconds": search_memories_duration,
#                 "memory_tokens_used": 0,  # Mirix 不提供此信息
#                 "retrieved_memories_text": "Retrieved by Mirix internal system"
#             }
#         }
        
#         # 添加原始数据中的其他字段
#         for key, value in original_data.items():
#             if key not in ["question", "answer", "response", "predicted_answer", "metrics"]:
#                 result[key] = value
        
#         return result

#     except Exception as e:
#         print(f"Error processing line {i + 1} (session_id: {session_id}): {e}")
#         return None

# def main():
#     """
#     Reads a JSONL file and processes all lines concurrently using a thread pool.
#     """
#     print(f"Starting concurrent processing for file: {INPUT_FILE} (Max workers: {MAX_WORKERS})")
    
#     try:
#         with open(INPUT_FILE, 'r', encoding='utf-8') as infile:
#             lines = infile.readlines()
#     except FileNotFoundError:
#         print(f"Error: Input file not found '{INPUT_FILE}'")
#         return

#     # 创建 OpenAI 客户端
#     openai_client = OpenAI(api_key=OPENAI_API_KEY, base_url=BASE_URL)
    
#     # 用于统计答案选项的计数器
#     answer_counter = Counter()

#     count = 0
#     with open(OUTPUT_FILE, 'w', encoding='utf-8') as outfile:
#         with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
#             futures = []
#             for i, line in enumerate(lines):
#                 # 为每个任务创建独立的 Mirix 客户端
#                 mirix_client = get_mirix_client(MIRIX_CONFIG_PATH)
#                 futures.append(
#                     executor.submit(process_line, (i, line), mirix_client, openai_client)
#                 )

#             pbar = tqdm(concurrent.futures.as_completed(futures), total=len(lines), desc="Processing concurrently...")
#             for future in pbar:
#                 try:
#                     result = future.result()
#                     if result:
#                         # 写入文件
#                         outfile.write(json.dumps(result, ensure_ascii=False) + '\n')
#                         count += 1
                        
#                         # 更新答案统计
#                         if 'predicted_answer' in result:
#                             answer_counter[result['predicted_answer']] += 1
#                 except Exception as e:
#                     print(f"A task failed to execute: {e}")

#     # 打印答案统计结果
#     print("\nPredicted answers distribution:")
#     for option in ['a', 'b', 'c', 'd', 'unknown']:
#         count = answer_counter.get(option, 0)
#         percentage = (count / len(lines)) * 100 if len(lines) > 0 else 0
#         print(f"{option.upper()}: {count} ({percentage:.2f}%)")
    
#     print(f"\nProcessing complete! Successfully wrote {count} lines to {OUTPUT_FILE}.")


# if __name__ == "__main__":
#     main()



import os
import json
import time
import yaml
from tqdm import tqdm
import sqlite3
import json

def get_mirix_client(config_path):
    """初始化并返回Mirix客户端，增加重试机制"""
    max_retries = 3
    retry_delay = 2  # 秒
    
    for attempt in range(max_retries):
        try:
            if os.path.exists(os.path.expanduser("~/.mirix")):
                os.system("rm -rf ~/.mirix/*")
            
            with open(config_path, "r") as f:
                agent_config = yaml.safe_load(f)
            
            os.environ['OPENAI_API_KEY'] = agent_config['api_key']
            import mirix
            from mirix import Mirix, EmbeddingConfig, LLMConfig
            
            # 创建默认配置
            embedding_config = EmbeddingConfig(
                embedding_model=agent_config['embedding_model_name'],
                embedding_endpoint_type="openai",
                embedding_endpoint=agent_config['model_endpoint'],
                embedding_dim=1536,
                embedding_chunk_size=8191,
            )
            
            llm_config = LLMConfig(
                model=agent_config['model_name'],
                model_endpoint_type="openai",
                model_endpoint=agent_config['model_endpoint'],
                api_key=agent_config['api_key'],
                model_wrapper=None,
                context_window=128000,
            )
            
            # 设置默认配置函数
            def embedding_default_config(cls, model_name=None, provider=None):
                return embedding_config
            
            def llm_default_config(cls, model_name=None, provider=None):
                return llm_config
            
            mirix.EmbeddingConfig.default_config = embedding_default_config
            mirix.LLMConfig.default_config = llm_default_config
            
            # 创建并返回Mirix助手
            return Mirix(
                api_key=agent_config['api_key'],
                config_path=config_path,
                model=agent_config['model_name']
            )
        
        except (sqlite3.OperationalError, ImportError, Exception) as e:
            if "no such table" in str(e) or attempt == max_retries - 1:
                print(f"Mirix初始化失败 (尝试 {attempt+1}/{max_retries}): {e}")
                if attempt < max_retries - 1:
                    print(f"等待 {retry_delay} 秒后重试...")
                    time.sleep(retry_delay)
                    # 强制清理Mirix目录
                    if os.path.exists(os.path.expanduser("~/.mirix")):
                        os.system("rm -rf ~/.mirix/*")
                else:
                    raise Exception(f"Mirix初始化失败，已达最大重试次数: {e}")
            else:
                raise e

def process_line(line, config_path, index):
    """处理单行数据，增加重试机制"""
    max_retries = 3
    
    for attempt in range(max_retries):
        try:
            assistant = get_mirix_client(config_path)
            original_data = json.loads(line)
            conversation = original_data.get("chat_history", [])
            question = original_data.get("user_query")
            answer = original_data.get("answer")
            correct_answer_option = original_data.get("correct_answer_option")
            if not question:
                original_data["response"] = "Question not found in this line."
                return original_data
            
            # 将对话历史转换为字符串格式
            conversation_str = "\n".join(
                f"{msg['role']}: {msg['content']}" for msg in conversation
            )
            
            # 添加对话历史到 Mirix
            start_time_conv = time.monotonic()
            assistant.add(conversation_str)
            add_conversation_duration = time.monotonic() - start_time_conv
            
            # 等待 Mirix 处理消息
            time.sleep(5)
            
            # 构建提问字符串
            question_with_options = f"{question}\nOptions:\n{answer}\n Please answer only with the letter of the option , such as a,b,c and d."
            
            # 使用 Mirix 获取回答
            start_time_search = time.monotonic()
            response = assistant.chat(question_with_options)
            search_memories_duration = time.monotonic() - start_time_search

            # 获取响应内容
            assistant_response = response.content if hasattr(response, 'content') else str(response)
            
            # 解析预测的答案
            predicted_answer = parse_predicted_answer(assistant_response)
            
            # 构建结果
            result = {
                "correct_answer_option":correct_answer_option,
                "predicted_answer": predicted_answer,
                "user_query": question,
                "answer": answer,
                "response": assistant_response,
                
                "metrics": {
                    "add_conversation_duration_seconds": add_conversation_duration,
                    "search_memories_duration_seconds": search_memories_duration,
                    "memory_tokens_used": 0,  # Mirix 不提供此信息
                    "retrieved_memories_text": "Retrieved by Mirix internal system"
                }
            }
            
            # 添加原始数据中的其他字段
            for key, value in original_data.items():
                if key not in ["question", "answer", "response", "predicted_answer", "metrics"]:
                    result[key] = value
            
            return result

        except Exception as e:
            print(f"Error line {index+1}: {e}")
            return None

def get_processed_indices(output_file):
    """获取已处理的行索引"""
    processed_indices = set()
    if not os.path.exists(output_file):
        return processed_indices
    
    try:
        with open(output_file, 'r', encoding='utf-8') as f:
            for line in f:
                try:
                    data = json.loads(line)
                    # 检查是否有响应字段，如果有则认为已处理
                    if "response" in data:
                        # 尝试从行内容中提取索引信息（如果有的话）
                        # 这里我们简单地将所有行视为已处理
                        processed_indices.add(len(processed_indices))
                except:
                    continue
    except Exception as e:
        print(f"Error reading output file: {e}")
    
    return processed_indices

def main():
    # 配置文件路径
    config_path = '/mnt/afs/codes/chl/chl/prefeval/config.yaml'
    
    # 输入输出文件路径
    input_file = "/mnt/afs/codes/chl/chl/Personamem/benchmark.jsonl"
    output_file = "/mnt/afs/codes/chl/chl/Personamem/Personamem_mirix.jsonl"
    
    print(f"Starting processing for file: {input_file}")
    
    # 获取已处理的行索引
    processed_indices = get_processed_indices(output_file)
    print(f"Found {len(processed_indices)} already processed lines")
    
    try:
        # 读取输入文件
        with open(input_file, 'r', encoding='utf-8') as infile:
            lines = infile.readlines()
    except FileNotFoundError:
        print(f"Error: Input file not found '{input_file}'")
        return
    
    # 处理未处理的行
    processed_count = 0
    with open(output_file, 'a', encoding='utf-8') as outfile:  # 使用追加模式
        for i, line in enumerate(tqdm(lines, desc="Processing lines")):
            # 跳过已处理的行
            if i in processed_indices:
                continue
                
            result = process_line(line, config_path, i)
            if result:
                outfile.write(json.dumps(result, ensure_ascii=False) + '\n')
                outfile.flush()  # 确保每条结果都立即写入文件
                processed_count += 1
                
                # 每处理5行后暂停一下，减少数据库压力
                if processed_count % 5 == 0:
                    time.sleep(3)
    
    print(f"\nProcessing complete! Successfully processed {processed_count} new lines.")
    print(f"Output saved to: {output_file}")

if __name__ == "__main__":
    main()