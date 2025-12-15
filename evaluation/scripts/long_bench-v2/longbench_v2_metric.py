import argparse
import json
import os


def calculate_accuracy(responses):
    """Calculate accuracy metrics for LongBench v2.

    Logic is aligned with longbench_stx.print_metrics, but returns a dict
    and additionally computes by_domain statistics.
    """
    total = len(responses)
    if total == 0:
        return {}

    # Counters (aligned with longbench_stx.print_metrics)
    easy = hard = short = medium = long = 0
    easy_acc = hard_acc = short_acc = medium_acc = long_acc = 0

    for pred in responses:
        acc = int(pred.get("judge", False))
        diff = pred.get("difficulty", "easy")
        length = pred.get("length", "short")

        if diff == "easy":
            easy += 1
            easy_acc += acc
        else:
            hard += 1
            hard_acc += acc

        if length == "short":
            short += 1
            short_acc += acc
        elif length == "medium":
            medium += 1
            medium_acc += acc
        else:
            long += 1
            long_acc += acc

    o_acc = round(100 * (easy_acc + hard_acc) / total, 2)
    e_acc = round(100 * easy_acc / easy, 2) if easy > 0 else 0.0
    h_acc = round(100 * hard_acc / hard, 2) if hard > 0 else 0.0
    s_acc = round(100 * short_acc / short, 2) if short > 0 else 0.0
    m_acc = round(100 * medium_acc / medium, 2) if medium > 0 else 0.0
    l_acc = round(100 * long_acc / long, 2) if long > 0 else 0.0

    # Additional by-domain stats (extra vs. stx)
    domain_stats = {}
    for r in responses:
        domain = r.get("domain", "Unknown")
        if domain not in domain_stats:
            domain_stats[domain] = {"total": 0, "correct": 0}
        domain_stats[domain]["total"] += 1
        if r.get("judge", False):
            domain_stats[domain]["correct"] += 1

    domain_acc = {
        domain: round(100 * stats["correct"] / stats["total"], 2)
        for domain, stats in domain_stats.items()
    }

    return {
        "overall": o_acc,
        "easy": e_acc,
        "hard": h_acc,
        "short": s_acc,
        "medium": m_acc,
        "long": l_acc,
        "by_domain": domain_acc,
        "total_samples": total,
        "correct_samples": easy_acc + hard_acc,
    }


def main(frame, version="default"):
    """Main metric calculation function."""
    print("\n" + "=" * 80)
    print(f"📊 LONGBENCH V2 METRICS CALCULATION - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Load responses
    responses_path = f"results/long_bench_v2/{frame}-{version}/{frame}_longbench_v2_responses.json"
    if not os.path.exists(responses_path):
        print(f"❌ Responses not found: {responses_path}")
        print("Please run longbench_v2_responses.py first")
        return

    with open(responses_path, encoding="utf-8") as f:
        responses = json.load(f)

    # Use all responses (aligned with longbench_stx.print_metrics behavior)
    filtered = responses

    # Calculate metrics
    metrics = calculate_accuracy(filtered)

    # Save metrics
    output_path = f"results/long_bench_v2/{frame}-{version}/{frame}_longbench_v2_metrics.json"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=4)

    print(f"\n{'=' * 80}")
    print(f"✅ METRICS CALCULATION COMPLETE: Results saved to {output_path}".center(80))
    print(f"{'=' * 80}\n")

    # Print summary table
    print("\n📊 Summary of Results:")
    print("-" * 80)
    print(f"{'Overall Accuracy':<30s}: {metrics['overall']:.2f}%")
    print(f"{'Easy':<30s}: {metrics['easy']:.2f}%")
    print(f"{'Hard':<30s}: {metrics['hard']:.2f}%")
    print(f"{'Short':<30s}: {metrics['short']:.2f}%")
    print(f"{'Medium':<30s}: {metrics['medium']:.2f}%")
    print(f"{'Long':<30s}: {metrics['long']:.2f}%")
    print("\nBy Domain:")
    for domain, acc in metrics["by_domain"].items():
        print(f"  {domain:<28s}: {acc:.1f}%")
    print(f"\nTotal Samples: {metrics['total_samples']}")
    print(f"Correct: {metrics['correct_samples']}")
    print("-" * 80)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--lib",
        type=str,
        choices=["memos-api", "memos-api-online"],
        default="memos-api",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="default",
        help="Version identifier for loading results",
    )
    args = parser.parse_args()

    main(args.lib, args.version)
