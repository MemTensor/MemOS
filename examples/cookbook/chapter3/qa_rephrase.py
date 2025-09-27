"""
QA转文本批量处理系统

依赖安装:
pip install jsonrepair

如果没有安装jsonrepair，系统会自动跳过该修复策略，使用其他容错机制。
"""

import requests
import json
import os
import pickle
import time
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import re
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from enum import Enum

# 尝试导入jsonrepair，如果没有安装则提供备用方案
try:
    from json-repair import repair_json
    HAS_JSONREPAIR = True
    print("✓ jsonrepair库已加载，JSON修复功能已启用")
except ImportError:
    HAS_JSONREPAIR = False
    print("⚠ jsonrepair库未安装，将使用基础修复策略。运行 'pip install jsonrepair' 启用高级JSON修复")
    def repair_json(text):
        return text


class TaskType(Enum):
    COT_GENERATION = "cot_generation"
    ANSWER_VERIFICATION = "answer_verification"
    TEXT_CONVERSION = "text_conversion"


@dataclass
class ProcessingResult:
    """处理结果数据类"""
    status: str  # success, api_error, validation_error
    task_type: TaskType
    qa_id: str
    input_data: Dict
    response: Optional[str] = None
    parsed_result: Optional[Dict] = None
    error_details: Optional[str] = None
    processing_time: Optional[float] = None


class APIClient:
    """抽象的API调用客户端"""
    
    def __init__(self, api_url: str, api_key: str, model_name: str):
        self.api_url = api_url
        self.api_key = api_key
        self.model_name = model_name
        
        # 创建session并配置连接池和重试策略
        self.session = requests.Session()
        
        retry_strategy = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[500, 502, 503, 504],
        )
        
        adapter = HTTPAdapter(pool_connections=10, pool_maxsize=20, max_retries=retry_strategy)
        self.session.mount('http://', adapter)
        self.session.mount('https://', adapter)
        
        self.session.headers.update({
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}"
        })
    
    def call_api(self, messages: List[Dict], timeout: int = 60) -> Dict:
        """统一的API调用方法"""
        data = {
            "model": self.model_name,
            "messages": messages,
            "stream": False
        }
        
        try:
            response = self.session.post(url=self.api_url, json=data, timeout=timeout)
            response.raise_for_status()
            result = response.json()
            return {
                "status": "success",
                "content": result['choices'][0]['message']['content']
            }
        except requests.exceptions.RequestException as e:
            return {
                "status": "error",
                "error": str(e)
            }


class PromptTemplates:
    """提示词模板类"""
    
    @staticmethod
    def get_cot_prompt(question: str, options: str) -> str:
        """步骤1：COT推理生成提示词"""
        return f"""Please analyze the following multiple choice question. Think step by step and provide detailed reasoning process, then give the final answer.

Question:
{question}

Options:
{options}

Please output ONLY a valid JSON object in the following format (no markdown, no extra text):
{{
    "reasoning": "Think step by step. Provide detailed reasoning process explaining why you choose this answer",
    "answer": "Final answer (the complete value corresponding to the option)"
}}

Requirements:
1. The reasoning section should contain sufficient medical/academic knowledge explanations
2. Think step by step and analyze the validity of each option
3. The answer section should directly provide the complete value corresponding to the option (not A/B/C/D)
4. Output ONLY the JSON object, no additional text or formatting"""

    @staticmethod
    def get_verification_prompt(qa_data: Dict, generated_answer: str) -> str:
        """步骤2：答案一致性验证提示词"""
        return f"""Question and Options:
{qa_data['input']}

Correct Answer: {qa_data['output']}

Model Generated Answer: {generated_answer}

Please output ONLY a valid JSON object in the following format (no markdown, no extra text):
{{
    "is_consistent": true/false
}}

Judge whether the model's generated answer is semantically consistent with the correct answer. Output ONLY the JSON object."""

    @staticmethod
    def get_text_conversion_prompt(question: str, reasoning: str, answer: str) -> str:
        """步骤3：转换为陈述性文本提示词"""
        return f"""Please convert the following multiple choice question, reasoning process, and answer into a knowledge-rich declarative text.

Original question:
{question}

Reasoning process:
{reasoning}

Answer:
{answer}

Please output ONLY a valid JSON object in the following format (no markdown, no extra text):
{{
    "knowledge_text": "Converted declarative text"
}}

Requirements:
1. The text should be a self-contained knowledge point description that does not depend on the original question
2. Integrate the question background, knowledge points in the reasoning process, and conclusions
3. Use declarative sentences and avoid question forms
4. Retain important medical/academic terms and concepts
5. Avoid referencing specific individual cases (e.g., “Xiao Wang had diarrhea”); present the content at a generalizable level
6. The text should be of moderate length with high information density
7. Output ONLY the JSON object, no additional text or formatting"""


