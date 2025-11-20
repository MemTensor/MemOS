import argparse
import csv
import json
import os
import sys
import time

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from tqdm import tqdm


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def ingest_session(session, user_id, session_id, frame, client):
    messages = []
    if frame == "zep":
        pass
    elif "mem0" in frame:
        for idx, msg in enumerate(session):
            messages.append({"role": msg["role"], "content": msg["content"][:8000]})
            print(
                f"[{frame}] 📝 Session [{session_id}: [{idx + 1}/{len(session)}] Ingesting message: {msg['role']} - {msg['content'][:50]}..."
            )
        timestamp_add = int(time.time() * 100)
        client.add(messages=messages, user_id=user_id, timestamp=timestamp_add, batch_size=10)
        print(f"[{frame}] ✅ Session [{session_id}]: Ingested {len(messages)} messages")
    elif frame == "memos-api":
        client.add(messages=session, user_id=user_id, conv_id=session_id, batch_size=10)
        print(f"[{frame}] ✅ Session [{session_id}]: Ingested {len(session)} messages")
    elif frame == "memobase":
        for _idx, msg in enumerate(session):
            if msg["role"] != "system":
                messages.append(
                    {
                        "role": msg["role"],
                        "content": msg["content"],
                        "created_at": datetime.now().isoformat(),
                    }
                )
        client.add(messages, user_id, batch_size=10)
        print(f"[{frame}] ✅ Session [{session_id}]: Ingested {len(messages)} messages")
    elif frame == "supermemory":
        for _idx, msg in enumerate(session):
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "chat_time": datetime.now().astimezone().isoformat(),
                }
            )
        client.add(messages, user_id)
    elif frame == "memu":
        for _idx, msg in enumerate(session):
            messages.append({"role": msg["role"], "content": msg["content"]})
        client.add(messages, user_id, datetime.now().astimezone().isoformat())
    elif frame == "memos-api-online":
        client.add(messages, user_id, session_id, batch_size=10)


def build_jsonl_index(jsonl_path):
    """
    Scan the JSONL file once to build a mapping: {key: file_offset}.
    Assumes each line is a JSON object with a single key-value pair.
    """
    index = {}
    with open(jsonl_path, encoding="utf-8") as f:
        while True:
            offset = f.tell()
            line = f.readline()
            if not line:
                break
            key = next(iter(json.loads(line).keys()))
            index[key] = offset
    return index


def load_context_by_id(jsonl_path, offset):
    with open(jsonl_path, encoding="utf-8") as f:
        f.seek(offset)
        item = json.loads(f.readline())
        return next(iter(item.values()))


def load_rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        for _, row in enumerate(reader, start=1):
            row_data = {}
            for column_name, value in row.items():
                row_data[column_name] = value
            yield row_data


