import argparse
import asyncio
import json
import logging
import os
import re
import time

import nltk
import numpy as np
import tiktoken
import transformers

from bert_score import score as bert_score
from dotenv import load_dotenv
from nltk.translate.bleu_score import SmoothingFunction, sentence_bleu
from nltk.translate.meteor_score import meteor_score
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from rouge_score import rouge_scorer
from scipy.spatial.distance import cosine
from sentence_transformers import SentenceTransformer
from tqdm import tqdm


logging.basicConfig(level=logging.CRITICAL)
transformers.logging.set_verbosity_error()
encoding = tiktoken.get_encoding("cl100k_base")
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


def extract_label_json(text: str) -> str | None:
    """
    Extracts a JSON object of the form {"label": "VALUE"} from a given text string.
    This function is designed to handle cases where the LLM response contains
    natural language alongside a final JSON snippet, ensuring robust parsing.

    Supports both single and double quotes around the label value.
    Ignores surrounding whitespace and formatting.

    Returns:
        The full matching JSON string (e.g., '{"label": "CORRECT"}') if found.
        None if no valid label JSON is found.
    """
    # Regex pattern to match: { "label": "value" } with optional whitespace
    # Matches both single and double quotes, allows spaces around keys and values
    pattern = r'\{\s*"label"\s*:\s*["\']([^"\']*)["\']\s*\}'
    match = re.search(pattern, text)
    if match:
        # Return the complete matched JSON string for safe json.loads()
        return match.group(0)
    return None


async def locomo_grader(llm_client, question: str, gold_answer: str, response: str) -> bool:
    system_prompt = """
        You are an expert grader that determines if answers to questions match a gold standard answer
        """

    accuracy_prompt = f"""
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

    Now it’s time for the real question:
    Question: {question}
    Gold answer: {gold_answer}
    Generated answer: {response}

    First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
    Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

    Just return the label CORRECT or WRONG in a json format with the key as "label".
    """
    try:
        response = await llm_client.chat.completions.create(
            model=os.getenv("EVAL_MODEL", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": accuracy_prompt},
            ],
            temperature=0,
        )
        message_content = response.choices[0].message.content
        message_content = extract_label_json(text=message_content)
        label = json.loads(message_content)["label"]
        parsed = LLMGrade(llm_judgment=label, llm_reasoning="")
        return parsed.llm_judgment.strip().lower() == "correct"
    except Exception as e:
        print(f"======== {e}, {response} ===========")
        exit()


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


def calculate_semantic_similarity(gold_answer, response):
    global sentence_model

    try:
        if sentence_model is None:
            sentence_model = SentenceTransformer("Qwen/Qwen3-Embedding-0.6B")

        gold_embedding = sentence_model.encode([gold_answer], show_progress_bar=False)[0]
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


def calculate_nlp_metrics(gold_answer, response, context, options=None):
    if options is None:
        options = ["lexical", "semantic"]

    gold_answer = str(gold_answer) if gold_answer is not None else ""
    response = str(response) if response is not None else ""

    metrics = {"context_tokens": len(encoding.encode(context)) if context else 0}

    if "lexical" in options:
        gold_tokens = nltk.word_tokenize(gold_answer.lower())
        response_tokens = nltk.word_tokenize(response.lower())

        metrics["lexical"] = {}
        metrics["lexical"]["f1"] = calculate_f1_score(gold_tokens, response_tokens)
        metrics["lexical"].update(calculate_rouge_scores(gold_answer, response))
        metrics["lexical"].update(calculate_bleu_scores(gold_tokens, response_tokens))
        metrics["lexical"]["meteor"] = calculate_meteor_score(gold_tokens, response_tokens)

    if "semantic" in options:
        metrics["semantic"] = {}
        metrics["semantic"]["similarity"] = calculate_semantic_similarity(gold_answer, response)
        _, _, f1 = bert_score(
            [gold_answer], [response], lang="en", rescale_with_baseline=True, verbose=False
        )
        metrics["semantic"]["bert_f1"] = f1.item() if f1 is not None else 0.0

    return metrics