class ResponseValidator:
    """响应验证器"""
    
    @staticmethod
    def validate_json_response(response_text: str, expected_keys: List[str]) -> Dict:
        """
        验证API返回的内容是否为有效JSON，包含预处理容错
        
        Returns:
            dict: {
                "is_valid_json": bool,
                "parsed_json": dict or None,
                "error_type": str,
                "raw_response": str
            }
        """
        if not response_text or not response_text.strip():
            return {
                "is_valid_json": False,
                "parsed_json": None,
                "error_type": "empty_response",
                "raw_response": response_text
            }
        
        repair_attempts = []
        
        try:
            # 预处理清理
            text = response_text.strip()
            
            # 1. 处理markdown代码块 ```json...``` 或 ```...```
            code_block_match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL)
            if code_block_match:
                text = code_block_match.group(1).strip()
            
            # 2. 处理引号包装 '...' 或 "..."
            if (text.startswith("'") and text.endswith("'")) or (text.startswith('"') and text.endswith('"')):
                text = text[1:-1]
            
            # 3. 移除前后的反引号
            text = text.strip('`').strip()
            
            # 4. 查找JSON部分 - 第一个{到最后一个}
            json_match = re.search(r'(\{.*\})', text, re.DOTALL)
            if json_match:
                text = json_match.group(1)
            
            # 第一次尝试：直接解析
            try:
                parsed = json.loads(text)
                repair_attempts.append("direct_parse_success")
            except json.JSONDecodeError as e:
                repair_attempts.append(f"direct_parse_failed: {str(e)}")
                
                # 第二次尝试：使用jsonrepair修复后解析
                if HAS_JSONREPAIR:
                    try:
                        repaired_text = repair_json(text)
                        parsed = json.loads(repaired_text)
                        repair_attempts.append("jsonrepair_success")
                    except Exception as e:
                        repair_attempts.append(f"jsonrepair_failed: {str(e)}")
                        raise  # 重新抛出异常
                else:
                    repair_attempts.append("jsonrepair_not_available")
                    raise  # 重新抛出异常
            
            # 检查是否符合预期的结构
            if isinstance(parsed, dict) and all(key in parsed for key in expected_keys):
                return {
                    "is_valid_json": True,
                    "parsed_json": parsed,
                    "error_type": None,
                    "raw_response": response_text,
                    "repair_attempts": repair_attempts
                }
            else:
                missing_keys = [key for key in expected_keys if key not in parsed] if isinstance(parsed, dict) else expected_keys
                return {
                    "is_valid_json": False,
                    "parsed_json": parsed,
                    "error_type": f"missing_keys: expected {expected_keys}, missing {missing_keys}",
                    "raw_response": response_text,
                    "repair_attempts": repair_attempts
                }
                
        except json.JSONDecodeError as e:
            return {
                "is_valid_json": False,
                "parsed_json": None,
                "error_type": f"json_decode_error: {str(e)}",
                "raw_response": response_text,
                "repair_attempts": repair_attempts
            }
        except Exception as e:
            return {
                "is_valid_json": False,
                "parsed_json": None,
                "error_type": f"unexpected_error: {str(e)}",
                "raw_response": response_text,
                "repair_attempts": repair_attempts
            }


