import argparse
import json
import os
import sys

import numpy as np


# Import LongBench metrics
# Try to import from the LongBench directory
LONGBENCH_METRICS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "longbench_v2",
    "LongBench-main",
    "LongBench",
)

if os.path.exists(LONGBENCH_METRICS_DIR):
    sys.path.insert(0, LONGBENCH_METRICS_DIR)
    try:
        from metrics import (
            classification_score,
            code_sim_score,
            count_score,
            qa_f1_score,
            qa_f1_zh_score,
            retrieval_score,
            retrieval_zh_score,
            rouge_score,
            rouge_zh_score,
        )
    except ImportError:
        print(f"Warning: Could not import metrics from {LONGBENCH_METRICS_DIR}")
        print("Please ensure LongBench metrics.py is available")
        raise
else:
    print(f"Error: LongBench metrics directory not found at {LONGBENCH_METRICS_DIR}")
    raise FileNotFoundError("LongBench metrics directory not found")

# Dataset to metric mapping (from LongBench eval.py)
dataset2metric = {
    "narrativeqa": qa_f1_score,
    "qasper": qa_f1_score,
    "multifieldqa_en": qa_f1_score,
    "multifieldqa_zh": qa_f1_zh_score,
    "hotpotqa": qa_f1_score,
    "2wikimqa": qa_f1_score,
    "musique": qa_f1_score,
    "dureader": rouge_zh_score,
    "gov_report": rouge_score,
    "qmsum": rouge_score,
    "multi_news": rouge_score,
    "vcsum": rouge_zh_score,
    "trec": classification_score,
    "triviaqa": qa_f1_score,
    "samsum": rouge_score,
    "lsht": classification_score,
    "passage_retrieval_en": retrieval_score,
    "passage_count": count_score,
    "passage_retrieval_zh": retrieval_zh_score,
    "lcc": code_sim_score,
    "repobench-p": code_sim_score,
}


def scorer(dataset, predictions, answers, all_classes):
    """Calculate score for a dataset."""
    total_score = 0.0
    for prediction, ground_truths in zip(predictions, answers, strict=False):
        score = 0.0
        # For some tasks, only take the first line
        if dataset in ["trec", "triviaqa", "samsum", "lsht"]:
            prediction = prediction.lstrip("\n").split("\n")[0]

        # Calculate max score across all ground truth answers
        for ground_truth in ground_truths:
            metric_func = dataset2metric.get(dataset)
            if metric_func:
                if dataset in ["trec", "lsht"]:
                    # Classification tasks need all_classes
                    score = max(
                        score,
                        metric_func(prediction, ground_truth, all_classes=all_classes),
                    )
                else:
                    score = max(score, metric_func(prediction, ground_truth))
            else:
                print(f"Warning: No metric function for dataset {dataset}")

        total_score += score

    return round(100 * total_score / len(predictions), 2) if len(predictions) > 0 else 0.0


def scorer_e(dataset, predictions, answers, lengths, all_classes):
    """Calculate score for LongBench-E (with length-based analysis)."""
    scores = {"0-4k": [], "4-8k": [], "8k+": []}

    for prediction, ground_truths, length in zip(predictions, answers, lengths, strict=False):
        score = 0.0
        # For some tasks, only take the first line
        if dataset in ["trec", "triviaqa", "samsum", "lsht"]:
            prediction = prediction.lstrip("\n").split("\n")[0]

        # Calculate max score across all ground truth answers
        metric_func = dataset2metric.get(dataset)
        if metric_func:
            for ground_truth in ground_truths:
                if dataset in ["trec", "lsht"]:
                    score = max(
                        score,
                        metric_func(prediction, ground_truth, all_classes=all_classes),
                    )
                else:
                    score = max(score, metric_func(prediction, ground_truth))

        # Categorize by length
        if length < 4000:
            scores["0-4k"].append(score)
        elif length < 8000:
            scores["4-8k"].append(score)
        else:
            scores["8k+"].append(score)

    # Calculate average scores per length category
    for key in scores:
        if len(scores[key]) > 0:
            scores[key] = round(100 * np.mean(scores[key]), 2)
        else:
            scores[key] = 0.0

    return scores


def main(frame, version="default", use_e=False):
    """Main metric calculation function."""
    print("\n" + "=" * 80)
    print(f"📊 LONGBENCH METRICS CALCULATION - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Load responses
    responses_path = f"results/longbench/{frame}-{version}/{frame}_longbench_responses.json"
    if not os.path.exists(responses_path):
        print(f"❌ Responses not found: {responses_path}")
        print("Please run longbench_responses.py first")
        return

    with open(responses_path, encoding="utf-8") as f:
        responses = json.load(f)

    # Calculate metrics for each dataset
    all_scores = {}
    overall_scores = []

    for dataset_name, samples in responses.items():
        print(f"Calculating metrics for {dataset_name}...")

        predictions = [s.get("answer", "") for s in samples]
        answers = [s.get("golden_answer", []) for s in samples]
        all_classes = samples[0].get("all_classes") if samples else None

        if use_e:
            lengths = [s.get("length", 0) for s in samples]
            score = scorer_e(dataset_name, predictions, answers, lengths, all_classes)
        else:
            score = scorer(dataset_name, predictions, answers, all_classes)

        all_scores[dataset_name] = score
        print(f"  {dataset_name}: {score}")

        # For overall average, use single score (not length-based)
        if use_e:
            # Average across length categories
            if isinstance(score, dict):
                overall_scores.append(np.mean(list(score.values())))
        else:
            overall_scores.append(score)

    # Calculate overall average
    if overall_scores:
        all_scores["average"] = round(np.mean(overall_scores), 2)
        print(f"\nOverall Average: {all_scores['average']}")

    # Save metrics
    output_path = f"results/longbench/{frame}-{version}/{frame}_longbench_metrics.json"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(all_scores, f, ensure_ascii=False, indent=4)

    print(f"\n{'=' * 80}")
    print(f"✅ METRICS CALCULATION COMPLETE: Results saved to {output_path}".center(80))
    print(f"{'=' * 80}\n")

    # Print summary table
    print("\n📊 Summary of Results:")
    print("-" * 80)
    for dataset, score in sorted(all_scores.items()):
        if isinstance(score, dict):
            print(f"{dataset:30s}: {score}")
        else:
            print(f"{dataset:30s}: {score:.2f}%")
    print("-" * 80)


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
        help="Version identifier for loading results",
    )
    parser.add_argument(
        "--e",
        action="store_true",
        help="Use LongBench-E variant (uniform length distribution)",
    )
    args = parser.parse_args()

    main(args.lib, args.version, args.e)
