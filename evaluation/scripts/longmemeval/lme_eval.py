import argparse
import asyncio
import concurrent.futures
import json
import logging
import os
import sys

import nltk
import numpy as np
import tiktoken
import transformers

from bert_score import score as bert_score
from dotenv import load_dotenv
from nltk.translate.bleu_score import SmoothingFunction, sentence_bleu
from nltk.translate.meteor_score import meteor_score
from openai import OpenAI
from pydantic import BaseModel, Field
from rouge_score import rouge_scorer
from scipy.spatial.distance import cosine
from sentence_transformers import SentenceTransformer
from tqdm import tqdm


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.prompts import LME_JUDGE_MODEL_TEMPLATE


encoding = tiktoken.get_encoding("cl100k_base")
logging.basicConfig(level=logging.CRITICAL)
transformers.logging.set_verbosity_error()

# Download necessary NLTK resources
try:
    nltk.download("wordnet", quiet=True)
    nltk.download("punkt", quiet=True)
    print("NLTK resources downloaded successfully.")
except Exception as e:
    print(f"Warning: Failed to download NLTK resources: {e}")

try:
    sentence_model_name = "Qwen/Qwen3-Embedding-0.6B"
    sentence_model = SentenceTransformer(sentence_model_name)
    print(f"SentenceTransformer model : {sentence_model_name} loaded successfully.")
except Exception as e:
    print(f"Failed to load SentenceTransformer model: {e}")
    sentence_model = None


class LLMGrade(BaseModel):
    llm_judgment: str = Field(description="CORRECT or WRONG")
    llm_reasoning: str = Field(description="Explain why the answer is correct or incorrect.")


def calculate_rouge_scores(golden_answer, response):
    metrics = {"rouge1_f": 0.0, "rouge2_f": 0.0, "rougeL_f": 0.0}
    try:
        scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)
        rouge_scores = scorer.score(golden_answer, response)
        metrics["rouge1_f"] = rouge_scores["rouge1"].fmeasure
        metrics["rouge2_f"] = rouge_scores["rouge2"].fmeasure
        metrics["rougeL_f"] = rouge_scores["rougeL"].fmeasure
    except Exception as e:
        print(f"Failed to calculate ROUGE scores: {e}")
    return metrics


def calculate_bleu_scores(gold_tokens, response_tokens):
    metrics = {"bleu1": 0.0, "bleu2": 0.0, "bleu3": 0.0, "bleu4": 0.0}

    try:
        smoothing = SmoothingFunction().method1
        weights = [(1, 0, 0, 0), (0.5, 0.5, 0, 0), (0.33, 0.33, 0.33, 0), (0.25, 0.25, 0.25, 0.25)]

        for i, weight in enumerate(weights, 1):
            metrics[f"bleu{i}"] = sentence_bleu(
                [gold_tokens], response_tokens, weights=weight, smoothing_function=smoothing
            )
    except ZeroDivisionError:
        pass
    except Exception as e:
        print(f"Failed to calculate BLEU scores: {e}")

    return metrics


def calculate_meteor_score(gold_tokens, response_tokens):
    try:
        return meteor_score([gold_tokens], response_tokens)
    except Exception as e:
        print(f"Failed to calculate METEOR score: {e}")
        return 0.0


def calculate_semantic_similarity(golden_answer, response):
    global sentence_model

    try:
        if sentence_model is None:
            sentence_model = SentenceTransformer("Qwen/Qwen3-Embedding-0.6B")

        gold_embedding = sentence_model.encode([golden_answer], show_progress_bar=False)[0]
        response_embedding = sentence_model.encode([response], show_progress_bar=False)[0]
        return 1 - cosine(gold_embedding, response_embedding)
    except Exception as e:
        print(f"Failed to calculate semantic similarity: {e}")
        return 0.0


def calculate_f1_score(gold_tokens, response_tokens):
    try:
        gold_set = set(gold_tokens)
        response_set = set(response_tokens)

        if len(gold_set) == 0 or len(response_set) == 0:
            return 0.0

        precision = len(gold_set.intersection(response_set)) / len(response_set)
        recall = len(gold_set.intersection(response_set)) / len(gold_set)

        if precision + recall > 0:
            return 2 * precision * recall / (precision + recall)
        return 0.0
    except Exception as e:
        print(f"Failed to calculate F1 score: {e}")
        return 0.0


