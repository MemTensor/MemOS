# Modify the code from the mem0 project

import argparse
import concurrent.futures
import json
import re
import threading
import time

from collections import defaultdict

import nltk
import torch

from nltk.translate.bleu_score import SmoothingFunction, sentence_bleu
from nltk.translate.meteor_score import meteor_score
from openai import OpenAI
from rouge_score import rouge_scorer
from scipy.spatial.distance import cosine
from sentence_transformers import SentenceTransformer
from tqdm import tqdm


try:
    nltk.download("punkt", quiet=True)
    nltk.download("wordnet", quiet=True)
except Exception as e:
    print(f"Error downloading NLTK data: {e}")

# Initialize SentenceTransformer model (this will be reused)
try:
    sentence_model = SentenceTransformer("all-MiniLM-L6-v2")
except Exception as e:
    print(f"Warning: Could not load SentenceTransformer model: {e}")
    sentence_model = None

import os

from dotenv import load_dotenv


load_dotenv()

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL"))

ACCURACY_PROMPT = """
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
"""


def extract_json(text):
    """
    Extracts JSON content from a string, removing enclosing triple backticks and optional 'json' tag if present.
    If no code block is found, returns the text as-is.
    """
    text = text.strip()
    match = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL)
    json_str = match.group(1) if match else text
    return json_str


def simple_tokenize(text):
    """Simple tokenization function."""
    # Convert to string if not already
    text = str(text)
    return (
        text.lower().replace(".", " ").replace(",", " ").replace("!", " ").replace("?", " ").split()
    )


def evaluate_llm_judge(question, gold_answer, generated_answer):
    """Evaluate the generated answer against the gold answer using an LLM judge."""
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "user",
                "content": ACCURACY_PROMPT.format(
                    question=question, gold_answer=gold_answer, generated_answer=generated_answer
                ),
            }
        ],
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    label = json.loads(extract_json(response.choices[0].message.content))["label"]
    return 1 if label == "CORRECT" else 0


def calculate_bleu_scores(prediction: str, reference: str) -> dict[str, float]:
    """Calculate BLEU scores with different n-gram settings."""
    pred_tokens = nltk.word_tokenize(prediction.lower())
    ref_tokens = [nltk.word_tokenize(reference.lower())]

    weights_list = [(1, 0, 0, 0), (0.5, 0.5, 0, 0), (0.33, 0.33, 0.33, 0), (0.25, 0.25, 0.25, 0.25)]
    smooth = SmoothingFunction().method1

    scores = {}
    for n, weights in enumerate(weights_list, start=1):
        try:
            score = sentence_bleu(
                ref_tokens, pred_tokens, weights=weights, smoothing_function=smooth
            )
        except Exception as e:
            print(f"Error calculating BLEU score: {e}")
            score = 0.0
        scores[f"bleu{n}"] = score

    return scores


def calculate_rouge_scores(gold_answer, response):
    metrics = {"rouge1_f": 0.0, "rouge2_f": 0.0, "rougeL_f": 0.0}
    try:
        scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)
        rouge_scores = scorer.score(gold_answer, response)
        metrics["rouge1_f"] = rouge_scores["rouge1"].fmeasure
        metrics["rouge2_f"] = rouge_scores["rouge2"].fmeasure
        metrics["rougeL_f"] = rouge_scores["rougeL"].fmeasure
    except Exception as e:
        print(f"Failed to calculate ROUGE scores: {e}")
    return metrics


def calculate_meteor_score(gold_tokens, response_tokens):
    try:
        return meteor_score([gold_tokens], response_tokens)
    except Exception as e:
        print(f"Failed to calculate METEOR score: {e}")
        return 0.0


def calculate_semantic_similarity2(gold_answer, response):
    global sentence_model

    try:
        if sentence_model is None:
            """强制将模型加载到 CPU 或 GPU（例如 "cuda:0"）"""
            device = "cuda" if torch.cuda.is_available() else "cpu"
            sentence_model = SentenceTransformer("Qwen3-Embedding-0.6B", device=device)

        gold_embedding = sentence_model.encode([gold_answer], show_progress_bar=False)[0]
        response_embedding = sentence_model.encode([response], show_progress_bar=False)[0]
        return 1 - cosine(gold_embedding, response_embedding)
    except Exception as e:
        print(f"Failed to calculate semantic similarity: {e}")
        return 0.0


def calculate_semantic_similarity(gold_answer, response):
    global sentence_model

    try:
        if sentence_model is None:
            """加载到 meta 设备（仅结构）"""
            sentence_model = SentenceTransformer("Qwen3-Embedding-0.6B", device="meta")

        """将模型迁移到实际设备（例如 "cuda:0"）"""
        device = "cuda" if torch.cuda.is_available() else "cpu"
        sentence_model = sentence_model.to_empty(device=device)
        """重新初始化模型参数（如果需要）"""
        sentence_model.load_state_dict(sentence_model.state_dict())  # 从 meta 转移到实际设备

        gold_embedding = sentence_model.encode([gold_answer], show_progress_bar=False)[0].to(device)
        response_embedding = sentence_model.encode([response], show_progress_bar=False)[0].to(
            device
        )
        return 1 - cosine(gold_embedding, response_embedding)
    except Exception as e:
        print(f"Failed to calculate semantic similarity: {e}")
        return 0.0


