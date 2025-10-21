import argparse
import os
import sys
import csv
import json

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

from tqdm import tqdm
from utils.client import mem0_client,zep_client,memos_api_client
from zep_cloud.types import Message


def ingest_session(session, user_id, session_id, frame, client):
    messages = []
    if frame == "zep":
        pass
        for idx, msg in enumerate(session):
            print(
                f"[{frame}] 💬 Session [{session_id}: [{idx + 1}/{len(session)}] Ingesting message: {msg['role']} - {msg['content'][:50]}...")
            client.memory.add(messages=[Message(role=msg["role"], role_type=msg["role"], content=msg["content"], )], )
    elif frame == "mem0-local" or frame == "mem0-api":
        for idx, msg in enumerate(session):
            messages.append({"role": msg["role"], "content": msg["content"]})
            print(
                f"[{frame}] 📝 Session [{session_id}: [{idx + 1}/{len(session)}] Ingesting message: {msg['role']} - {msg['content'][:50]}...")
        if frame == "mem0-local":
            client.add(messages=messages, user_id=user_id)
        elif frame == "mem0-api":
            client.add(messages=messages,
                       user_id=user_id,
                       session_id=session_id,
                       version="v2", )
        print(f"[{frame}] ✅ Session [{session_id}]: Ingested {len(messages)} messages")
    elif frame == "memos-local" or frame == "memos-api":
        if os.getenv("PRE_SPLIT_CHUNK")=="true":
            for i in range(0, len(session), 10):
                messages = session[i: i + 10]
                client.add(messages=messages, user_id=user_id, conv_id=session_id)
                print(f"[{frame}] ✅ Session [{session_id}]: Ingested {len(messages)} messages")
        else:
            client.add(messages=session, user_id=user_id, conv_id=session_id)
            print(f"[{frame}] ✅ Session [{session_id}]: Ingested {len(session)} messages")


def build_jsonl_index(jsonl_path):
    """
    Scan the JSONL file once to build a mapping: {key: file_offset}.
    Assumes each line is a JSON object with a single key-value pair.
    """
    index = {}
    with open(jsonl_path, 'r', encoding='utf-8') as f:
        while True:
            offset = f.tell()
            line = f.readline()
            if not line:
                break
            key = next(iter(json.loads(line).keys()))
            index[key] = offset
    return index


def load_context_by_id(jsonl_path, offset):
    with open(jsonl_path, 'r', encoding='utf-8') as f:
        f.seek(offset)
        item = json.loads(f.readline())
        return next(iter(item.values()))


def load_rows(csv_path):
    with open(csv_path, mode='r', newline='', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        for _, row in enumerate(reader, start=1):
            row_data = {}
            for column_name, value in row.items():
                row_data[column_name] = value
            yield row_data


def load_rows_with_context(csv_path, jsonl_path):
    jsonl_index = build_jsonl_index(jsonl_path)

    with open(csv_path, mode='r', newline='', encoding='utf-8') as csvfile:
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
    with open(csv_path, mode='r', newline='', encoding='utf-8') as f:
        return sum(1 for _ in f) - 1


def ingest_conv(row_data, context, version, conv_idx, frame):
    end_index_in_shared_context = row_data["end_index_in_shared_context"]
    context = context[:int(end_index_in_shared_context)]
    user_id = f"pm_exper_user_{conv_idx}_{version}"
    print(f"👤 User ID: {user_id}")
    print("\n" + "=" * 80)
    print(f"🔄 INGESTING CONVERSATION {conv_idx}".center(80))
    print("=" * 80)

    if frame == "zep":
        client = zep_client()
        print("🔌 Using Zep client for ingestion...")
        client.user.delete(user_id)
        print(f"🗑️  Deleted existing user {user_id} from Zep memory...")
        client.user.add(user_id=user_id)
        print(f"➕ Added user {user_id} to Zep memory...")
    elif frame == "mem0-local":
        client = mem0_client(mode="local")
        print("🔌 Using Mem0 Local client for ingestion...")
        client.delete_all(user_id=user_id)
        print(f"🗑️  Deleted existing memories for user {user_id}...")
    elif frame == "mem0-api":
        client = mem0_client(mode="api")
        print("🔌 Using Mem0 API client for ingestion...")
        client.delete_all(user_id=user_id)
        print(f"🗑️  Deleted existing memories for user {user_id}...")
    elif frame == "memos-local":
        client = memos_client(
            mode="local",
            db_name=f"pm_{frame}-{version}",
            user_id=user_id,
            top_k=20,
            mem_cube_path=f"results/pm/{frame}-{version}/storages/{user_id}",
            mem_cube_config_path="configs/mu_mem_cube_config.json",
            mem_os_config_path="configs/mos_memos_config.json",
            addorsearch="add",
        )
        print("🔌 Using Memos Local client for ingestion...")
    elif frame == "memos-api":
        client = memos_api_client()

    ingest_session(session=context, user_id=user_id, session_id=conv_idx, frame=frame, client=client)
    print(f"✅ Ingestion of conversation {conv_idx} completed")
    print("=" * 80)


def main(frame, version, num_workers=2):
    print("\n" + "=" * 80)
    print(f"🚀 PERSONAMEM INGESTION - {frame.upper()} v{version}".center(80))
    print("=" * 80)

    question_csv_path = "data/personamem/questions_32k.csv"
    context_jsonl_path = "data/personamem/shared_contexts_32k.jsonl"
    total_rows = count_csv_rows(question_csv_path)

    print(f"📚 Loaded PersonaMem dataset from {question_csv_path} and {context_jsonl_path}")
    print("-" * 80)

    start_time = datetime.now()

    all_data = list(load_rows_with_context(question_csv_path, context_jsonl_path))

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        future_to_idx = {
            executor.submit(ingest_conv, row_data=row_data, context=context, version=version, conv_idx=idx,
                            frame=frame, ): idx
            for idx, (row_data, context) in enumerate(all_data)}

        for future in tqdm(as_completed(future_to_idx), total=len(future_to_idx), desc="Processing conversations"):
            idx = future_to_idx[future]
            try:
                future.result()
            except Exception as exc:
                print(f'\n❌ Conversation {idx} generated an exception: {exc}')

    end_time = datetime.now()
    elapsed_time = end_time - start_time
    elapsed_time_str = str(elapsed_time).split(".")[0]

    print("\n" + "=" * 80)
    print("✅ INGESTION COMPLETE".center(80))
    print("=" * 80)
    print(f"⏱️  Total time taken to ingest {total_rows} rows: {elapsed_time_str}")
    print(f"🔄 Framework: {frame} | Version: {version} | Workers: {num_workers}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="PersonaMem Ingestion Script")
    parser.add_argument("--lib", type=str, choices=["mem0-local", "mem0-api", "memos-local", "memos-api", "zep"],
                        default='memos-api')
    parser.add_argument("--version", type=str, default="0925-1", help="Version of the evaluation framework.")
    parser.add_argument("--workers", type=int, default=3, help="Number of parallel workers for processing users.")
    args = parser.parse_args()

    main(frame=args.lib, version=args.version, num_workers=args.workers)
