import argparse
import json
import os
import sys

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

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


def ingest_sample(client, sample, dataset_name, sample_idx, frame, version):
    """Ingest a single LongBench sample as memories."""
    user_id = f"longbench_{dataset_name}_{sample_idx}_{version}"
    conv_id = f"longbench_{dataset_name}_{sample_idx}_{version}"

    # Get context and convert to messages
    context = sample.get("context", "")
    # not used now: input_text = sample.get("input", "")

    # For memos, we ingest the context as document content
    # Split context into chunks if it's too long (optional, memos handles this internally)
    # For now, we'll ingest the full context as a single message
    messages = [
        {
            "role": "assistant",
            "content": context,
            "chat_time": datetime.now(timezone.utc).isoformat(),
        }
    ]

    if "memos-api" in frame:
        try:
            client.add(messages=messages, user_id=user_id, conv_id=conv_id, batch_size=1)
            print(f"✅ [{frame}] Ingested sample {sample_idx} from {dataset_name}")
            return True
        except Exception as e:
            print(f"❌ [{frame}] Error ingesting sample {sample_idx} from {dataset_name}: {e}")
            return False
    elif "mem0" in frame:
        timestamp = int(datetime.now(timezone.utc).timestamp())
        try:
            client.add(messages=messages, user_id=user_id, timestamp=timestamp, batch_size=1)
            print(f"✅ [{frame}] Ingested sample {sample_idx} from {dataset_name}")
            return True
        except Exception as e:
            print(f"❌ [{frame}] Error ingesting sample {sample_idx} from {dataset_name}: {e}")
            return False
    elif frame == "memobase":
        for m in messages:
            m["created_at"] = messages[0]["chat_time"]
        try:
            client.add(messages=messages, user_id=user_id, batch_size=1)
            print(f"✅ [{frame}] Ingested sample {sample_idx} from {dataset_name}")
            return True
        except Exception as e:
            print(f"❌ [{frame}] Error ingesting sample {sample_idx} from {dataset_name}: {e}")
            return False
    elif frame == "memu":
        try:
            client.add(messages=messages, user_id=user_id, iso_date=messages[0]["chat_time"])
            print(f"✅ [{frame}] Ingested sample {sample_idx} from {dataset_name}")
            return True
        except Exception as e:
            print(f"❌ [{frame}] Error ingesting sample {sample_idx} from {dataset_name}: {e}")
            return False
    elif frame == "supermemory":
        try:
            client.add(messages=messages, user_id=user_id)
            print(f"✅ [{frame}] Ingested sample {sample_idx} from {dataset_name}")
            return True
        except Exception as e:
            print(f"❌ [{frame}] Error ingesting sample {sample_idx} from {dataset_name}: {e}")
            return False

    return False


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


def ingest_dataset(dataset_name, frame, version, num_workers=10, max_samples=None, use_e=False):
    """Ingest a single LongBench dataset."""
    print(f"\n{'=' * 80}")
    print(f"🔄 [INGESTING DATASET: {dataset_name.upper()}]".center(80))
    print(f"{'=' * 80}\n")

    # Load dataset from local files
    try:
        dataset = load_dataset_from_local(dataset_name, use_e)
        print(f"Loaded {len(dataset)} samples from {dataset_name}")
    except FileNotFoundError as e:
        print(f"❌ Error loading dataset {dataset_name}: {e}")
        return
    except Exception as e:
        print(f"❌ Error loading dataset {dataset_name}: {e}")
        return

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
        return

    # Ingest samples
    success_count = 0
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = []
        for idx, sample in enumerate(dataset):
            future = executor.submit(
                ingest_sample, client, sample, dataset_name, idx, frame, version
            )
            futures.append(future)

        for future in tqdm(
            as_completed(futures),
            total=len(futures),
            desc=f"Ingesting {dataset_name}",
        ):
            try:
                if future.result():
                    success_count += 1
            except Exception as e:
                print(f"Error processing sample: {e}")

    print(f"\n✅ Completed ingesting {dataset_name}: {success_count}/{len(dataset)} samples")
    return success_count


def main(frame, version="default", num_workers=10, datasets=None, max_samples=None, use_e=False):
    """Main ingestion function."""
    load_dotenv()

    print("\n" + "=" * 80)
    print(f"🚀 LONGBENCH INGESTION - {frame.upper()} v{version}".center(80))
    print("=" * 80 + "\n")

    # Determine which datasets to process
    dataset_list = [d.strip() for d in datasets.split(",")] if datasets else LONGBENCH_DATASETS

    # Filter valid datasets
    valid_datasets = [d for d in dataset_list if d in LONGBENCH_DATASETS]
    if not valid_datasets:
        print("❌ No valid datasets specified")
        return

    print(f"Processing {len(valid_datasets)} datasets: {valid_datasets}\n")

    # Ingest each dataset
    total_success = 0
    total_samples = 0
    for dataset_name in valid_datasets:
        success = ingest_dataset(dataset_name, frame, version, num_workers, max_samples, use_e)
        if success is not None:
            total_success += success
            total_samples += max_samples if max_samples else 200  # Approximate

    print(f"\n{'=' * 80}")
    print(f"✅ INGESTION COMPLETE: {total_success} samples ingested".center(80))
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
        args.datasets,
        args.max_samples,
        args.e,
    )