def calculate_metrics(prediction: str, reference: str) -> dict[str, float]:
    """Calculate comprehensive evaluation metrics for a prediction."""
    # Handle empty or None values
    if not prediction or not reference:
        return {
            "exact_match": 0,
            "f1": 0.0,
            "rouge1_f": 0.0,
            "rouge2_f": 0.0,
            "rougeL_f": 0.0,
            "bleu1": 0.0,
            "bleu2": 0.0,
            "bleu3": 0.0,
            "bleu4": 0.0,
            "meteor": 0.0,
            "sbert_similarity": 0.0,
            "bert_f1": 0.0,
            "similarity": 0.0,
        }

    # Convert to strings if they're not already
    prediction = str(prediction).strip()
    reference = str(reference).strip()

    # Calculate exact match
    exact_match = int(prediction.lower() == reference.lower())

    # Calculate token-based F1 score
    pred_tokens = set(simple_tokenize(prediction))
    ref_tokens = set(simple_tokenize(reference))
    common_tokens = pred_tokens & ref_tokens

    if not pred_tokens or not ref_tokens:
        f1 = 0.0
    else:
        precision = len(common_tokens) / len(pred_tokens)
        recall = len(common_tokens) / len(ref_tokens)
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    # Calculate all scores
    bleu_scores = calculate_bleu_scores(prediction, reference)

    # rouge all scores
    rouge_scores = calculate_rouge_scores(prediction, reference)

    # Calculate meteor scores
    prediction_tokens = nltk.word_tokenize(prediction.lower())
    reference_tokens = nltk.word_tokenize(reference.lower())
    meteor_score = calculate_meteor_score(prediction_tokens, reference_tokens)

    # Calculate bert_f1
    bert_f1 = f1.item() if isinstance(f1, torch.Tensor) else float(f1) if f1 is not None else 0.0

    # Combine all metrics
    metrics = {
        "exact_match": exact_match,
        "f1": f1,
        "meteor_score": meteor_score,
        "bert_f1": bert_f1,
        **bleu_scores,
        **rouge_scores,
    }
    return metrics


def process_item(item_data):
    k, v = item_data
    local_results = defaultdict(list)

    for item in tqdm(v):
        gt_answer = str(item["answer"])
        pred_answer = str(item["response"])
        category = str(item["category"])
        question = str(item["question"])
        search_time = str(item["search_time"])
        response_time = str(item["response_time"])
        search_context = str(item["context"])

        # Skip category 5
        if category == "5":
            continue

        local_results[k].append(
            {
                "question": question,
                "golden_answer": gt_answer,
                "answer": pred_answer,
                "category": int(category),
                "response_duration_ms": float(response_time) * 1000,
                "search_duration_ms": float(search_time) * 1000,
                "search_context": search_context,
                # "llm_score_std":np.std(llm_score)
            }
        )

    return local_results


def rename_json_keys(file_path):
    with open(file_path, encoding="utf-8") as f:
        data = json.load(f)

    new_data = {}
    for old_key in data:
        new_key = f"locomo_exp_user_{old_key}"
        new_data[new_key] = data[old_key]

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(new_data, f, indent=2, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(description="Evaluate RAG results")
    parser.add_argument(
        "--input_file",
        type=str,
        default="results/rag_results_1000_k1.json",
        help="Path to the input dataset file",
    )
    parser.add_argument(
        "--output_file",
        type=str,
        default="evaluation_metrics.json",
        help="Path to save the evaluation results",
    )
    parser.add_argument(
        "--max_workers", type=int, default=10, help="Maximum number of worker threads"
    )

    args = parser.parse_args()

    with open(args.input_file) as f:
        data = json.load(f)

    results = defaultdict(list)
    results_lock = threading.Lock()

    # Use ThreadPoolExecutor with specified workers
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.max_workers) as executor:
        futures = [executor.submit(process_item, item_data) for item_data in data.items()]

        for future in tqdm(concurrent.futures.as_completed(futures), total=len(futures)):
            local_results = future.result()
            with results_lock:
                for k, items in local_results.items():
                    results[k].extend(items)

    # Save results to JSON file
    with open(args.output_file, "w") as f:
        json.dump(results, f, indent=4)

    rename_json_keys(args.output_file)
    print(f"Results saved to {args.output_file}")


if __name__ == "__main__":
    start = time.time()
    main()
    end = time.time()
    print(f"Evaluating time is:{end - start}")
