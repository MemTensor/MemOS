import argparse
import json
import os
import sys

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


def memos_api_search(client, query, user_id, top_k, frame):
    """Search using memos API."""
    start = time()
    search_results = client.search(query=query, user_id=user_id, top_k=top_k)

    # Format context from search results based on frame type
    context = ""
    if (
        (frame == "memos-api" or frame == "memos-api-online")
        and isinstance(search_results, dict)
        and "text_mem" in search_results
    ):
        context = "\n".join([i["memory"] for i in search_results["text_mem"][0]["memories"]])
        if "pref_string" in search_results:
            context += f"\n{search_results.get('pref_string', '')}"

    duration_ms = (time() - start) * 1000
    return context, duration_ms


def process_sample(client, sample, sample_idx, frame, version, top_k):
    """Process a single sample: search for relevant memories."""
    user_id = f"longbench_v2_{sample_idx}_{version}"
    query = sample.get("question", "")

    if not query:
        return None

    context, duration_ms = memos_api_search(client, query, user_id, top_k, frame)

    return {
        "sample_idx": sample_idx,
        "_id": sample.get("_id"),
        "domain": sample.get("domain"),
        "sub_domain": sample.get("sub_domain"),
        "difficulty": sample.get("difficulty"),
        "length": sample.get("length"),
        "question": query,
        "choice_A": sample.get("choice_A"),
        "choice_B": sample.get("choice_B"),
        "choice_C": sample.get("choice_C"),
        "choice_D": sample.get("choice_D"),
        "answer": sample.get("answer"),
        "context": context,
        "search_duration_ms": duration_ms,
    }


def load_dataset_from_local():
    """Load LongBench v2 dataset from local JSON file."""
    data_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "data",
        "long_bench_v2",
    )

    filepath = os.path.join(data_dir, "data.json")

    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Dataset file not found: {filepath}")

    # Load JSON file
    with open(filepath, encoding="utf-8") as f:
        samples = json.load(f)

    return samples


def main(frame, version="default", num_workers=10, top_k=20, max_samples=None):
    """Main search function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH V2 SEARCH - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Load dataset from local file
    try:
        dataset = load_dataset_from_local()
        print(f"Loaded {len(dataset)} samples from LongBench v2")
    except FileNotFoundError as e:
        print(f"❌ Error loading dataset: {e}")
        return
    except Exception as e:
        print(f"❌ Error loading dataset: {e}")
        return

    # Limit samples if specified
    if max_samples:
        dataset = dataset[:max_samples]
        print(f"Limited to {len(dataset)} samples")

    # Initialize client
    client = None
    if frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()
    else:
        print(f"❌ Unsupported frame: {frame}")
        return

    # Process samples
    search_results = []
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = []
        for idx, sample in enumerate(dataset):
            future = executor.submit(process_sample, client, sample, idx, frame, version, top_k)
            futures.append(future)

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc="Searching LongBench v2",
        ):
            result = future.result()
            if result:
                search_results.append(result)

    # Save results
    os.makedirs(f"results/long_bench-v2/{frame}-{version}/", exist_ok=True)
    output_path = (
        f"results/long_bench-v2/{frame}-{version}/{frame}_longbench_v2_search_results.json"
    )
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(search_results, f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 80}")
    print(f"✅ SEARCH COMPLETE: Results saved to {output_path}".center(80))
    print(f"{'=' * 80}\n")


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
        "--max_samples",
        type=int,
        default=None,
        help="Maximum number of samples to process (default: all)",
    )
    args = parser.parse_args()

    main(args.lib, args.version, args.workers, args.top_k, args.max_samples)