class QAToTextProcessor:
    """QA转文本处理器主类"""
    
    def __init__(self, api_client: APIClient):
        self.api_client = api_client
        self.validator = ResponseValidator()
    
    def process_single_qa(self, qa_data: Dict, qa_id: str) -> List[ProcessingResult]:
        """处理单个QA的完整流程"""
        results = []
        
        # 解析输入数据
        input_text = qa_data['input']
        expected_output = qa_data['output']
        
        # 提取题目和选项
        question_part = input_text.split('\n选项:')[0]
        options_part = input_text.split('\n选项:')[1] if '\n选项:' in input_text else ""
        
        # 步骤1：COT推理生成
        start_time = time.time()
        cot_result = self._generate_cot(question_part, options_part, qa_id)
        cot_result.processing_time = time.time() - start_time
        results.append(cot_result)
        
        if cot_result.status != "success":
            return results
        
        # 从第一步结果中提取纯答案（不包含推理过程）
        generated_answer = cot_result.parsed_result.get('answer', '')
        reasoning = cot_result.parsed_result.get('reasoning', '')
        
        # 步骤2：答案验证（比较纯答案与标准答案的语义一致性）
        start_time = time.time()
        verification_result = self._verify_answer(qa_data, generated_answer, qa_id)
        verification_result.processing_time = time.time() - start_time
        results.append(verification_result)
        
        if verification_result.status != "success":
            return results
        
        is_consistent = verification_result.parsed_result.get('is_consistent', False)
        if not is_consistent:
            # 答案不一致，记录但不继续处理
            return results
        
        # 步骤3：文本转换（使用完整的题目、推理过程和答案）
        start_time = time.time()
        conversion_result = self._convert_to_text(question_part, reasoning, generated_answer, qa_id)
        conversion_result.processing_time = time.time() - start_time
        results.append(conversion_result)
        
        return results
    
    def _generate_cot(self, question: str, options: str, qa_id: str) -> ProcessingResult:
        """生成COT推理"""
        prompt = PromptTemplates.get_cot_prompt(question, options)
        messages = [{"role": "user", "content": prompt}]
        
        api_result = self.api_client.call_api(messages)
        
        if api_result["status"] != "success":
            return ProcessingResult(
                status="api_error",
                task_type=TaskType.COT_GENERATION,
                qa_id=qa_id,
                input_data={"question": question, "options": options},
                error_details=api_result["error"]
            )
        
        # 验证响应格式
        validation_result = self.validator.validate_json_response(
            api_result["content"], ["reasoning", "answer"]
        )
        
        if not validation_result["is_valid_json"]:
            return ProcessingResult(
                status="validation_error",
                task_type=TaskType.COT_GENERATION,
                qa_id=qa_id,
                input_data={"question": question, "options": options},
                response=api_result["content"],
                error_details=f"{validation_result['error_type']} | repair_attempts: {validation_result.get('repair_attempts', [])}"
            )
        
        return ProcessingResult(
            status="success",
            task_type=TaskType.COT_GENERATION,
            qa_id=qa_id,
            input_data={"question": question, "options": options},
            response=api_result["content"],
            parsed_result=validation_result["parsed_json"]
        )
    
    def _verify_answer(self, qa_data: Dict, generated_answer: str, qa_id: str) -> ProcessingResult:
        """验证LLM生成的纯答案与标准答案的语义一致性"""
        prompt = PromptTemplates.get_verification_prompt(qa_data, generated_answer)
        messages = [{"role": "user", "content": prompt}]
        
        api_result = self.api_client.call_api(messages)
        
        if api_result["status"] != "success":
            return ProcessingResult(
                status="api_error",
                task_type=TaskType.ANSWER_VERIFICATION,
                qa_id=qa_id,
                input_data={
                    "qa_data": qa_data,
                    "llm_generated_answer": generated_answer
                },
                error_details=api_result["error"]
            )
        
        validation_result = self.validator.validate_json_response(
            api_result["content"], ["is_consistent"]
        )
        
        if not validation_result["is_valid_json"]:
            return ProcessingResult(
                status="validation_error",
                task_type=TaskType.ANSWER_VERIFICATION,
                qa_id=qa_id,
                input_data={
                    "qa_data": qa_data,
                    "llm_generated_answer": generated_answer
                },
                response=api_result["content"],
                error_details=f"{validation_result['error_type']} | repair_attempts: {validation_result.get('repair_attempts', [])}"
            )
        
        return ProcessingResult(
            status="success",
            task_type=TaskType.ANSWER_VERIFICATION,
            qa_id=qa_id,
            input_data={
                "qa_data": qa_data,
                "llm_generated_answer": generated_answer
            },
            response=api_result["content"],
            parsed_result=validation_result["parsed_json"]
        )
    
    def _convert_to_text(self, question: str, reasoning: str, answer: str, qa_id: str) -> ProcessingResult:
        """转换为陈述性文本"""
        prompt = PromptTemplates.get_text_conversion_prompt(question, reasoning, answer)
        messages = [{"role": "user", "content": prompt}]
        
        api_result = self.api_client.call_api(messages)
        
        if api_result["status"] != "success":
            return ProcessingResult(
                status="api_error",
                task_type=TaskType.TEXT_CONVERSION,
                qa_id=qa_id,
                input_data={"question": question, "reasoning": reasoning, "answer": answer},
                error_details=api_result["error"]
            )
        
        validation_result = self.validator.validate_json_response(
            api_result["content"], ["knowledge_text"]
        )
        
        if not validation_result["is_valid_json"]:
            return ProcessingResult(
                status="validation_error",
                task_type=TaskType.TEXT_CONVERSION,
                qa_id=qa_id,
                input_data={"question": question, "reasoning": reasoning, "answer": answer},
                response=api_result["content"],
                error_details=f"{validation_result['error_type']} | repair_attempts: {validation_result.get('repair_attempts', [])}"
            )
        
        return ProcessingResult(
            status="success",
            task_type=TaskType.TEXT_CONVERSION,
            qa_id=qa_id,
            input_data={"question": question, "reasoning": reasoning, "answer": answer},
            response=api_result["content"],
            parsed_result=validation_result["parsed_json"]
        )