def load_rows_with_context(csv_path, jsonl_path):
    jsonl_index = build_jsonl_index(jsonl_path)

    with open(csv_path, newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        prev_sid = None
        prev_context = None
        for _, row in enumerate(reader, start=1):
            row_data = {}
            for column_name, value in row.items():
                row_data[column_name] = value

            sid = row_data["shared_context_id"]
            if sid != prev_sid:
                current_context = load_context_by_id(jsonl_path, jsonl_index[sid])
                prev_sid = sid
                prev_context = current_context
            else:
                current_context = prev_context
            yield row_data, current_context


def count_csv_rows(csv_path):
    with open(csv_path, newline="", encoding="utf-8") as f:
        return sum(1 for _ in f) - 1


def ingest_conv(row_data, context, version, conv_idx, frame, success_records, f):
    if str(conv_idx) in success_records:
        print(f"✅ Conversation {conv_idx} already ingested, skipping...")
        return conv_idx

    end_index_in_shared_context = row_data["end_index_in_shared_context"]
    context = context[: int(end_index_in_shared_context)]
    user_id = f"pm_exper_user_{conv_idx}_{version}"
    print(f"👤 User ID: {user_id}")
    print("\n" + "=" * 80)
    print(f"🔄 INGESTING CONVERSATION {conv_idx}".center(80))
    print("=" * 80)

    if frame == "zep":
        from utils.client import ZepClient

        client = ZepClient()
        print("🔌 Using Zep client for ingestion...")
        client.user.delete(user_id)
        print(f"🗑️  Deleted existing user {user_id} from Zep memory...")
        client.user.add(user_id=user_id)
        print(f"➕ Added user {user_id} to Zep memory...")
    elif frame == "mem0" or frame == "mem0_graph":
        from utils.client import Mem0Client

        client = Mem0Client(enable_graph="graph" in frame)
        print("🔌 Using Mem0 client for ingestion...")
        client.client.delete_all(user_id=user_id)
        print(f"🗑️  Deleted existing memories for user {user_id}...")
    elif frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    elif frame == "memobase":
        from utils.client import MemobaseClient

        client = MemobaseClient()
    elif frame == "supermemory":
        from utils.client import SupermemoryClient

        client = SupermemoryClient()
    elif frame == "memu":
        from utils.client import MemuClient

        client = MemuClient()
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()

    try:
        ingest_session(
            session=context, user_id=user_id, session_id=conv_idx, frame=frame, client=client
        )
        print(f"✅ Ingestion of conversation {conv_idx} completed")
        print("=" * 80)

        f.write(f"{conv_idx}\n")
        f.flush()
        return conv_idx
    except Exception as e:
        print(f"❌ Error ingesting conversation {conv_idx}: {e}")
        raise


def main(frame, version, num_workers=2, clear=False):
    os.makedirs(f"results/pm/{frame}-{version}/", exist_ok=True)
    record_file = f"results/pm/{frame}-{version}/success_records.txt"

    if clear and os.path.exists(record_file):
        os.remove(record_file)
        print("🧹 Cleared progress records")

    print("\n" + "=" * 80)
    print(f"🚀 PERSONAMEM INGESTION - {frame.upper()} v{version}".center(80))
    print("=" * 80)

    question_csv_path = "data/personamem/questions_32k.csv"
    context_jsonl_path = "data/personamem/shared_contexts_32k.jsonl"
    total_rows = count_csv_rows(question_csv_path)

    print(f"📚 Loaded PersonaMem dataset from {question_csv_path} and {context_jsonl_path}")
    print("-" * 80)

    success_records = set()
    if os.path.exists(record_file):
        with open(record_file) as f:
            success_records = {line.strip() for line in f}
        print(
            f"📊 Found {len(success_records)} completed conversations, {total_rows - len(success_records)} remaining"
        )

    start_time = datetime.now()
    all_data = list(load_rows_with_context(question_csv_path, context_jsonl_path))

    pending_data = [
        (idx, row_data, context)
        for idx, (row_data, context) in enumerate(all_data)
        if str(idx) not in success_records
    ]

    if not pending_data:
        print("✅ All conversations have been processed!")
        return

    print(f"🔄 Processing {len(pending_data)} conversations...")

    with ThreadPoolExecutor(max_workers=num_workers) as executor, open(record_file, "a") as f:
        futures = []
        for idx, row_data, context in pending_data:
            future = executor.submit(
                ingest_conv,
                row_data=row_data,
                context=context,
                version=version,
                conv_idx=idx,
                frame=frame,
                success_records=success_records,
                f=f,
            )
            futures.append(future)

        completed_count = 0
        for future in tqdm(
            as_completed(futures), total=len(futures), desc="Processing conversations"
        ):
            try:
                future.result()
                completed_count += 1
            except Exception as exc:
                print(f"\n❌ Conversation generated an exception: {exc}")

    end_time = datetime.now()
    elapsed_time = end_time - start_time
    elapsed_time_str = str(elapsed_time).split(".")[0]

    print("\n" + "=" * 80)
    print("✅ INGESTION COMPLETE".center(80))
    print("=" * 80)
    print(f"⏱️  Total time taken to ingest {total_rows} rows: {elapsed_time_str}")
    print(f"🔄 Framework: {frame} | Version: {version} | Workers: {num_workers}")
    print(f"📈 Processed: {len(success_records) + completed_count}/{total_rows} conversations")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PersonaMem Ingestion Script")
    parser.add_argument(
        "--lib",
        type=str,
        choices=[
            "memos-api-online",
            "mem0",
            "mem0_graph",
            "memos-api",
            "memobase",
            "memu",
            "supermemory",
            "zep",
        ],
        default="memos-api",
    )
    parser.add_argument(
        "--version", type=str, default="default", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--workers", type=int, default=3, help="Number of parallel workers for processing users."
    )
    parser.add_argument("--clear", action="store_true", help="Clear progress and start fresh")
    args = parser.parse_args()

    main(frame=args.lib, version=args.version, num_workers=args.workers, clear=args.clear)