def calculate_nlp_metrics(golden_answer, response, context, options=None):
    if options is None:
        options = ["lexical", "semantic"]

    golden_answer = str(golden_answer) if golden_answer is not None else ""
    response = str(response) if response is not None else ""
    context = str(context) if context is not None else ""

    metrics = {"context_tokens": len(encoding.encode(context)) if context else 0}

    if "lexical" in options:
        gold_tokens = nltk.word_tokenize(golden_answer.lower())
        response_tokens = nltk.word_tokenize(response.lower())

        metrics["lexical"] = {}
        metrics["lexical"]["f1"] = calculate_f1_score(gold_tokens, response_tokens)
        metrics["lexical"].update(calculate_rouge_scores(golden_answer, response))
        metrics["lexical"].update(calculate_bleu_scores(gold_tokens, response_tokens))
        metrics["lexical"]["meteor"] = calculate_meteor_score(gold_tokens, response_tokens)

    if "semantic" in options:
        metrics["semantic"] = {}
        metrics["semantic"]["similarity"] = calculate_semantic_similarity(golden_answer, response)
        _, _, f1 = bert_score(
            [golden_answer], [response], lang="en", rescale_with_baseline=True, verbose=False
        )
        metrics["semantic"]["bert_f1"] = f1.item() if f1 is not None else 0.0

    return metrics


def lme_grader(llm_client, question, golden_answer, response):
    system_prompt = """You are an expert grader that determines if answers to questions match a gold standard answer"""
    judge_prompt = LME_JUDGE_MODEL_TEMPLATE.format(
        question=question, golden_answer=golden_answer, response=response
    )

    response = llm_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": judge_prompt},
        ],
        temperature=0,
    )

    message_content = response.choices[0].message.content
    label = json.loads(message_content)["label"]
    parsed = LLMGrade(llm_judgment=label, llm_reasoning="")

    return parsed.llm_judgment.strip().lower() == "correct"


async def process_qa(
    user_id, response_data, llm_client, num_runs: int, nlp_options=None, executor=None
):
    question = response_data.get("question")
    golden_answer = response_data.get("golden_answer", "")
    context = response_data.get("search_context", "")
    response = response_data.get("answer", "")

    loop = asyncio.get_event_loop()
    tasks = [
        loop.run_in_executor(executor, lme_grader, llm_client, question, golden_answer, response)
        for _ in range(num_runs)
    ]
    judgments = await asyncio.gather(*tasks)
    judgments_dict = {f"judgment_{i + 1}": j for i, j in enumerate(judgments)}

    nlp_metrics = calculate_nlp_metrics(
        golden_answer=golden_answer, response=response, context=context, options=nlp_options
    )

    print("\n" + "=" * 80)
    print(f"🔍 Processed User: {user_id}")
    print("-" * 80)
    print(f"❓ Question: \n   {question}")
    print("-" * 80)
    print(
        f"📖 Golden Answer: \n   {golden_answer[:150]}..."
        if len(str(golden_answer)) > 150
        else f"📖 Golden Answer: \n   {golden_answer}"
    )
    print("-" * 80)
    print(
        f"💬 LLM Response: \n   {response[:150]}..."
        if len(str(response)) > 150
        else f"💬 Answer: \n   {response}"
    )
    print("-" * 80)

    judgments_formatted = []
    for run, correct in judgments_dict.items():
        status = "✓ CORRECT" if correct else "✗ WRONG"
        judgments_formatted.append(f"{run}: {status}")

    print(f"⚖️  Judgments: \n   {', '.join(judgments_formatted)}")
    print("=" * 80)

    graded_response = {
        "user_id": user_id,
        "category": response_data.get("category"),
        "question": question,
        "question_date": response_data.get("question_date"),
        "golden_answer": response_data.get("golden_answer"),
        "answer": response,
        "llm_judgments": judgments_dict,
        "nlp_metrics": nlp_metrics,
        "response_duration_ms": response_data.get("response_duration_ms"),
        "search_duration_ms": response_data.get("search_duration_ms"),
        "total_duration_ms": response_data.get("response_duration_ms")
        + response_data.get("search_duration_ms", 0),
    }
    return graded_response


