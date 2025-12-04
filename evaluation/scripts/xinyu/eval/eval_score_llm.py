import os
import re
import traceback

from collections import defaultdict
from math import isclose

from memos.configs.mem_os import MOSConfig
from memos.llms.factory import LLMFactory


openapi_config = {
    "model_name_or_path": "gpt-5-nano",
    "top_k": 50,
    "remove_think_prefix": True,
    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
    "api_base": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
}
config = {
    "user_id": "user_name",
    "chat_model": {
        "backend": "openai",
        "config": openapi_config,
    },
    "mem_reader": {
        "backend": "simple_struct",
        "config": {
            "llm": {"backend": "openai", "config": openapi_config},
            "embedder": {
                "backend": "universal_api",
                "config": {
                    "provider": "openai",
                    "api_key": os.getenv("OPENAI_API_KEY", "sk-xxxxx"),
                    "model_name_or_path": "text-embedding-3-large",
                    "base_url": os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
                },
            },
            "chunker": {
                "backend": "sentence",
                "config": {
                    "tokenizer_or_token_counter": "gpt2",
                    "chunk_size": 512,
                    "chunk_overlap": 128,
                    "min_sentences_per_chunk": 1,
                },
            },
        },
    },
    "max_turns_window": 20,
    "top_k": 5,
    "enable_textual_memory": True,
    "enable_activation_memory": False,
    "enable_parametric_memory": False,
}
mos_config = MOSConfig(**config)
chat_llm = LLMFactory.from_config(mos_config.chat_model)


def is_float_equal(
    reference, prediction, include_percentage: bool = False, is_close: float = False
) -> bool:
    def get_precision(gt_ans: float) -> int:
        precision = 3
        if "." in str(gt_ans):
            precision = len(str(gt_ans).split(".")[-1])
        return precision

    reference = float(str(reference).strip().rstrip("%").strip())
    try:
        prediction = float(str(prediction).strip().rstrip("%").strip())
    except Exception:
        return False

    gt_result = [reference / 100, reference, reference * 100] if include_percentage else [reference]
    for item in gt_result:
        try:
            if is_close and isclose(item, prediction, rel_tol=0.01):
                return True
            precision = max(min(get_precision(prediction), get_precision(item)), 2)
            if round(prediction, precision) == round(item, precision):
                return True
        except Exception:
            continue
    return False


def get_clean_string(s):
    s = str(s).lower().strip()

    for suffix in ["mile", "miles", "million"]:
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()

    s = re.sub(r"\s*\([^)]*\)", "", s).strip()
    s = re.sub(r"^['\"]|['\"]$", "", s).strip()
    s = s.lstrip("$").rstrip("%").strip()

    return s


