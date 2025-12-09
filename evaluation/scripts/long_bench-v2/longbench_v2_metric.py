import argparse
import json
import os


def calculate_accuracy(responses):
    """Calculate accuracy metrics for LongBench v2."""
    total = len(responses)
    if total == 0:
        return {}

    # Overall accuracy
    correct = sum(1 for r in responses if r.get("judge", False))
    overall_acc = round(100 * correct / total, 1)

    # By difficulty
    easy_items = [r for r in responses if r.get("difficulty") == "easy"]
    hard_items = [r for r in responses if r.get("difficulty") == "hard"]
    easy_acc = (
        round(100 * sum(1 for r in easy_items if r.get("judge", False)) / len(easy_items), 1)
        if easy_items
        else 0.0
    )
    hard_acc = (
        round(100 * sum(1 for r in hard_items if r.get("judge", False)) / len(hard_items), 1)
        if hard_items
        else 0.0
    )

    # By length
    short_items = [r for r in responses if r.get("length") == "short"]
    medium_items = [r for r in responses if r.get("length") == "medium"]
    long_items = [r for r in responses if r.get("length") == "long"]

    short_acc = (
        round(100 * sum(1 for r in short_items if r.get("judge", False)) / len(short_items), 1)
        if short_items
        else 0.0
    )
    medium_acc = (
        round(100 * sum(1 for r in medium_items if r.get("judge", False)) / len(medium_items), 1)
        if medium_items
        else 0.0
    )
    long_acc = (
        round(100 * sum(1 for r in long_items if r.get("judge", False)) / len(long_items), 1)
        if long_items
        else 0.0
    )

    # By domain
    domain_stats = {}
    for response in responses:
        domain = response.get("domain", "Unknown")
        if domain not in domain_stats:
            domain_stats[domain] = {"total": 0, "correct": 0}
        domain_stats[domain]["total"] += 1
        if response.get("judge", False):
            domain_stats[domain]["correct"] += 1

    domain_acc = {
        domain: round(100 * stats["correct"] / stats["total"], 1)
        for domain, stats in domain_stats.items()
    }

    return {
        "overall": overall_acc,
        "easy": easy_acc,
        "hard": hard_acc,
        "short": short_acc,
        "medium": medium_acc,
        "long": long_acc,
        "by_domain": domain_acc,
        "total_samples": total,
        "correct_samples": correct,
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

    # Only keep entries with non-empty context (search_context) to align with response generation
    filtered = [r for r in responses if str(r.get("search_context", "")).strip() != ""]

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
    print(f"{'Overall Accuracy':<30s}: {metrics['overall']:.1f}%")
    print(f"{'Easy':<30s}: {metrics['easy']:.1f}%")
    print(f"{'Hard':<30s}: {metrics['hard']:.1f}%")
    print(f"{'Short':<30s}: {metrics['short']:.1f}%")
    print(f"{'Medium':<30s}: {metrics['medium']:.1f}%")
    print(f"{'Long':<30s}: {metrics['long']:.1f}%")
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