def convert_numpy_types(obj):
    if isinstance(obj, np.number):
        return float(obj)
    elif isinstance(obj, dict):
        return {k: convert_numpy_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_numpy_types(i) for i in obj]
    else:
        return obj


def evaluate_accuracy(results, num_runs):
    run_scores = []
    evaluated_count = 0

    for i in range(1, num_runs + 1):
        judgment_key = f"judgment_{i}"
        correct, total = 0, 0
        for _, response in results.items():
            if judgment_key in response["llm_judgments"]:
                total += 1
                if response["llm_judgments"][judgment_key]:
                    correct += 1
        if total > 0:
            run_scores.append(correct / total)
            evaluated_count += total
    evaluated_count = evaluated_count // num_runs
    return run_scores, evaluated_count


async def main(frame, version, nlp_options, num_runs=3, num_workers=5):
    print(f"Starting evaluation for {frame} version {version}...")

    load_dotenv()
    oai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL"))

    response_path = f"results/lme/{frame}-{version}/{frame}_lme_responses.json"
    judged_path = f"results/lme/{frame}-{version}/{frame}_lme_judged.json"

    with open(response_path) as file:
        lme_responses = json.load(file)

    lme_eval_results = {}
    error_count = 0

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=num_workers)
    tasks = [
        process_qa(user_id, response_data, oai_client, num_runs, nlp_options, executor)
        for user_id, response_data in lme_responses.items()
    ]
    results = []
    pbar = tqdm(total=len(tasks), desc="Processing users")
    for coro in asyncio.as_completed(tasks):
        try:
            result = await coro
            user_id = result["user_id"]
            lme_eval_results[user_id] = result
            results.append(result)
        except Exception as exc:
            print(f"[ERROR] Processing user failed: {exc}")
            error_count += 1
        pbar.update(1)
    pbar.close()
    executor.shutdown()

    run_scores, evaluated_count = evaluate_accuracy(lme_eval_results, num_runs)

    print("\n" + "=" * 80)
    print("📊 EVALUATION SUMMARY".center(80))
    print("=" * 80)

    if evaluated_count > 0:
        print(f"📋 Evaluated: {evaluated_count} responses across {num_runs} runs")
        print(f"🎯 LLM-as-a-Judge Mean Accuracy: {np.mean(run_scores):.4f}")
        print(f"🔍 Standard Deviation: {np.std(run_scores):.4f}")

        run_scores_formatted = [f"{round(s, 4):.4f}" for s in run_scores]
        print(f"🔢 Individual run scores: [{', '.join(run_scores_formatted)}]")
    else:
        print("⚠️  No responses were evaluated. LLM-as-a-Judge score: N/A (0/0)")

    if error_count > 0:
        print(f"⚠️  Encountered {error_count} errors during processing")

    print("-" * 80)

    # Convert and save results
    lme_eval_results = convert_numpy_types(lme_eval_results)
    with open(judged_path, "w") as file:
        json.dump(lme_eval_results, file, indent=4)

    print("✅ Evaluation completed successfully!")
    print(f"📁 Results saved to: {judged_path}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Evaluate LLM responses using LLM-as-a-Judge.")
    parser.add_argument(
        "--lib",
        type=str,
        choices=[
            "mem0",
            "mem0_graph",
            "memos-api",
            "memos-api-online",
            "memobase",
            "memu",
            "supermemory",
        ],
        default="memos-api",
    )
    parser.add_argument(
        "--version", type=str, default="default", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--options",
        type=str,
        nargs="+",
        default=["lexical"],
        choices=["lexical"],
        help="NLP options to use for evaluation.",
    )
    parser.add_argument(
        "--num_runs", type=int, default=1, help="Number of runs for LLM-as-a-Judge evaluation."
    )
    parser.add_argument(
        "--workers", type=int, default=30, help="Number of runs for LLM-as-a-Judge evaluation."
    )

    args = parser.parse_args()
    asyncio.run(
        main(
            frame=args.lib,
            version=args.version,
            nlp_options=args.options,
            num_runs=args.num_runs,
            num_workers=args.workers,
        )
    )