def is_exact_match(s):
    flag = False
    # Website
    if "https://" in s:
        flag = True
    # code file
    if s.endswith((".py", ".ipynb")) or s.startswith("page"):
        flag = True
    # telephone number
    if re.fullmatch(r"\b\d+(-\d+|\s\d+)?\b", s):
        flag = True
    # time
    if "a.m." in s or "p.m." in s:
        flag = True
    # YYYY-MM-DD
    if re.fullmatch(r"\b\d{4}[-\s]\d{2}[-\s]\d{2}\b", s):
        flag = True
    # YYYY-MM
    if re.fullmatch(r"\b\d{4}[-\s]\d{2}\b", s):
        flag = True
    # Email address
    if re.fullmatch(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", s):
        flag = True
    return flag


def isfloat(num):
    try:
        float(num)
        return True
    except ValueError:
        return False


def eval_score(question, gt, pred):
    prompt = """
        你是一个评委，根据问题和标准答案对学生的答案进行打分。打分规则如下：

        完全不对（0分）：
        学生答案与问题无关，未展示出任何相关概念或知识。
        对了一部分（0.5分）：
        学生答案提供了一些相关信息，但未能直接回答问题。
        答案中包含部分正确内容，但缺乏关键信息，导致整体理解不清。
        基本正确（0.7分）：
        学生答案提供了大部分关键信息，不过依然距离标准答案有一定缺失。
        答案中包含部分关键内容，但缺乏部分信息，导致不够完整。
        完全正确（1分）：
        学生答案准确地回答了问题，涵盖所有关键信息。
        表达清晰，逻辑合理，直接且有效地回应了问题。

        问题：{}

        标准答案：{}

        学生答案：{}
        """

    max_try = 20
    try_i = 0
    while try_i < max_try:
        try:
            llm_input_prompt_score = (
                prompt.format(question, gt, pred)
                + """请返回给我一个json：
            {
                "分数": 1,
                "理由": "xxxx"
            }"""
            )
            score = chat_llm.generate(
                [
                    {"role": "user", "content": llm_input_prompt_score},
                ]
            )

            print(f"score: {score}")
            score_real = eval(score.replace("json", "").replace("\n", "").replace("```", ""))
            return float(score_real["分数"])
        except Exception:
            traceback.print_exc()
            print(f"trying num {try_i}")
            try_i += 1
    return -1


def eval_acc_and_f1(samples):
    evaluated_samples = [sample for sample in samples if "score" in sample]
    if not evaluated_samples:
        return 0.0, 0.0

    acc = sum([sample["score"] for sample in evaluated_samples]) / len(evaluated_samples)
    try:
        recall = sum(
            [
                sample["score"]
                for sample in evaluated_samples
                if sample["answer"] != "Not answerable"
            ]
        ) / len([sample for sample in evaluated_samples if sample["answer"] != "Not answerable"])
        precision = sum(
            [
                sample["score"]
                for sample in evaluated_samples
                if sample["answer"] != "Not answerable"
            ]
        ) / len([sample for sample in evaluated_samples if sample["pred"] != "Not answerable"])
        f1 = 2 * recall * precision / (recall + precision) if (recall + precision) > 0.0 else 0.0
    except Exception:
        f1 = 0.0

    return acc, f1


def show_results(samples, show_path=None):
    for sample in samples:
        sample["evidence_pages"] = eval(sample["evidence_pages"])
        sample["evidence_sources"] = eval(sample["evidence_sources"])

    with open(show_path, "w") as f:
        acc, f1 = eval_acc_and_f1(samples)
        f.write(f"Overall Acc: {acc} | Question Number: {len(samples)}\n")
        f.write(f"Overall F1-score: {f1} | Question Number: {len(samples)}\n")
        f.write("-----------------------\n")

        acc_single_page, _ = eval_acc_and_f1(
            [sample for sample in samples if len(sample["evidence_pages"]) == 1]
        )
        acc_multi_page, _ = eval_acc_and_f1(
            [
                sample
                for sample in samples
                if len(sample["evidence_pages"]) != 1 and sample["answer"] != "Not answerable"
            ]
        )
        acc_neg, _ = eval_acc_and_f1(
            [sample for sample in samples if sample["answer"] == "Not answerable"]
        )

        f.write(
            "Single-page | Accuracy: {} | Question Number: {}\n".format(
                acc_single_page,
                len([sample for sample in samples if len(sample["evidence_pages"]) == 1]),
            )
        )
        f.write(
            "Cross-page | Accuracy: {} | Question Number: {}\n".format(
                acc_multi_page,
                len(
                    [
                        sample
                        for sample in samples
                        if len(sample["evidence_pages"]) != 1
                        and sample["answer"] != "Not answerable"
                    ]
                ),
            )
        )
        f.write(
            "Unanswerable | Accuracy: {} | Question Number: {}\n".format(
                acc_neg, len([sample for sample in samples if sample["answer"] == "Not answerable"])
            )
        )
        f.write("-----------------------\n")

        source_sample_dict, document_type_dict = defaultdict(list), defaultdict(list)
        for sample in samples:
            for answer_source in sample["evidence_sources"]:
                source_sample_dict[answer_source].append(sample)
            document_type_dict[sample["doc_type"]].append(sample)
        for type, sub_samples in source_sample_dict.items():
            f.write(
                f"Evidence Sources: {type} | Accuracy: {eval_acc_and_f1(sub_samples)[0]} | Question Number: {len(sub_samples)}\n"
            )

        f.write("-----------------------\n")
        for type, sub_samples in document_type_dict.items():
            f.write(
                f"Document Type: {type} | Accuracy: {eval_acc_and_f1(sub_samples)[0]} | Question Number: {len(sub_samples)}\n"
            )
