import argparse
import json

import numpy as np
import pandas as pd


def save_to_excel(results, output_path):
    combined_data = []
    overall_row = {"category": "overall"}
    overall_row["llm_judge_score"] = results["metrics"]["llm_judge_score"]
    overall_row["llm_judge_std"] = results["metrics"]["llm_judge_std"]
    for metric, value in results["metrics"]["lexical"].items():
        overall_row[metric] = value
    for metric, value in results["metrics"]["semantic"].items():
        overall_row[metric] = value
    overall_row["context_tokens"] = results["metrics"]["context_tokens"]
    for metric, value in results["metrics"]["duration"].items():
        overall_row[metric] = value
    combined_data.append(overall_row)
    for _, scores in results["category_scores"].items():
        category_row = {"category": scores["category_name"]}
        category_row["llm_judge_score"] = scores["llm_judge_score"]
        category_row["llm_judge_std"] = scores["llm_judge_std"]
        for metric, value in scores["lexical"].items():
            category_row[metric] = value
        for metric, value in scores["semantic"].items():
            category_row[metric] = value
        category_row["context_tokens"] = scores["context_tokens"]
        for metric, value in scores["duration"].items():
            category_row[metric] = value
        combined_data.append(category_row)
    pd.DataFrame(combined_data).to_excel(output_path, sheet_name="Metrics", index=False)
    print(f"Excel file saved to: {output_path}")


