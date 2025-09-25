import argparse
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import pandas as pd

from tqdm import tqdm


def ingest_session(session, date, user_id, session_id, frame, client):
    messages = []
    if frame == "zep":
        for idx, msg in enumerate(session):
            print(
                f"[{frame}] 📝 User {user_id} 💬 Session {session_id}: [{idx + 1}/{len(session)}] Ingesting message: {msg['role']} - {msg['content'][:50]}... at {date.isoformat()}"
            )
            client.memory.add(
                session_id=session_id,
                messages=[
                    Message(
                        role=msg["role"],
                        role_type=msg["role"],
                        content=msg["content"][:8000],
                        created_at=date.isoformat(),
                    )
                ],
            )
    elif frame == "mem0-local" or frame == "mem0-api":
        for idx, msg in enumerate(session):
            messages.append({"role": msg["role"], "content": msg["content"][:8000]})
            print(
                f"[{frame}] 📝 Session {session_id}: [{idx + 1}/{len(session)}] Reading message: {msg['role']} - {msg['content'][:50]}... at {date.isoformat()}"
            )
        if frame == "mem0-local":
            client.add(
                messages=messages, user_id=user_id, run_id=session_id, timestamp=date.isoformat()
            )
        elif frame == "mem0-api":
            client.add(
                messages=messages,
                user_id=user_id,
                session_id=session_id,
                timestamp=int(date.timestamp()),
                version="v2",
            )
        print(
            f"[{frame}] ✅ Session {session_id}: Ingested {len(messages)} messages at {date.isoformat()}"
        )
    elif frame == "memobase":
        for idx, msg in enumerate(session):
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "created_at": date.isoformat(),
                }
            )
            # print(f"[{frame}] 📝 User {user_id} 💬 Session {session_id}: [{idx + 1}/{len(session)}] Ingesting message: {msg['role']} - {msg['content'][:50]}... at {date.isoformat()}")

        user = client.get_user(user_id)
        memobase_add_memory(user, messages)
        # print(f"[{frame}] ✅ Session {session_id}: Ingested {len(messages)} messages at {date.isoformat()}")
    elif frame == "memos-local" or frame == "memos-api":
        for _idx, msg in enumerate(session):
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "chat_time": date.isoformat(),
                }
            )
        if frame == "memos-local":
            client.add(messages=messages, user_id=user_id)
            client.mem_reorganizer_wait()
        elif frame == "memos-api":
            if messages:
                client.add(messages=messages, user_id=user_id, conv_id=session_id)
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

    if frame == "zep":
        from utils.client import zep_client

        client = zep_client()
        client.user.add(user_id=user_id)
        print(f"➕ Added user {user_id} to Zep memory...")
    elif frame == "mem0-api":
        from utils.client import mem0_client

        client = mem0_client(mode="api")
    elif frame == "memos-local":
        from utils.client import memos_client

        client = memos_client(
            mode="local",
            db_name=f"lme_{frame}-{version}",
            user_id=user_id,
            top_k=20,
            mem_cube_path=f"results/lme/{frame}-{version}/storages/{user_id}",
            mem_cube_config_path="configs/mu_mem_cube_config.json",
            mem_os_config_path="configs/mos_memos_config.json",
            addorsearch="add",
        )
        print("🔌 Using Memos Local client for ingestion...")
    elif frame == "memos-api":
        from utils.memos_api import MemOSAPI

        client = MemOSAPI()
    elif frame == "memobase":
        from utils.client import memobase_client

        client = memobase_client()
        memobase_user_id = client.add_user({"user_id": user_id})
        user_id = memobase_user_id

    for idx, session in enumerate(sessions):
        if f"{conv_idx}_{idx}" not in success_records:
            session_id = user_id + "_lme_exper_session_" + str(idx)
            if frame == "zep":
                client.memory.add_session(
                    user_id=user_id,
                    session_id=session_id,
                )
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

    if frame == "memos-local":
        client.mem_reorganizer_off()

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
        for i in open(record_file, "r").readlines():
            success_records.append(i.strip())

    f = open(record_file, "a+")

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
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
        choices=["mem0-local", "mem0-api", "memos-local", "memos-api", "zep", "memobase"],
        default="memos-api",
    )
    parser.add_argument(
        "--version", type=str, default="0924", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--workers", type=int, default=20, help="Number of runs for LLM-as-a-Judge evaluation."
    )

    args = parser.parse_args()

    main(frame=args.lib, version=args.version, num_workers=args.workers)