def convert_numpy_types(obj):
    if isinstance(obj, np.number):
        return float(obj)
    elif isinstance(obj, dict):
        return {k: convert_numpy_types(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_numpy_types(i) for i in obj]
    else:
        return obj


async def process_group_responses(group_id, group_responses, oai_client, options, num_runs: int):
    graded_responses = []

    # Process responses with asyncio for concurrent API calls
    for response in tqdm(group_responses, desc=f"Processing group {group_id}"):
        question = response.get("question")
        answer = response.get("answer")
        ground_truth = response.get("golden_answer")
        category = response.get("category")

        context = response.get("search_context", "")
        response_duration_ms = response.get("response_duration_ms", 0.0)
        search_duration_ms = response.get("search_duration_ms", 0.0)

        if ground_truth is None:
            continue

        grading_tasks = [
            locomo_grader(oai_client, question, ground_truth, answer) for _ in range(num_runs)
        ]
        judgments = await asyncio.gather(*grading_tasks)
        judgments_dict = {f"judgment_{i + 1}": j for i, j in enumerate(judgments)}

        nlp_metrics = calculate_nlp_metrics(ground_truth, answer, context, options)

        graded_response = {
            "question": question,
            "answer": answer,
            "golden_answer": ground_truth,
            "category": category,
            "llm_judgments": judgments_dict,
            "nlp_metrics": nlp_metrics,
            "response_duration_ms": response_duration_ms,
            "search_duration_ms": search_duration_ms,
            "total_duration_ms": response_duration_ms + search_duration_ms,
        }
        graded_responses.append(graded_response)

    return group_id, graded_responses


async def process_single_group(group_id, group_responses, oai_client, options, num_runs):
    try:
        start_time = time.time()
        result = await process_group_responses(
            group_id, group_responses, oai_client, options, num_runs
        )
        end_time = time.time()
        elapsed_time = round(end_time - start_time, 2)
        print(f"Group {group_id} processed in {elapsed_time} seconds")
        return result
    except Exception as e:
        print(f"Error processing group {group_id}: {e}")
        return group_id, []


async def main(frame, version="default", options=None, num_runs=1, max_workers=4):
    print(
        f"\n=== Starting LoCoMo evaluation for {frame} (version: {version}) with {num_runs} run(s) per question ==="
    )
    print(f"Using {max_workers} concurrent workers for processing groups")

    results_dir = f"results/locomo/{frame}-{version}"
    response_path = f"{results_dir}/{frame}_locomo_responses.json"
    judged_path = f"{results_dir}/{frame}_locomo_judged.json"

    os.makedirs(results_dir, exist_ok=True)

    load_dotenv()
    oai_client = AsyncOpenAI(
        api_key=os.getenv("OPENAI_API_KEY"), base_url=os.getenv("OPENAI_BASE_URL")
    )

    with open(response_path) as file:
        locomo_responses = json.load(file)

    num_users = 10
    all_grades = {}

    total_responses_count = sum(
        len(locomo_responses.get(f"locomo_exp_user_{i}", [])) for i in range(num_users)
    )
    print(f"Found {total_responses_count} total responses across {num_users} users to evaluate")

    # Create tasks for processing each group
    tasks = []
    active_users = 0
    for group_idx in range(num_users):
        group_id = f"locomo_exp_user_{group_idx}"
        group_responses = locomo_responses.get(group_id, [])
        if not group_responses:
            print(f"No responses found for group {group_id}")
            continue

        active_users += 1
        tasks.append(process_single_group(group_id, group_responses, oai_client, options, num_runs))

    print(f"Starting evaluation of {active_users} user groups with responses")

    semaphore = asyncio.Semaphore(max_workers)

    async def limited_task(task):
        async with semaphore:
            return await task

    limited_tasks = [limited_task(task) for task in tasks]
    group_results = await asyncio.gather(*limited_tasks)

    for group_id, graded_responses in group_results:
        all_grades[group_id] = graded_responses

    print("\n=== Evaluation Complete: Calculating final scores ===")

    run_scores = []
    evaluated_count = 0
    if num_runs > 0:
        for i in range(1, num_runs + 1):
            judgment_key = f"judgment_{i}"
            current_run_correct_count = 0
            current_run_total_count = 0
            for group in all_grades.values():
                for response in group:
                    if judgment_key in response["llm_judgments"]:
                        if response["llm_judgments"][judgment_key]:
                            current_run_correct_count += 1
                        current_run_total_count += 1

            if current_run_total_count > 0:
                run_accuracy = current_run_correct_count / current_run_total_count
                run_scores.append(run_accuracy)

        evaluated_count = current_run_total_count

    if evaluated_count > 0:
        mean_of_scores = np.mean(run_scores)
        std_of_scores = np.std(run_scores)
        print(f"LLM-as-a-Judge Mean Score: {mean_of_scores:.4f}")
        print(f"LLM-as-a-Judge Standard Deviation: {std_of_scores:.4f}")
        print(f"(Calculated from {num_runs} separate runs over {evaluated_count} questions)")
        print(f"Individual run scores: {[round(s, 4) for s in run_scores]}")
    else:
        print("No responses were evaluated")
        print("LLM-as-a-Judge score: N/A (0/0)")

    all_grades = convert_numpy_types(all_grades)
    with open(judged_path, "w") as f:
        json.dump(all_grades, f, indent=2)
        print(f"Saved detailed evaluation results to {judged_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
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
        "--version",
        type=str,
        default="default",
        help="Version identifier for loading results (e.g., 1010)",
    )
    parser.add_argument(
        "--num_runs",
        type=int,
        default=3,
        help="Number of times to run the LLM grader for each question",
    )
    parser.add_argument("--options", nargs="+", default=["lexical"])
    parser.add_argument(
        "--workers", type=int, default=10, help="Number of concurrent workers for processing groups"
    )
    args = parser.parse_args()

    asyncio.run(main(args.lib, args.version, args.options, args.num_runs, args.workers))