def calculate_scores(data, grade_path, output_path):
    category_scores, category_question_count = {}, {}
    overall_metrics = {
        "lexical": {
            m: []
            for m in [
                "f1",
                "rouge1_f",
                "rouge2_f",
                "rougeL_f",
                "bleu1",
                "bleu2",
                "bleu3",
                "bleu4",
                "meteor",
            ]
        },
        "semantic": {m: [] for m in ["bert_f1", "similarity"]},
        "context_tokens": [],
        "duration": {
            m: [] for m in ["response_duration_ms", "search_duration_ms", "total_duration_ms"]
        },
    }
    category_metrics, user_metrics = {}, {}
    all_judgment_keys = set()
    judgment_run_scores = {}

    for q in data.values():
        if "llm_judgments" in q:
            all_judgment_keys.update(q["llm_judgments"].keys())
    for k in all_judgment_keys:
        judgment_run_scores[k] = []

    for _, (user, q) in enumerate(data.items()):
        user_metrics[user] = {
            "total": 0,
            "llm_judge_score": 0,
            "llm_judge_std": 0,
            "judgment_run_scores": {k: [] for k in all_judgment_keys},
            "lexical": {m: [] for m in overall_metrics["lexical"]},
            "semantic": {m: [] for m in overall_metrics["semantic"]},
            "context_tokens": [],
            "duration": {m: [] for m in overall_metrics["duration"]},
        }
        if "llm_judgments" in q:
            for k, v in q["llm_judgments"].items():
                score = 1 if v else 0
                judgment_run_scores[k].append(score)
                user_metrics[user]["judgment_run_scores"][k].append(score)
        cat = q["category"]
        if cat not in category_scores:
            category_scores[cat] = {
                "total": 0,
                "category_name": cat,
                "judgment_run_scores": {k: [] for k in all_judgment_keys},
            }
            category_metrics[cat] = {
                "lexical": {m: [] for m in overall_metrics["lexical"]},
                "semantic": {m: [] for m in overall_metrics["semantic"]},
                "context_tokens": [],
                "duration": {m: [] for m in overall_metrics["duration"]},
            }
            category_question_count[cat] = 0
        category_scores[cat]["total"] += 1
        category_question_count[cat] += 1
        if "llm_judgments" in q:
            for k, v in q["llm_judgments"].items():
                score = 1 if v else 0
                category_scores[cat]["judgment_run_scores"][k].append(score)
        nlp = q.get("nlp_metrics", {})
        for m in overall_metrics["lexical"]:
            v = nlp.get("lexical", {}).get(m)
            if v is not None:
                overall_metrics["lexical"][m].append(v)
                category_metrics[cat]["lexical"][m].append(v)
                user_metrics[user]["lexical"][m].append(v)
        for m in overall_metrics["semantic"]:
            v = nlp.get("semantic", {}).get(m)
            if v is not None:
                overall_metrics["semantic"][m].append(v)
                category_metrics[cat]["semantic"][m].append(v)
                user_metrics[user]["semantic"][m].append(v)
        ct = nlp.get("context_tokens")
        if ct is not None:
            overall_metrics["context_tokens"].append(ct)
            category_metrics[cat]["context_tokens"].append(ct)
            user_metrics[user]["context_tokens"].append(ct)
        for m in overall_metrics["duration"]:
            v = q.get(m)
            if v is not None:
                overall_metrics["duration"][m].append(v)
                category_metrics[cat]["duration"][m].append(v)
                user_metrics[user]["duration"][m].append(v)
        user_metrics[user]["total"] = 1
        judgment_avgs = [
            np.mean(scores)
            for scores in user_metrics[user]["judgment_run_scores"].values()
            if scores
        ]
        user_metrics[user]["llm_judge_score"] = np.mean(judgment_avgs) if judgment_avgs else 0.0
        user_metrics[user]["llm_judge_std"] = (
            np.std(judgment_avgs) if len(judgment_avgs) > 1 else 0.0
        )
        for group in ["lexical", "semantic"]:
            for m in user_metrics[user][group]:
                vals = user_metrics[user][group][m]
                user_metrics[user][group][m] = np.mean(vals) if vals else 0.0
        user_metrics[user]["context_tokens"] = (
            np.mean(user_metrics[user]["context_tokens"])
            if user_metrics[user]["context_tokens"]
            else 0.0
        )
        for m in list(user_metrics[user]["duration"].keys()):
            vals = user_metrics[user]["duration"][m]
            if vals:
                user_metrics[user]["duration"][m] = np.mean(vals)
                user_metrics[user]["duration"][f"{m}_p50"] = np.percentile(vals, 50)
                user_metrics[user]["duration"][f"{m}_p95"] = np.percentile(vals, 95)
            else:
                user_metrics[user]["duration"][m] = 0.0
                user_metrics[user]["duration"][f"{m}_p50"] = 0.0
                user_metrics[user]["duration"][f"{m}_p95"] = 0.0

    judgment_run_averages = [np.mean(scores) for scores in judgment_run_scores.values() if scores]
    llm_judge_score = np.mean(judgment_run_averages) if judgment_run_averages else 0.0
    llm_judge_std = np.std(judgment_run_averages) if len(judgment_run_averages) > 1 else 0.0

    category_overall_scores = {}
    for cat, score_data in category_scores.items():
        cat_judgment_avgs = [
            np.mean(scores) for scores in score_data["judgment_run_scores"].values() if scores
        ]
        category_overall_scores[cat] = {
            "category_name": score_data["category_name"],
            "llm_judge_score": np.mean(cat_judgment_avgs) if cat_judgment_avgs else 0.0,
            "llm_judge_std": np.std(cat_judgment_avgs) if len(cat_judgment_avgs) > 1 else 0.0,
            "total": score_data["total"],
            "lexical": {},
            "semantic": {},
            "duration": {},
            "context_tokens": 0.0,
        }
        for group in ["lexical", "semantic"]:
            for m in category_metrics[cat][group]:
                vals = category_metrics[cat][group][m]
                category_overall_scores[cat][group][m] = np.mean(vals) if vals else 0.0
        category_overall_scores[cat]["context_tokens"] = (
            np.mean(category_metrics[cat]["context_tokens"])
            if category_metrics[cat]["context_tokens"]
            else 0.0
        )
        for m in list(category_metrics[cat]["duration"].keys()):
            vals = category_metrics[cat]["duration"][m]
            if vals:
                category_overall_scores[cat]["duration"][m] = np.mean(vals)
                category_overall_scores[cat]["duration"][f"{m}_p50"] = np.percentile(vals, 50)
                category_overall_scores[cat]["duration"][f"{m}_p95"] = np.percentile(vals, 95)
            else:
                category_overall_scores[cat]["duration"][m] = 0.0
                category_overall_scores[cat]["duration"][f"{m}_p50"] = 0.0
                category_overall_scores[cat]["duration"][f"{m}_p95"] = 0.0

    overall_metric_averages = {
        "llm_judge_score": llm_judge_score,
        "llm_judge_std": llm_judge_std,
        "lexical": {},
        "semantic": {},
        "context_tokens": 0.0,
        "duration": {},
    }
    for group in ["lexical", "semantic"]:
        for m in overall_metrics[group]:
            vals = overall_metrics[group][m]
            overall_metric_averages[group][m] = np.mean(vals) if vals else 0.0
    overall_metric_averages["context_tokens"] = (
        np.mean(overall_metrics["context_tokens"]) if overall_metrics["context_tokens"] else 0.0
    )
    for m in list(overall_metrics["duration"].keys()):
        vals = overall_metrics["duration"][m]
        if vals:
            overall_metric_averages["duration"][m] = np.mean(vals)
            overall_metric_averages["duration"][f"{m}_p50"] = np.percentile(vals, 50)
            overall_metric_averages["duration"][f"{m}_p95"] = np.percentile(vals, 95)
        else:
            overall_metric_averages["duration"][m] = 0.0
            overall_metric_averages["duration"][f"{m}_p50"] = 0.0
            overall_metric_averages["duration"][f"{m}_p95"] = 0.0

    results = {
        "metrics": overall_metric_averages,
        "category_scores": category_overall_scores,
        "user_scores": user_metrics,
    }
    with open(grade_path, "w") as outfile:
        json.dump(results, outfile, indent=4)
    save_to_excel(results, output_path)

    print("\n" + "=" * 80)
    print("📊 \033[1;36mMETRIC CALCULATION SUMMARY\033[0m".center(80))
    print("=" * 80)
    total = sum(results["category_scores"][cat]["total"] for cat in results["category_scores"])
    print(
        f"🤖 \033[1mLLM-as-a-Judge score:\033[0m \033[92m{results['metrics']['llm_judge_score']:.4f}\033[0m ± \033[93m{results['metrics']['llm_judge_std']:.4f}\033[0m"
    )
    print(f"📋 \033[1mTotal questions evaluated:\033[0m \033[93m{total}\033[0m")
    print("-" * 80)
    print("⏱️  \033[1mDuration Metrics (ms):\033[0m")
    for m in ["response_duration_ms", "search_duration_ms", "total_duration_ms"]:
        print(
            f"   \033[94m{m:<22}\033[0m (avg): \033[92m{results['metrics']['duration'][m]:.2f}\033[0m"
            f" | (P50): \033[96m{results['metrics']['duration'][f'{m}_p50']:.2f}\033[0m"
            f" | (P95): \033[91m{results['metrics']['duration'][f'{m}_p95']:.2f}\033[0m"
        )
    print("-" * 80)
    print(f"📁 \033[1mResults written to:\033[0m \033[1;94m{grade_path}\033[0m")
    print(f"📊 \033[1mExcel report saved to:\033[0m \033[1;94m{output_path}\033[0m")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser("LongMemeval Analysis Eval Metric Script")
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
    args = parser.parse_args()
    lib, version = args.lib, args.version
    judged_path = f"results/lme/{lib}-{version}/{lib}_lme_judged.json"
    grade_path = f"results/lme/{lib}-{version}/{lib}_lme_grades.json"
    output_path = f"results/lme/{lib}-{version}/{lib}_lme_results.xlsx"
    with open(judged_path) as file:
        data = json.load(file)
    calculate_scores(data, grade_path, output_path)
