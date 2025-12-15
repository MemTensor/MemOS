import argparse
import json
import os
import sys
import threading

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

    def _reorder_memories_by_sources(sr: dict) -> list:
        """
        Reorder text_mem[0].memories using sources' chunk_index (ascending).
        Falls back to original order if no chunk_index is found.
        """
        if not isinstance(sr, dict):
            return []
        text_mem = sr.get("text_mem") or []
        if not text_mem or not text_mem[0].get("memories"):
            return []
        memories = list(text_mem[0]["memories"])

        def _first_source(mem: dict):
            if not isinstance(mem, dict):
                return None
            # Prefer top-level sources, else metadata.sources
            return (mem.get("sources") or mem.get("metadata", {}).get("sources") or []) or None

        def _chunk_index(mem: dict):
            srcs = _first_source(mem)
            if not srcs or not isinstance(srcs, list):
                return None
            for s in srcs:
                if isinstance(s, dict) and s.get("chunk_index") is not None:
                    return s.get("chunk_index")
            return None

        # Collect keys
        keyed = []
        for i, mem in enumerate(memories):
            ci = _chunk_index(mem)
            keyed.append((ci, i, mem))  # keep original order as tie-breaker

        # If no chunk_index present at all, return original
        if all(ci is None for ci, _, _ in keyed):
            return memories

        keyed.sort(key=lambda x: (float("inf") if x[0] is None else x[0], x[1]))
        return [k[2] for k in keyed]

    # Format context from search results based on frame type for backward compatibility
    context = ""
    if (
        (frame == "memos-api" or frame == "memos-api-online")
        and isinstance(search_results, dict)
        and "text_mem" in search_results
    ):
        ordered_memories = _reorder_memories_by_sources(search_results)
        if not ordered_memories and search_results["text_mem"][0].get("memories"):
            ordered_memories = search_results["text_mem"][0]["memories"]

        context = "\n".join([i.get("memory", "") for i in ordered_memories])
        if "pref_string" in search_results:
            context += f"\n{search_results.get('pref_string', '')}"

    duration_ms = (time() - start) * 1000
    return context, duration_ms, search_results


def process_sample(
    client, sample, sample_idx, frame, version, top_k, success_records, record_file, file_lock
):
    """Process a single sample: search for relevant memories."""
    # Skip if already processed
    if str(sample_idx) in success_records:
        return None

    user_id = f"longbench_v2_{sample_idx}_{version}"
    query = sample.get("question", "")

    if not query:
        return None

    context, duration_ms, search_results = memos_api_search(client, query, user_id, top_k, frame)

    result = {
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
        # Preserve full search results instead of only the concatenated context
        "search_results": search_results,
        "search_duration_ms": duration_ms,
    }

    # Record successful processing (thread-safe)
    with file_lock, open(record_file, "a") as f:
        f.write(f"{sample_idx}\n")
        f.flush()

    return result


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

    # Initialize checkpoint file for resume functionality
    checkpoint_dir = os.path.join(
        ROOT_DIR, "evaluation", "results", "long_bench_v2", f"{frame}-{version}"
    )
    os.makedirs(checkpoint_dir, exist_ok=True)
    record_file = os.path.join(checkpoint_dir, "search_success_records.txt")
    output_path = os.path.join(checkpoint_dir, f"{frame}_longbench_v2_search_results.json")

    # Load existing results and success records for resume
    existing_results = {}
    success_records = set()
    if os.path.exists(output_path):
        with open(output_path, encoding="utf-8") as f:
            existing_results_list = json.load(f)
            for result in existing_results_list:
                sample_idx = result.get("sample_idx")
                if sample_idx is not None:
                    existing_results[sample_idx] = result
                    success_records.add(str(sample_idx))
        print(f"📋 Found {len(existing_results)} existing search results (resume mode)")
    else:
        print("📋 Starting fresh search (no checkpoint found)")

    # Load additional success records from checkpoint file
    if os.path.exists(record_file):
        with open(record_file) as f:
            for line in f:
                line = line.strip()
                if line and line not in success_records:
                    success_records.add(line)
        print(f"📋 Total {len(success_records)} samples already processed")

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
    new_results = []
    file_lock = threading.Lock()  # Lock for thread-safe file writing
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = []
        for idx, sample in enumerate(dataset):
            future = executor.submit(
                process_sample,
                client,
                sample,
                idx,
                frame,
                version,
                top_k,
                success_records,
                record_file,
                file_lock,
            )
            futures.append(future)

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc="Searching LongBench v2",
        ):
            result = future.result()
            if result:
                new_results.append(result)
                # Update existing results with new result
                sample_idx = result.get("sample_idx")
                if sample_idx is not None:
                    existing_results[sample_idx] = result

    # Merge and save all results
    search_results = list(existing_results.values())
    # Sort by sample_idx to maintain order
    search_results.sort(key=lambda x: x.get("sample_idx", 0))

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
        default=1,
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
