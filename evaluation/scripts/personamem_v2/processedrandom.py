import pandas as pd
import json
import ast
import os
import argparse
import random

# 配置部分 - 请根据您的实际文件修改这些值
FILE_PATH = './benchmark/text/benchmark.csv'  # 替换为您的CSV文件路径
OUTPUT_JSONL_PATH = './benchmark.jsonl'  # 输出JSONL文件路径
COLUMN_1_NAME = 'user_query'   # 请替换为第一个列名
COLUMN_2_NAME = 'correct_answer'      # 请替换为第二个列名
COLUMN_3_NAME = 'incorrect_answers'     # 请替换为第三个列名
COLUMN_4_NAME = 'chat_history_32k_link'

def load_chat_history(file_path):
    """从指定的JSON文件中加载聊天历史"""
    try:
        # 检查文件是否存在
        if not os.path.exists(file_path):
            print(f"警告: 文件不存在 - {file_path}")
            return []
        
        # 读取JSON文件
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # 提取聊天历史
        if 'chat_history' in data:
            return data['chat_history']
        else:
            print(f"警告: 文件中没有 'chat_history' 字段 - {file_path}")
            return []
    
    except Exception as e:
        print(f"加载聊天历史时出错 ({file_path}): {str(e)}")
        return []

def process_row(col1_data, col2_data, col3_data, col4_data, row_index):
    """
    处理单行数据并返回处理结果
    """
    result = {
        "correct_answer_option": ""  ,
        "chat_history_32k_link": col4_data,
        "user_query": "",
        "answer": "",
        
        
        "chat_history": []
    }
    
    # 首先加载聊天历史
    if col4_data and isinstance(col4_data, str):
        result["chat_history"] = load_chat_history(col4_data)
    
    # 处理第一列数据（用户查询）
    try:
        if isinstance(col1_data, str) and col1_data.strip().startswith('{'):
            parsed = ast.literal_eval(col1_data)
            # 检查是否有 'content' 字段，如果没有则使用整个对象
            result["user_query"] = parsed.get('content', str(parsed))
        else:
            result["user_query"] = col1_data
    except Exception as e:
        print(f"第 {row_index} 行第一列解析错误: {e}")
        result["user_query"] = f"ERROR: {str(e)} - {col1_data}"
    
    # 处理第二列数据（正确答案）
    try:
        correct_answer = str(col2_data)
    except Exception as e:
        print(f"第 {row_index} 行第二列处理错误: {e}")
        correct_answer = f"ERROR: {str(e)}"
    
    # 处理第三列数据（错误答案）
    incorrect_answers = []
    try:
        if isinstance(col3_data, str) and col3_data.strip().startswith('['):
            incorrect_answers = ast.literal_eval(col3_data)
            # 确保所有错误答案都是字符串
            incorrect_answers = [str(ans) for ans in incorrect_answers]
        else:
            incorrect_answers = [str(col3_data)]
    except Exception as e:
        print(f"第 {row_index} 行第三列解析错误: {e}")
        incorrect_answers = [f"ERROR: {str(e)}"]
    
    # 确保有足够的错误答案（至少3个）
    while len(incorrect_answers) < 3:
        incorrect_answers.append("(无错误答案提供)")
    
    # 随机决定正确答案的位置
    option_letters = ['a', 'b', 'c', 'd']
    correct_index = random.randint(0, 3)
    result["correct_answer_option"] = option_letters[correct_index]
    
    # 创建所有答案选项（3个错误答案）
    all_answers = incorrect_answers[:3]  # 只取前3个错误答案
    
    # 在随机位置插入正确答案
    all_answers.insert(correct_index, correct_answer)
    
    # 构建答案字符串
    answer_parts = []
    for i, answer in enumerate(all_answers):
        option = option_letters[i]
        answer_parts.append(f"({option}) {answer}")
    
    result["answer"] = " ".join(answer_parts)
    
    return result

def main():
    # 解析命令行参数
    parser = argparse.ArgumentParser(description='处理CSV数据并生成JSONL文件')
    parser.add_argument('--limit', type=int, default=None,
                        help='要处理的数据行数（默认为所有行）')
    args = parser.parse_args()
    
    # 读取CSV文件
    try:
        df = pd.read_csv(FILE_PATH)
        print(f"成功读取文件，总行数: {len(df)}")
    except Exception as e:
        print(f"读取文件时出错: {e}")
        return
    
    # 检查指定的列是否存在
    required_columns = [COLUMN_1_NAME, COLUMN_2_NAME, COLUMN_3_NAME, COLUMN_4_NAME]
    for col in required_columns:
        if col not in df.columns:
            print(f"错误: 列 '{col}' 不在CSV文件中")
            print(f"可用的列有: {list(df.columns)}")
            return
    
    # 创建输出目录（如果不存在）
    output_dir = os.path.dirname(OUTPUT_JSONL_PATH)
    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)
    
    # 确定要处理的行数
    total_rows = len(df)
    if args.limit is not None:
        total_rows = min(args.limit, total_rows)
    
    # 打开JSONL文件准备写入
    with open(OUTPUT_JSONL_PATH, 'w', encoding='utf-8') as jsonl_file:
        # 逐行处理数据
        for index in range(total_rows):
            row = df.iloc[index]
            
            # 提取四列的数据
            col1_data = row[COLUMN_1_NAME]
            col2_data = row[COLUMN_2_NAME]
            col3_data = row[COLUMN_3_NAME]
            col4_data = row[COLUMN_4_NAME] 
            
            # 处理当前行
            result = process_row(col1_data, col2_data, col3_data, col4_data, index)
            
            # 将结果写入JSONL文件
            json_line = json.dumps(result, ensure_ascii=False)
            jsonl_file.write(json_line + '\n')
            
            # 打印进度
            if index % 100 == 0:
                print(f"已处理 {index} 行...")
    
    print(f"处理完成！结果已保存到: {OUTPUT_JSONL_PATH}")
    print(f"共处理 {total_rows} 行数据")

if __name__ == "__main__":
    main()