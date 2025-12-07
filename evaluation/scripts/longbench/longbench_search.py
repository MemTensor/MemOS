import argparse
import json
import os
import sys

from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import time

from dotenv import load_dotenv
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


# All LongBench datasets
LONGBENCH_DATASETS = [
    "narrativeqa",
    "qasper",
    "multifieldqa_en",
    "multifieldqa_zh",
    "hotpotqa",
    "2wikimqa",
    "musique",
    "dureader",
    "gov_report",
    "qmsum",
    "multi_news",
    "vcsum",
    "trec",
    "triviaqa",
    "samsum",
    "lsht",
    "passage_count",
    "passage_retrieval_en",
    "passage_retrieval_zh",
    "lcc",
    "repobench-p",
]


def memos_api_search(client, query, user_id, top_k, frame):
    """Search using memos API."""
    start = time()
    search_results = client.search(query=query, user_id=user_id, top_k=top_k)

    # Format context from search results based on frame type
    context = ""
    if frame == "memos-api" or frame == "memos-api-online":
        if isinstance(search_results, dict) and "text_mem" in search_results:
            context = "\n".join([i["memory"] for i in search_results["text_mem"][0]["memories"]])
            if "pref_string" in search_results:
                context += f"\n{search_results.get('pref_string', '')}"
    elif frame == "mem0" or frame == "mem0_graph":
        if isinstance(search_results, dict) and "results" in search_results:
            context = "\n".join(
                [
                    f"{m.get('created_at', '')}: {m.get('memory', '')}"
                    for m in search_results["results"]
                ]
            )
    elif frame == "memobase":
        context = search_results if isinstance(search_results, str) else ""
    elif frame == "memu":
        context = "\n".join(search_results) if isinstance(search_results, list) else ""
    elif frame == "supermemory":
        context = search_results if isinstance(search_results, str) else ""

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def process_sample(client, sample, dataset_name, sample_idx, frame, version, top_k):
    """Process a single sample: search for relevant memories."""
    user_id = f"longbench_{dataset_name}_{sample_idx}_{version}"
    query = sample.get("input", "")

    if not query:
        return None

    context, duration_ms = memos_api_search(client, query, user_id, top_k, frame)

    return {
        "dataset": dataset_name,
        "sample_idx": sample_idx,
        "input": query,
        "context": context,
        "search_duration_ms": duration_ms,
        "answers": sample.get("answers", []),
        "all_classes": sample.get("all_classes"),
        "length": sample.get("length", 0),
    }


def load_dataset_from_local(dataset_name, use_e=False):
    """Load LongBench dataset from local JSONL file."""
    # Determine data directory
    data_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "data",
        "long_bench_v2",
    )

    # Determine filename
    filename = f"{dataset_name}_e.jsonl" if use_e else f"{dataset_name}.jsonl"

    filepath = os.path.join(data_dir, filename)

    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Dataset file not found: {filepath}")

    # Load JSONL file
    samples = []
    with open(filepath, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                samples.append(json.loads(line))

    return samples


def process_dataset(
    dataset_name, frame, version, top_k=20, num_workers=10, max_samples=None, use_e=False
):
    """Process a single dataset: search for all samples."""
    print(f"\n{'=' * 80}")
    print(f"🔍 [SEARCHING DATASET: {dataset_name.upper()}]".center(80))
    print(f"{'=' * 80}\n")

    # Load dataset from local files
    try:
        dataset = load_dataset_from_local(dataset_name, use_e)
        print(f"Loaded {len(dataset)} samples from {dataset_name}")
    except FileNotFoundError as e:
        print(f"❌ Error loading dataset {dataset_name}: {e}")
        return []
    except Exception as e:
        print(f"❌ Error loading dataset {dataset_name}: {e}")
        return []

    # Limit samples if specified
    if max_samples:
        dataset = dataset[:max_samples]
        print(f"Limited to {len(dataset)} samples")

    # Initialize client
    client = None
    if frame == "mem0" or frame == "mem0_graph":
        from utils.client import Mem0Client

        client = Mem0Client(enable_graph="graph" in frame)
    elif frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()
    elif frame == "memobase":
        from utils.client import MemobaseClient

        client = MemobaseClient()
    elif frame == "memu":
        from utils.client import MemuClient

        client = MemuClient()
    elif frame == "supermemory":
        from utils.client import SupermemoryClient

        client = SupermemoryClient()
    else:
        print(f"❌ Unsupported frame: {frame}")
        return []

    # Process samples
    search_results = []
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = []
        for idx, sample in enumerate(dataset):
            future = executor.submit(
                process_sample, client, sample, dataset_name, idx, frame, version, top_k
            )
            futures.append(future)

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc=f"Searching {dataset_name}",
        ):
            result = future.result()
            if result:
                search_results.append(result)

    print(f"\n✅ Completed searching {dataset_name}: {len(search_results)} samples")
    return search_results


def main(
    frame, version="default", num_workers=10, top_k=20, datasets=None, max_samples=None, use_e=False
):
    """Main search function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH SEARCH - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Determine which datasets to process
    dataset_list = [d.strip() for d in datasets.split(",")] if datasets else LONGBENCH_DATASETS

    # Filter valid datasets
    valid_datasets = [d for d in dataset_list if d in LONGBENCH_DATASETS]
    if not valid_datasets:
        print("❌ No valid datasets specified")
        return

    print(f"Processing {len(valid_datasets)} datasets: {valid_datasets}\n")

    # Create output directory
    os.makedirs(f"results/longbench/{frame}-{version}/", exist_ok=True)

    # Process each dataset
    all_results = defaultdict(list)
    for dataset_name in valid_datasets:
        results = process_dataset(
            dataset_name, frame, version, top_k, num_workers, max_samples, use_e
        )
        all_results[dataset_name] = results

    # Save results
    output_path = f"results/longbench/{frame}-{version}/{frame}_longbench_search_results.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(dict(all_results), f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 80}")
    print(f"✅ SEARCH COMPLETE: Results saved to {output_path}".center(80))
    print(f"{'=' * 80}\n")


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
        help="Version identifier for saving results",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=10,
        help="Number of parallel workers",
    )
    parser.add_argument(
        "--top_k",
        type=int,
        default=20,
        help="Number of results to retrieve in search queries",
    )
    parser.add_argument(
        "--datasets",
        type=str,
        default=None,
        help="Comma-separated list of datasets to process (default: all)",
    )
    parser.add_argument(
        "--max_samples",
        type=int,
        default=None,
        help="Maximum number of samples per dataset (default: all)",
    )
    parser.add_argument(
        "--e",
        action="store_true",
        help="Use LongBench-E variant (uniform length distribution)",
    )
    args = parser.parse_args()

    main(
        args.lib,
        args.version,
        args.workers,
        args.top_k,
        args.datasets,
        args.max_samples,
        args.e,
    )
