import argparse
import concurrent.futures
import os
import sys
import time

from datetime import datetime, timezone

import pandas as pd

from dotenv import load_dotenv


ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")
sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)


def ingest_session(client, session, frame, version, metadata):
    session_date = metadata["session_date"]
    date_format = "%I:%M %p on %d %B, %Y UTC"
    date_string = datetime.strptime(session_date, date_format).replace(tzinfo=timezone.utc)
    iso_date = date_string.isoformat()
    conv_idx = metadata["conv_idx"]
    conv_id = "locomo_exp_user_" + str(conv_idx)
    dt = datetime.fromisoformat(iso_date)
    timestamp = int(dt.timestamp())
    print(f"Processing conv {conv_id}, session {metadata['session_key']}")
    start_time = time.time()

    speaker_a_messages = []
    speaker_b_messages = []
    speaker_a_user_id = metadata["speaker_a_user_id"]
    speaker_b_user_id = metadata["speaker_b_user_id"]
    for chat in session:
        data = chat.get("speaker") + ": " + chat.get("text")
        if chat.get("speaker") == metadata["speaker_a"]:
            speaker_a_messages.append({"role": "user", "content": data})
            speaker_b_messages.append({"role": "assistant", "content": data})
        elif chat.get("speaker") == metadata["speaker_b"]:
            speaker_a_messages.append({"role": "assistant", "content": data})
            speaker_b_messages.append({"role": "user", "content": data})

    if "memos-api" in frame:
        for m in speaker_a_messages:
            m["chat_time"] = iso_date
        for m in speaker_b_messages:
            m["chat_time"] = iso_date
        client.add(
            speaker_a_messages,
            speaker_a_user_id,
            f"{conv_id}_{metadata['session_key']}",
            batch_size=2,
        )
        client.add(
            speaker_b_messages,
            speaker_b_user_id,
            f"{conv_id}_{metadata['session_key']}",
            batch_size=2,
        )
    elif "mem0" in frame:
        client.add(speaker_a_messages, speaker_a_user_id, timestamp, batch_size=2)
        client.add(speaker_b_messages, speaker_b_user_id, timestamp, batch_size=2)
    elif frame == "memobase":
        for m in speaker_a_messages:
            m["created_at"] = iso_date
        for m in speaker_b_messages:
            m["created_at"] = iso_date
        client.add(speaker_a_messages, speaker_a_user_id, batch_size=2)
        client.add(speaker_b_messages, speaker_b_user_id, batch_size=2)
    elif frame == "memu":
        client.add(speaker_a_messages, speaker_a_user_id, iso_date)
        client.add(speaker_b_messages, speaker_b_user_id, iso_date)
    elif frame == "supermemory":
        for m in speaker_a_messages:
            m["chat_time"] = iso_date
        for m in speaker_b_messages:
            m["chat_time"] = iso_date
        client.add(speaker_a_messages, speaker_a_user_id)
        client.add(speaker_b_messages, speaker_b_user_id)

    end_time = time.time()
    elapsed_time = round(end_time - start_time, 2)

    return elapsed_time


def process_user(conv_idx, frame, locomo_df, version, success_records, f):
    conversation = locomo_df["conversation"].iloc[conv_idx]
    max_session_count = 35
    start_time = time.time()
    total_session_time = 0
    valid_sessions = 0
    speaker_a_user_id = f"locomo_exp_user_{conv_idx}_speaker_a_{version}"
    speaker_b_user_id = f"locomo_exp_user_{conv_idx}_speaker_b_{version}"

    client = None
    if frame == "mem0" or frame == "mem0_graph":
        from prompts import custom_instructions
        from utils.client import Mem0Client

        client = Mem0Client(enable_graph="graph" in frame)
        client.client.update_project(custom_instructions=custom_instructions)
        client.client.delete_all(user_id=speaker_a_user_id)
        client.client.delete_all(user_id=speaker_b_user_id)
    elif frame == "memos-api":
        from utils.client import MemosApiClient

        client = MemosApiClient()
    elif frame == "memos-api-online":
        from utils.client import MemosApiOnlineClient

        client = MemosApiOnlineClient()
    elif frame == "memobase":
        from utils.client import MemobaseClient

        client = MemobaseClient()
        client.delete_user(speaker_a_user_id)
        client.delete_user(speaker_b_user_id)
    elif frame == "memu":
        from utils.client import MemuClient

        client = MemuClient()
    elif frame == "supermemory":
        from utils.client import SupermemoryClient

        client = SupermemoryClient()
    sessions_to_process = []
    for session_idx in range(max_session_count):
        session_key = f"session_{session_idx}"
        session = conversation.get(session_key)
        if session is None:
            continue

        metadata = {
            "session_date": conversation.get(f"session_{session_idx}_date_time") + " UTC",
            "speaker_a": conversation.get("speaker_a"),
            "speaker_b": conversation.get("speaker_b"),
            "speaker_a_user_id": speaker_a_user_id,
            "speaker_b_user_id": speaker_b_user_id,
            "conv_idx": conv_idx,
            "session_key": session_key,
        }
        sessions_to_process.append((session, metadata))
        valid_sessions += 1

    print(f"Processing {valid_sessions} sessions for user {conv_idx}")

    for session_idx, (session, metadata) in enumerate(sessions_to_process):
        if f"{conv_idx}_{session_idx}" not in success_records:
            session_time = ingest_session(client, session, frame, version, metadata)
            total_session_time += session_time
            print(f"User {conv_idx}, {metadata['session_key']} processed in {session_time} seconds")
            f.write(f"{conv_idx}_{session_idx}\n")
            f.flush()
        else:
            print(f"Session {conv_idx}_{session_idx} already ingested")
    end_time = time.time()
    elapsed_time = round(end_time - start_time, 2)
    print(f"User {conv_idx} processed successfully in {elapsed_time} seconds")

    return elapsed_time


def main(frame, version="default", num_workers=4):
    load_dotenv()
    locomo_df = pd.read_json("data/locomo/locomo10.json")
    num_users = 10
    start_time = time.time()
    total_time = 0
    print(
        f"Starting processing for {num_users} users in serial mode, each user using {num_workers} workers for sessions..."
    )
    os.makedirs(f"results/locomo/{frame}-{version}/", exist_ok=True)
    success_records = []
    record_file = f"results/locomo/{frame}-{version}/success_records.txt"
    if os.path.exists(record_file):
        with open(record_file) as f:
            for i in f.readlines():
                success_records.append(i.strip())

    with (
        concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor,
        open(record_file, "a+") as f,
    ):
        futures = [
            executor.submit(process_user, user_id, frame, locomo_df, version, success_records, f)
            for user_id in range(num_users)
        ]
        for future in concurrent.futures.as_completed(futures):
            session_time = future.result()
            total_time += session_time
    average_time = total_time / num_users
    minutes = int(average_time // 60)
    seconds = int(average_time % 60)
    average_time_formatted = f"{minutes} minutes and {seconds} seconds"
    print(
        f"The frame {frame} processed {num_users} users in average of {average_time_formatted} per user."
    )
    end_time = time.time()
    elapsed_time = round(end_time - start_time, 2)
    minutes = int(elapsed_time // 60)
    seconds = int(elapsed_time % 60)
    elapsed_time = f"{minutes} minutes and {seconds} seconds"
    print(f"Total processing time: {elapsed_time}.")


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
        help="Version identifier for saving results (e.g., 1010)",
    )
    parser.add_argument(
        "--workers", type=int, default=10, help="Number of parallel workers to process users"
    )
    args = parser.parse_args()
    lib = args.lib
    version = args.version
    workers = args.workers

    main(lib, version, workers)
