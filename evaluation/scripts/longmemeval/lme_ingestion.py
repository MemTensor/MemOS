import argparse
import os
import sys

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import pandas as pd

from tqdm import tqdm


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def ingest_session(session, date, user_id, session_id, frame, client):
    messages = []
    if "mem0" in frame:
        for _idx, msg in enumerate(session):
            messages.append({"role": msg["role"], "content": msg["content"][:8000]})
        client.add(messages, user_id, int(date.timestamp()), batch_size=2)
    elif frame == "memobase":
        for _idx, msg in enumerate(session):
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "created_at": date.isoformat(),
                }
            )
        client.add(messages, user_id, batch_size=2)
    elif "memos-api" in frame:
        for msg in session:
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "chat_time": date.isoformat(),
                }
            )
        if messages:
            client.add(messages=messages, user_id=user_id, conv_id=session_id, batch_size=2)
    elif frame == "memu":
        for _idx, msg in enumerate(session):
            messages.append({"role": msg["role"], "content": msg["content"][:8000]})
        client.add(messages, user_id, date.isoformat())
    elif frame == "supermemory":
        for _idx, msg in enumerate(session):
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "chat_time": date.isoformat(),
                }
            )
        client.add(messages, user_id)

    print(
        f"[{frame}] ✅ Session {session_id}: Ingested {len(messages)} messages at {date.isoformat()}"
    )


def ingest_conv(lme_df, version, conv_idx, frame, success_records, f):
    conversation = lme_df.iloc[conv_idx]
    sessions = conversation["haystack_sessions"]
    dates = conversation["haystack_dates"]

    user_id = f"lme_exper_user_{version}_{conv_idx}"

    print("\n" + "=" * 80)
    print(f"🔄 [INGESTING CONVERSATION {conv_idx}".center(80))
    print("=" * 80)

    if frame == "mem0" or frame == "mem0_graph":
        from utils.client import Mem0Client

        client = Mem0Client(enable_graph="graph" in frame)
        client.client.delete_all(user_id=user_id)
    elif frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()
    elif frame == "memobase":
        from utils.client import MemobaseClient

        client = MemobaseClient()
        client.delete_user(user_id)
    elif frame == "memu":
        from utils.client import MemuClient

        client = MemuClient()
    elif frame == "supermemory":
        from utils.client import SupermemoryClient

        client = SupermemoryClient()

    for idx, session in enumerate(sessions):
        if f"{conv_idx}_{idx}" not in success_records:
            session_id = user_id + "_lme_exper_session_" + str(idx)
            date = dates[idx] + " UTC"
            date_format = "%Y/%m/%d (%a) %H:%M UTC"
            date_string = datetime.strptime(date, date_format).replace(tzinfo=timezone.utc)

            try:
                ingest_session(session, date_string, user_id, session_id, frame, client)
                f.write(f"{conv_idx}_{idx}\n")
                f.flush()
            except Exception as e:
                print(f"❌ Error ingesting session: {e}")
        else:
            print(f"✅ Session {conv_idx}_{idx} already ingested")

    print("=" * 80)


def main(frame, version, num_workers=2):
    print("\n" + "=" * 80)
    print(f"🚀 LONGMEMEVAL INGESTION - {frame.upper()} v{version}".center(80))
    print("=" * 80)

    lme_df = pd.read_json("data/longmemeval/longmemeval_s.json")

    print("📚 Loaded LongMemeval dataset from data/longmemeval/longmemeval_s.json")
    num_multi_sessions = len(lme_df)
    print(f"👥 Number of users: {num_multi_sessions}")
    print("-" * 80)

    start_time = datetime.now()
    os.makedirs(f"results/lme/{frame}-{version}/", exist_ok=True)
    success_records = []
    record_file = f"results/lme/{frame}-{version}/success_records.txt"
    if os.path.exists(record_file):
        with open(record_file) as f:
            for i in f.readlines():
                success_records.append(i.strip())

    with ThreadPoolExecutor(max_workers=num_workers) as executor, open(record_file, "a+") as f:
        futures = []
        for session_idx in range(num_multi_sessions):
            future = executor.submit(
                ingest_conv, lme_df, version, session_idx, frame, success_records, f
            )
            futures.append(future)

        for future in tqdm(
            as_completed(futures), total=len(futures), desc="📊 Processing conversations"
        ):
            try:
                future.result()
            except Exception as e:
                print(f"❌ Error processing conversation: {e}")

    end_time = datetime.now()
    elapsed_time = end_time - start_time
    elapsed_time_str = str(elapsed_time).split(".")[0]

    print("\n" + "=" * 80)
    print("✅ INGESTION COMPLETE".center(80))
    print("=" * 80)
    print(f"⏱️  Total time taken to ingest {num_multi_sessions} multi-sessions: {elapsed_time_str}")
    print(f"🔄 Framework: {frame} | Version: {version} | Workers: {num_workers}")
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LongMemeval Ingestion Script")
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
        "--version", type=str, default="default", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--workers", type=int, default=20, help="Number of runs for LLM-as-a-Judge evaluation."
    )

    args = parser.parse_args()
    main(frame=args.lib, version=args.version, num_workers=args.workers)
