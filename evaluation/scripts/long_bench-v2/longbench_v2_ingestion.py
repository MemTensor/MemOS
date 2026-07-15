import argparse
import json
import os
import sys
import threading

from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
from tqdm import tqdm


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


def ingest_sample(
    client, sample, sample_idx, frame, version, success_records, record_file, file_lock
):
    """Ingest a single LongBench v2 sample as memories."""
    # Skip if already processed
    if str(sample_idx) in success_records:
        return True

    user_id = f"longbench_v2_{sample_idx}_{version}"
    conv_id = f"longbench_v2_{sample_idx}_{version}"

    # Get context and convert to messages
    context = sample.get("context", "")

    # For memos, we ingest the context as a raw document content
    messages = [
        {
            "type": "file",
            "file": {
                "file_data": context,
                "file_id": str(sample_idx),
            },
        }
    ]

    if "memos-api" in frame:
        try:
            client.add(messages=messages, user_id=user_id, conv_id=conv_id, batch_size=1)
            print(f"✅ [{frame}] Ingested sample {sample_idx}")
            # Record successful ingestion (thread-safe)
            with file_lock, open(record_file, "a") as f:
                f.write(f"{sample_idx}\n")
                f.flush()
            return True
        except Exception as e:
            print(f"❌ [{frame}] Error ingesting sample {sample_idx}: {e}")
            return False

    return False


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


def main(frame, version="default", num_workers=10, max_samples=None):
    """Main ingestion function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH V2 INGESTION - {frame.upper()} v{version}".center(80))
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
    record_file = os.path.join(checkpoint_dir, "success_records.txt")

    # Load existing success records for resume
    success_records = set()
    if os.path.exists(record_file):
        with open(record_file) as f:
            for line in f:
                line = line.strip()
                if line:
                    success_records.add(line)
        print(f"📋 Found {len(success_records)} already processed samples (resume mode)")
    else:
        print("📋 Starting fresh ingestion (no checkpoint found)")

    # Initialize client
    client = None
    if frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    else:
        print(f"❌ Unsupported frame: {frame}")
        return

    # Ingest samples
    success_count = len(success_records)  # Start with already processed count
    file_lock = threading.Lock()  # Lock for thread-safe file writing
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = []
        for idx, sample in enumerate(dataset):
            future = executor.submit(
                ingest_sample,
                client,
                sample,
                idx,
                frame,
                version,
                success_records,
                record_file,
                file_lock,
            )
            futures.append(future)

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc="Ingesting LongBench v2",
        ):
            try:
                if future.result():
                    success_count += 1
            except Exception as e:
                print(f"Error processing sample: {e}")

    print(f"\n{'=' * 80}")
    print(f"✅ INGESTION COMPLETE: {success_count}/{len(dataset)} samples ingested".center(80))
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
        default=2,
        help="Number of parallel workers",
    )
    parser.add_argument(
        "--max_samples",
        type=int,
        default=None,
        help="Maximum number of samples to process (default: all)",
    )
    args = parser.parse_args()

    main(args.lib, args.version, args.workers, args.max_samples)