class BatchProcessor:
    """批量处理器"""
    
    def __init__(self, processor: QAToTextProcessor, output_dir):
        self.processor = processor
        self.output_dir = output_dir
        if not os.path.exists(output_dir):
            os.makedirs(output_dir)
    
    def process_qa_list(self, qa_list: List[Dict], max_workers: int = 20, 
                       batch_size: int = 200, batch_delay: int = 2) -> Dict:
        """批量处理QA列表"""
        total_qas = len(qa_list)
        print(f"开始批量处理 {total_qas} 个QA，批次大小: {batch_size}, 最大并发: {max_workers}")
        
        all_results = {}
        batch_num = 1
        
        # 分批处理
        for i in range(0, total_qas, batch_size):
            batch_qas = qa_list[i:i + batch_size]
            print(f"\n处理批次 {batch_num}: QA {i+1}-{min(i+batch_size, total_qas)} ({len(batch_qas)} 个)")
            
            batch_start_time = time.time()
            batch_results = self._process_batch(batch_qas, max_workers, i)
            batch_end_time = time.time()
            
            # 保存批次结果（只保存验证为true且转换成功的）
            self._save_successful_results(batch_results, batch_num, batch_start_time)
            
            all_results.update(batch_results)
            
            print(f"批次 {batch_num} 完成，耗时: {batch_end_time - batch_start_time:.2f} 秒")
            
            batch_num += 1
            
            # 批次间休息
            if i + batch_size < total_qas:
                print(f"批次间休息 {batch_delay} 秒...")
                time.sleep(batch_delay)
        
        print(f"\n所有批次处理完成！总计处理 {total_qas} 个QA")
        return all_results
    
    def _process_batch(self, batch_qas: List[Dict], max_workers: int, start_index: int) -> Dict:
        """处理单个批次"""
        batch_results = {}
        
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # 提交任务
            future_to_qa = {}
            for idx, qa_data in enumerate(batch_qas):
                qa_id = f"qa_{start_index + idx:06d}"
                future = executor.submit(self.processor.process_single_qa, qa_data, qa_id)
                future_to_qa[future] = (qa_id, qa_data)
            
            # 收集结果
            completed = 0
            for future in as_completed(future_to_qa):
                qa_id, qa_data = future_to_qa[future]
                try:
                    results = future.result()
                    batch_results[qa_id] = {
                        "original_data": qa_data,
                        "processing_results": results
                    }
                    
                    # 详细状态显示
                    status_info = self._get_processing_status(results)
                    status_symbol = status_info["symbol"]
                    
                    completed += 1
                    if completed % 10 == 0 or completed == len(batch_qas):
                        print(f"  已完成: {completed}/{len(batch_qas)} {status_symbol}")
                        
                except Exception as e:
                    batch_results[qa_id] = {
                        "original_data": qa_data,
                        "processing_results": [],
                        "exception": str(e)
                    }
        
        return batch_results
    
    def _get_processing_status(self, results: List[ProcessingResult]) -> Dict:
        """获取处理状态信息"""
        if not results:
            return {"symbol": "✗", "status": "no_results"}
        
        # 检查各步骤状态
        cot_success = any(r.task_type == TaskType.COT_GENERATION and r.status == "success" for r in results)
        verification_success = any(r.task_type == TaskType.ANSWER_VERIFICATION and r.status == "success" for r in results)
        conversion_success = any(r.task_type == TaskType.TEXT_CONVERSION and r.status == "success" for r in results)
        
        # 检查答案是否一致
        answer_consistent = False
        for r in results:
            if r.task_type == TaskType.ANSWER_VERIFICATION and r.status == "success":
                answer_consistent = r.parsed_result.get('is_consistent', False)
                break
        
        if conversion_success:
            return {"symbol": "✓", "status": "full_success"}
        elif verification_success and not answer_consistent:
            return {"symbol": "⚠", "status": "answer_inconsistent"}
        elif verification_success:
            return {"symbol": "⏸", "status": "stopped_after_verification"}
        elif cot_success:
            return {"symbol": "⏸", "status": "stopped_after_cot"}
        else:
            return {"symbol": "✗", "status": "failed"}
    
    def _save_successful_results(self, batch_results: Dict, batch_num: int, start_time: float):
        """只保存验证为true且转换成功的结果，包含完整input/output"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"qa_to_text_successful_batch_{batch_num:03d}_{timestamp}.pkl"
        filepath = os.path.join(self.output_dir, filename)
        
        # 筛选成功的QA（验证为true且转换成功）
        successful_qas = {}
        total_qas = len(batch_results)
        successful_count = 0
        verification_true_count = 0
        
        for qa_id, qa_result in batch_results.items():
            results = qa_result.get("processing_results", [])
            original_data = qa_result.get("original_data", {})
            
            if len(results) >= 3:  # 必须完成所有3步
                cot_result = results[0] if results[0].task_type == TaskType.COT_GENERATION else None
                verification_result = results[1] if results[1].task_type == TaskType.ANSWER_VERIFICATION else None
                conversion_result = results[2] if results[2].task_type == TaskType.TEXT_CONVERSION else None
                
                # 检查验证结果是否为true
                if verification_result and verification_result.status == "success":
                    is_consistent = verification_result.parsed_result.get('is_consistent', False)
                    if is_consistent:
                        verification_true_count += 1
                        
                        # 检查转换是否成功
                        if conversion_result and conversion_result.status == "success":
                            successful_count += 1
                            
                            # 构建完整的input/output记录
                            complete_process = {
                                "qa_id": qa_id,
                                "original_input": original_data.get("input", ""),
                                "original_output": original_data.get("output", ""),
                                
                                # 步骤1：COT推理
                                "cot_reasoning": cot_result.parsed_result.get("reasoning", "") if cot_result and cot_result.status == "success" else "",
                                "cot_answer": cot_result.parsed_result.get("answer", "") if cot_result and cot_result.status == "success" else "",
                                
                                # 步骤2：验证结果
                                "verification_result": True,  # 因为已经筛选过了
                                
                                # 步骤3：最终知识文本
                                "knowledge_text": conversion_result.parsed_result.get("knowledge_text", ""),
                                
                                # 处理时间统计
                                "total_processing_time": sum(r.processing_time or 0 for r in results),
                                "step_processing_times": {
                                    "cot_time": cot_result.processing_time or 0 if cot_result else 0,
                                    "verification_time": verification_result.processing_time or 0,
                                    "conversion_time": conversion_result.processing_time or 0
                                }
                            }
                            
                            successful_qas[qa_id] = complete_process
        
        # 保存数据
        save_data = {
            "metadata": {
                "batch_num": batch_num,
                "timestamp": timestamp,
                "start_time": start_time,
                "total_qas_in_batch": total_qas,
                "verification_true_count": verification_true_count,
                "successful_conversions": successful_count,
                "task_type": "qa_to_text_successful_only"
            },
            "successful_results": successful_qas
        }
        
        with open(filepath, 'wb') as f:
            pickle.dump(save_data, f)
        
        print(f"  成功结果已保存: {filename}")
        print(f"  验证为true: {verification_true_count}/{total_qas}, 完整成功: {successful_count}/{total_qas}")
        return filepath


# ==================== 调试和单例测试工具 ====================

def test_single_qa(qa_data: Dict, verbose: bool = True):
    """测试单个QA的处理过程，用于调试"""
    print("=" * 80)
    print("单个QA处理测试")
    print("=" * 80)
    
    # 初始化API客户端
    api_client = APIClient(
        api_url="http://123.129.219.111:3000/v1/chat/completions",
        api_key="sk-ZXk4KtKH99yelVZKPrpGB2t8OrhUOoVV0hhGi26zgjkN58Ye",
        model_name="gpt-4o-mini"
    )
    
    processor = QAToTextProcessor(api_client)
    
    print("原始数据:")
    print(f"输入: {qa_data['input'][:200]}...")
    print(f"预期输出: {qa_data['output']}")
    print()
    
    # 处理QA
    results = processor.process_single_qa(qa_data, "test_qa")
    
    # 显示每步结果
    all_success = True
    final_knowledge_text = None
    cot_reasoning = None
    cot_answer = None
    verification_result = None
    
    for i, result in enumerate(results, 1):
        print(f"步骤 {i}: {result.task_type.value}")
        print(f"状态: {result.status}")
        
        if result.status == "success" and result.parsed_result:
            if result.task_type == TaskType.COT_GENERATION:
                cot_answer = result.parsed_result.get('answer', 'N/A')
                cot_reasoning = result.parsed_result.get('reasoning', 'N/A')
                print(f"生成的答案: {cot_answer}")
                if verbose:
                    print(f"推理过程: {cot_reasoning[:300]}...")
            
            elif result.task_type == TaskType.ANSWER_VERIFICATION:
                verification_result = result.parsed_result.get('is_consistent', False)
                print(f"答案一致性: {verification_result}")
                if not verification_result:
                    all_success = False
            
            elif result.task_type == TaskType.TEXT_CONVERSION:
                final_knowledge_text = result.parsed_result.get('knowledge_text', 'N/A')
                print(f"知识文本: {final_knowledge_text[:300]}...")
        
        elif result.status != "success":
            print(f"错误详情: {result.error_details}")
            if result.response:
                print(f"原始API返回前300字符: {result.response[:300]}...")
                
                # 如果有repair_attempts信息，显示修复尝试过程
                if "repair_attempts:" in str(result.error_details):
                    print("JSON修复尝试过程:")
                    try:
                        attempts_str = str(result.error_details).split("repair_attempts: ")[1]
                        attempts = eval(attempts_str) if attempts_str.startswith('[') else []
                        for i, attempt in enumerate(attempts, 1):
                            print(f"  {i}. {attempt}")
                    except:
                        pass
                        
            all_success = False
        
        print(f"处理耗时: {result.processing_time:.2f}秒" if result.processing_time else "处理耗时: N/A")
        print("-" * 40)
    
    # 如果所有步骤都成功，显示并返回最终输出（要保存的数据格式）
    if all_success and final_knowledge_text:
        print("🎉 所有步骤成功完成!")
        print("=" * 80)
        print("最终要保存的数据:")
        print("=" * 80)
        
        # 构建完整的数据结构（这就是最终要保存的格式）
        final_output = {
            "qa_id": "test_qa",
            "original_input": qa_data['input'],
            "original_output": qa_data['output'],
            "cot_reasoning": cot_reasoning,
            "cot_answer": cot_answer,
            "verification_result": verification_result,
            "knowledge_text": final_knowledge_text,
            "total_processing_time": sum(r.processing_time or 0 for r in results),
            "step_processing_times": {
                "cot_time": results[0].processing_time or 0 if len(results) > 0 else 0,
                "verification_time": results[1].processing_time or 0 if len(results) > 1 else 0,
                "conversion_time": results[2].processing_time or 0 if len(results) > 2 else 0
            }
        }
        
        # 美化输出
        print(json.dumps(final_output, ensure_ascii=False, indent=2))
        print("=" * 80)
        
        return {
            "success": True,
            "final_output": final_output,
            "results": results
        }
    else:
        print("❌ 处理过程中出现错误或答案不一致")
        return {
            "success": False,
            "final_output": None,
            "results": results
        }


def debug_answer_comparison(qa_data: Dict):
    """专门调试答案比较步骤"""
    print("=" * 80)
    print("答案比较调试")
    print("=" * 80)
    
    # 初始化API客户端
    api_client = APIClient(
        api_url="http://123.129.219.111:3000/v1/chat/completions",
        api_key="sk-ZXk4KtKH99yelVZKPrpGB2t8OrhUOoVV0hhGi26zgjkN58Ye",
        model_name="gpt-4o-mini"
    )
    
    processor = QAToTextProcessor(api_client)
    
    # 先生成COT
    input_text = qa_data['input']
    question_part = input_text.split('\n选项:')[0]
    options_part = input_text.split('\n选项:')[1] if '\n选项:' in input_text else ""
    
    print("第一步: COT推理生成")
    cot_result = processor._generate_cot(question_part, options_part, "debug_qa")
    
    if cot_result.status == "success":
        generated_answer = cot_result.parsed_result.get('answer', '')
        print(f"LLM生成的答案: '{generated_answer}'")
        print(f"题目标准答案: '{qa_data['output']}'")
        print()
    else:
        print(f"COT生成失败: {cot_result.error_details}")
        print("\n原始API返回内容:")
        print("-" * 40)
        print(cot_result.response)
        print("-" * 40)
        return
        
    print("第二步: 答案一致性验证")
    verification_result = processor._verify_answer(qa_data, generated_answer, "debug_qa")
    
    if verification_result.status == "success":
        is_consistent = verification_result.parsed_result.get('is_consistent', False)
        
        print(f"一致性判断: {is_consistent}")
        
        # 显示验证提示词
        print("\n验证提示词:")
        print("-" * 40)
        verification_prompt = PromptTemplates.get_verification_prompt(qa_data, generated_answer)
        print(verification_prompt)
        print("-" * 40)
        
        # 显示原始返回内容
        print("\n原始API返回:")
        print("-" * 40)
        print(verification_result.response)
        print("-" * 40)
    else:
        print(f"验证失败: {verification_result.error_details}")


# ==================== 结果分析工具 ====================

class ResultAnalyzer:
    """结果分析器"""
    
    @staticmethod
    def load_batch_results(filepath: str) -> Dict:
        """加载批次结果"""
        with open(filepath, 'rb') as f:
            return pickle.load(f)
    
    @staticmethod
    def analyze_successful_results(results_dir: str = "med/qa"):
        """分析成功结果文件"""
        successful_files = [f for f in os.listdir(results_dir) 
                           if f.startswith('qa_to_text_successful_batch_') and f.endswith('.pkl')]
        successful_files.sort()
        
        if not successful_files:
            print("未找到成功结果文件")
            return
        
        total_qas_processed = 0
        total_verification_true = 0
        total_successful = 0
        all_successful_data = []
        
        print("成功结果文件分析:")
        print("=" * 100)
        
        for file in successful_files:
            filepath = os.path.join(results_dir, file)
            data = ResultAnalyzer.load_batch_results(filepath)
            metadata = data['metadata']
            successful_results = data.get('successful_results', {})
            
            total_qas_processed += metadata['total_qas_in_batch']
            total_verification_true += metadata['verification_true_count']
            total_successful += metadata['successful_conversions']
            
            print(f"批次 {metadata['batch_num']:3d}: "
                  f"总QA {metadata['total_qas_in_batch']:3d}, "
                  f"验证true {metadata['verification_true_count']:3d}, "
                  f"完整成功 {metadata['successful_conversions']:3d}")
            
            # 收集成功的数据
            for qa_id, qa_data in successful_results.items():
                all_successful_data.append(qa_data)
        
        print("=" * 100)
        print(f"总计: 处理QA {total_qas_processed}, 验证true {total_verification_true}, 完整成功 {total_successful}")
        if total_qas_processed > 0:
            print(f"验证true率: {total_verification_true/total_qas_processed*100:.1f}%")
            print(f"完整成功率: {total_successful/total_qas_processed*100:.1f}%")
        
        return all_successful_data
    
    @staticmethod
    def export_successful_knowledge_texts(output_file: str = "successful_knowledge_texts.json", 
                                         results_dir: str = "med/qa"):
        """导出所有成功的知识文本"""
        successful_data = ResultAnalyzer.analyze_successful_results(results_dir)
        
        if not successful_data:
            print("没有找到成功的知识文本")
            return []
        
        # 保存到文件
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(successful_data, f, ensure_ascii=False, indent=2)
        
        print(f"已导出 {len(successful_data)} 个成功的知识文本到: {output_file}")
        return successful_data


# ==================== 使用示例 ====================

def process_sampled_data(sampled_data: List[Dict], start_index: int = 0, 
                        max_count: Optional[int] = None):
    """处理sampled_data的便捷函数"""
    # 确定处理范围
    if max_count is not None:
        end_index = min(start_index + max_count, len(sampled_data))
    else:
        end_index = len(sampled_data)
    
    data_to_process = sampled_data[start_index:end_index]
    
    print(f"准备处理sampled_data[{start_index}:{end_index}]，共 {len(data_to_process)} 个QA")
    
    # 初始化API客户端
    api_client = APIClient(
        api_url="http://123.129.219.111:3000/v1/chat/completions",
        api_key="sk-ZXk4KtKH99yelVZKPrpGB2t8OrhUOoVV0hhGi26zgjkN58Ye",
        model_name="gpt-4o"
    )
    
    # 初始化处理器
    processor = QAToTextProcessor(api_client)
    batch_processor = BatchProcessor(processor, output_dir='med/qa')
    
    # 批量处理（并行20个问题，每200个保存一次）
    results = batch_processor.process_qa_list(
        qa_list=data_to_process,
        max_workers=50,
        batch_size=500,
        batch_delay=0.1
    )
    
    return results


def analyze_results(results_dir):
    """分析成功结果的便捷函数"""
    return ResultAnalyzer.analyze_successful_results(results_dir)


def export_successful_texts(output_file):
    """导出成功转换的文本"""
    return ResultAnalyzer.export_successful_knowledge_texts(output_file)


if __name__ == "__main__":
    # 显示JSON修复功能状态
    print("=" * 80)
    print("QA转文本处理系统")
    print("=" * 80)
    if HAS_JSONREPAIR:
        print("✓ 高级JSON修复功能已启用 (jsonrepair)")
    else:
        print("⚠ 使用基础JSON修复功能 (建议安装: pip install jsonrepair)")
    print()
    
    # 示例使用
    
    # 测试单个QA的处理过程（调试用）
    sample_qa = {
        'input': "An outbreak of diphtheria has occurred for the third time in a decade in a small village in South Africa. Diphtheria is endemic to the area with many healthy villagers colonized with different bacterial strains. Vaccine distribution in this area is difficult due to treacherous terrain. A team of doctors is sent to the region to conduct a health campaign. Toxigenic strains of C. diphtheria are isolated from symptomatic patients. Which of the following best explains the initial emergence of a pathogenic strain causing such outbreaks?\n\n选项:\nA: {'key': 'A', 'value': 'Presence of naked DNA in the environment'}\nB: {'key': 'B', 'value': 'Lysogenic conversion'}\nC: {'key': 'C', 'value': 'Suppression of lysogenic cycle'}\nD: {'key': 'D', 'value': 'Conjugation between the toxigenic and non-toxigenic strains of C. diphtheriae'}",
        'output': 'Lysogenic conversion'
    }
    
    # 1. 测试单个QA处理
    #test_results = test_single_qa(sample_qa, verbose=True)
    
    # 2. 专门调试答案比较
    #debug_answer_comparison(sample_qa)
    
    # 3. 如果你有sampled_data，可以这样调用：
    # results = process_sampled_data(sampled_data, start_index=0, max_count=100)
    
    # 4. 分析结果
    # analyze_results()
    
    # 5. 导出成功的文本
    # export_successful_texts()
    
    print("QA转文本处理系统已就绪。")
    print("使用方法:")
    print("1. test_single_qa(qa_data) - 测试单个QA")
    print("2. debug_answer_comparison(qa_data) - 调试答案比较")
    print("3. process_sampled_data(sampled_data) - 批量处理")
    print("4. analyze_results() - 分析结果")
    print("5. export_successful_texts() - 导出文本")