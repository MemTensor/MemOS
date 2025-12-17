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

    # Extract raw memory texts in the same way as longbench_stx.memos_search
    memories_texts: list[str] = []
    if (
        (frame == "memos-api" or frame == "memos-api-online")
        and isinstance(search_results, dict)
        and "text_mem" in search_results
    ):
        text_mem = search_results.get("text_mem") or []
        if text_mem and text_mem[0].get("memories"):
            memories = text_mem[0]["memories"]
            for m in memories:
                if not isinstance(m, dict):
                    continue
                # tags may be at top-level or inside metadata
                tags = m.get("tags") or m.get("metadata", {}).get("tags") or []
                # Skip fast-mode memories
                if any(isinstance(t, str) and "mode:fast" in t for t in tags):
                    continue
                mem_text = m.get("memory", "")
                if str(mem_text).strip():
                    memories_texts.append(mem_text)

    duration_ms = (time() - start) * 1000
    return memories_texts, duration_ms, search_results


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

    memories_used, duration_ms, search_results = memos_api_search(
        client, query, user_id, top_k, frame
    )

    if not (isinstance(memories_used, list) and any(str(m).strip() for m in memories_used)):
        return None

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
        # Raw memories used for RAG answering (aligned with longbench_stx)
        "memories_used": memories_used,
        # Preserve full search results payload for debugging / analysis
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
