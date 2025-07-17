import argparse
import os
import sys


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import pandas as pd

from tqdm import tqdm
from utils.client import mem0_client, memos_client, zep_client
from zep_cloud.types import Message


def ingest_session(session, date, user_id, session_id, frame, client):
    messages = []
    if frame == "zep":
        for idx, msg in enumerate(session):
            print(
                f"\033[90m[{frame}]\033[0m 💬 Session \033[1;94m{session_id}\033[0m: [\033[93m{idx + 1}/{len(session)}\033[0m] Ingesting message: \033[1m{msg['role']}\033[0m - \033[96m{msg['content'][:50]}...\033[0m at \033[92m{date.isoformat()}\033[0m"
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
                f"\033[90m[{frame}]\033[0m 📝 Session \033[1;94m{session_id}\033[0m: [\033[93m{idx + 1}/{len(session)}\033[0m] Reading message: \033[1m{msg['role']}\033[0m - \033[96m{msg['content'][:50]}...\033[0m at \033[92m{date.isoformat()}\033[0m"
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
            f"\033[90m[{frame}]\033[0m ✅ Session \033[1;94m{session_id}\033[0m: Ingested \033[93m{len(messages)}\033[0m messages at \033[92m{date.isoformat()}\033[0m"
        )
    elif frame == "memos-local":
        for idx, msg in enumerate(session):
            messages.append(
                {
                    "role": msg["role"],
                    "content": msg["content"][:8000],
                    "chat_time": date.isoformat(),
                }
            )
            print(
                f"\033[90m[{frame}]\033[0m 📝 Session \033[1;94m{session_id}\033[0m: [\033[93m{idx + 1}/{len(session)}\033[0m] Reading message: \033[1m{msg['role']}\033[0m - \033[96m{msg['content'][:50]}...\033[0m at \033[92m{date.isoformat()}\033[0m"
            )
        client.add(messages=messages, user_id=user_id)
        print(
            f"\033[90m[{frame}]\033[0m ✅ Session \033[1;94m{session_id}\033[0m: Ingested \033[93m{len(messages)}\033[0m messages at \033[92m{date.isoformat()}\033[0m"
        )


def ingest_conv(lme_df, version, conv_idx, frame, num_workers=2):
    conversation = lme_df.iloc[conv_idx]

    sessions = conversation["haystack_sessions"]
    dates = conversation["haystack_dates"]

    user_id = "lme_exper_user_" + str(conv_idx)
    session_id = "lme_exper_session_" + str(conv_idx)

    print("\n" + "=" * 80)
    print(f"🔄 \033[1;36mINGESTING CONVERSATION {conv_idx}\033[0m".center(80))
    print("=" * 80)

    if frame == "zep":
        client = zep_client()
        print("🔌 \033[1mUsing \033[94mZep client\033[0m \033[1mfor ingestion...\033[0m")
        # Delete existing user and session if they exist
        client.user.delete(user_id)
        client.memory.delete(session_id)
        print(
            f"🗑️  Deleted existing user \033[93m{user_id}\033[0m and session \033[93m{session_id}\033[0m from Zep memory..."
        )
        # Add user and session to Zep memory
        client.user.add(user_id=user_id)
        client.memory.add_session(
            user_id=user_id,
            session_id=session_id,
        )
        print(
            f"➕ Added user \033[93m{user_id}\033[0m and session \033[93m{session_id}\033[0m to Zep memory..."
        )
    elif frame == "mem0-local":
        client = mem0_client(mode="local")
        print("🔌 \033[1mUsing \033[94mMem0 Local client\033[0m \033[1mfor ingestion...\033[0m")
        # Delete existing memories for the user
        client.delete_all(user_id=user_id)
        print(f"🗑️  Deleted existing memories for user \033[93m{user_id}\033[0m...")
    elif frame == "mem0-api":
        client = mem0_client(mode="api")
        print("🔌 \033[1mUsing \033[94mMem0 API client\033[0m \033[1mfor ingestion...\033[0m")
        # Delete existing memories for the user
        client.delete_all(user_id=user_id)
        print(f"🗑️  Deleted existing memories for user \033[93m{user_id}\033[0m...")
    elif frame == "memos-local":
        client = memos_client(
            mode="local",
            db_name=f"lme_{frame}-{version}-{user_id.replace('_', '')}",
            user_id=user_id,
            top_k=20,
            mem_cube_path=f"results/lme/{frame}-{version}/storages/{user_id}",
            mem_cube_config_path="configs/mem_cube_config.json",
            mem_os_config_path="configs/mos_memos_config.json",
            addorsearch="add",
        )
        print("🔌 \033[1mUsing \033[94mMemos Local client\033[0m \033[1mfor ingestion...\033[0m")

    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = []

        for idx, session in enumerate(sessions):
            date = dates[idx] + " UTC"
            date_format = "%Y/%m/%d (%a) %H:%M UTC"
            date_string = datetime.strptime(date, date_format).replace(tzinfo=timezone.utc)

            future = executor.submit(
                ingest_session, session, date_string, user_id, session_id, frame, client
            )
            futures.append(future)

            if len(session) == 0:
                print(f"\033[93m⚠️  Skipping empty session {idx} in conversation {conv_idx}\033[0m")
                continue

        for future in tqdm(
            as_completed(futures), total=len(futures), desc=f"📊 Ingesting user {conv_idx}"
        ):
            try:
                future.result()
            except Exception as e:
                print(f"\033[91m❌ Error ingesting session: {e}\033[0m")

    print("=" * 80)


def main(frame, version, num_workers=2):
    print("\n" + "=" * 80)
    print(f"🚀 \033[1;36mLONGMEMEVAL INGESTION - {frame.upper()} v{version}\033[0m".center(80))
    print("=" * 80)

    lme_df = pd.read_json("data/longmemeval/longmemeval_s.json")

    print(
        "📚 \033[1mLoaded LongMemeval dataset\033[0m from \033[94mdata/longmemeval/longmemeval_s.json\033[0m"
    )
    num_multi_sessions = len(lme_df)
    print(f"👥 Number of users: \033[93m{num_multi_sessions}\033[0m")
    print("-" * 80)

    start_time = datetime.now()
    for session_idx in range(num_multi_sessions):
        ingest_conv(lme_df, version, session_idx, frame, num_workers=num_workers)
    end_time = datetime.now()
    elapsed_time = end_time - start_time
    elapsed_time_str = str(elapsed_time).split(".")[0]

    print("\n" + "=" * 80)
    print("✅ \033[1;32mINGESTION COMPLETE\033[0m".center(80))
    print("=" * 80)
    print(
        f"⏱️  Total time taken to ingest \033[93m{num_multi_sessions}\033[0m multi-sessions: \033[92m{elapsed_time_str}\033[0m"
    )
    print(
        f"🔄 Framework: \033[94m{frame}\033[0m | Version: \033[94m{version}\033[0m | Workers: \033[94m{num_workers}\033[0m"
    )
    print("=" * 80 + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="LongMemeval Ingestion Script")
    parser.add_argument(
        "--lib",
        type=str,
        choices=["mem0-local", "mem0-api", "memos-local"],
    )
    parser.add_argument(
        "--version", type=str, default="v1", help="Version of the evaluation framework."
    )
    parser.add_argument(
        "--workers", type=int, default=3, help="Number of runs for LLM-as-a-Judge evaluation."
    )

    args = parser.parse_args()

    main(frame=args.lib, version=args.version, num_workers=args.workers)
