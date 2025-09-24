import asyncio
import os
import sys

ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
EVAL_SCRIPTS_DIR = os.path.join(ROOT_DIR, "evaluation", "scripts")

sys.path.insert(0, ROOT_DIR)
sys.path.insert(0, EVAL_SCRIPTS_DIR)

import argparse
import concurrent.futures
import json
import time
from datetime import datetime, timezone
import pandas as pd
from dotenv import load_dotenv
from prompts import custom_instructions
from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


def get_client(frame: str, user_id: str | None = None, version: str = "default"):
    if frame == "memos":
        mos_config_path = "configs/mos_memos_config.json"
        with open(mos_config_path) as f:
            mos_config_data = json.load(f)
        mos_config_data["top_k"] = 20
        mos_config = MOSConfig(**mos_config_data)
        mos = MOS(mos_config)
        mos.create_user(user_id=user_id)

        mem_cube_config_path = "configs/mem_cube_config.json"
        with open(mem_cube_config_path) as f:
            mem_cube_config_data = json.load(f)
        mem_cube_config_data["user_id"] = user_id
        mem_cube_config_data["cube_id"] = user_id
        mem_cube_config_data["text_mem"]["config"]["graph_db"]["config"]["db_name"] = (
            f"{user_id.replace('_', '')}{version}"
        )
        mem_cube_config = GeneralMemCubeConfig.model_validate(mem_cube_config_data)
        mem_cube = GeneralMemCube(mem_cube_config)

        storage_path = f"results/locomo/{frame}-{version}/storages/{user_id}"
        try:
            mem_cube.dump(storage_path)
        except Exception as e:
            print(f"dumping memory cube: {e!s} already exists, will use it")

        mos.register_mem_cube(
            mem_cube_name_or_path=storage_path,
            mem_cube_id=user_id,
            user_id=user_id,
        )
        return mos


def ingest_session(client, session, frame, version, metadata, revised_client=None):
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

    if frame == "memos" or frame == "memos-api":
        messages = []
        messages_reverse = []
        for chat in session:
            data = chat.get("speaker") + ": " + chat.get("text")
            if chat.get("speaker") == metadata["speaker_a"]:
                messages.append({"role": "user", "content": data, "chat_time": iso_date})
                messages_reverse.append(
                    {"role": "assistant", "content": data, "chat_time": iso_date}
                )
            elif chat.get("speaker") == metadata["speaker_b"]:
                messages.append({"role": "assistant", "content": data, "chat_time": iso_date})
                messages_reverse.append({"role": "user", "content": data, "chat_time": iso_date})
            else:
                raise ValueError(
                    f"Unknown speaker {chat.get('speaker')} in session {metadata['session_key']}"
                )

        speaker_a_user_id = conv_id + "_speaker_a"
        speaker_b_user_id = conv_id + "_speaker_b"
        if frame == "memos-api":
            client.add(
                messages=messages,
                user_id=f"{speaker_a_user_id}_{version}",
                conv_id=f"{conv_id}_{metadata['session_key']}",
            )
            client.add(
                messages=messages_reverse,
                user_id=f"{speaker_b_user_id}_{version}",
                conv_id=f"{conv_id}_{metadata['session_key']}",
            )
        elif frame == "memos":
            client.add(
                messages=messages,
                user_id=speaker_a_user_id,
            )
            revised_client.add(
                messages=messages_reverse,
                user_id=speaker_b_user_id,
            )
        print(f"Added messages for {speaker_a_user_id} and {speaker_b_user_id} successfully.")

    elif frame == "mem0" or frame == "mem0_graph":
        messages = []
        messages_reverse = []
        for chat in session:
            data = chat.get("speaker") + ": " + chat.get("text")
            if chat.get("speaker") == metadata["speaker_a"]:
                messages.append({"role": "user", "content": data})
                messages_reverse.append({"role": "assistant", "content": data})
            elif chat.get("speaker") == metadata["speaker_b"]:
                messages.append({"role": "assistant", "content": data})
                messages_reverse.append({"role": "user", "content": data})
            else:
                raise ValueError(
                    f"Unknown speaker {chat.get('speaker')} in session {metadata['session_key']}"
                )

        for i in range(0, len(messages), 2):
            batch_messages = messages[i : i + 2]
            batch_messages_reverse = messages_reverse[i : i + 2]

            if frame == "mem0":
                client.add(
                    messages=batch_messages,
                    timestamp=timestamp,
                    user_id=metadata["speaker_a_user_id"],
                    version="v2",
                )
                client.add(
                    messages=batch_messages_reverse,
                    timestamp=timestamp,
                    user_id=metadata["speaker_b_user_id"],
                    version="v2",
                )

            elif frame == "mem0_graph":
                client.add(
                    messages=batch_messages,
                    timestamp=timestamp,
                    user_id=metadata["speaker_a_user_id"],
                    output_format="v1.1",
                    version="v2",
                    enable_graph=True,
                )
                client.add(
                    messages=batch_messages_reverse,
                    timestamp=timestamp,
                    user_id=metadata["speaker_b_user_id"],
                    output_format="v1.1",
                    version="v2",
                    enable_graph=True,
                )
    elif frame == "memobase":
        from utils.memobase_utils import memobase_add_memory

        messages = []
        messages_reverse = []

        for chat in session:
            if chat.get("speaker") == metadata["speaker_a"]:
                messages.append(
                    {
                        "role": "user",
                        "content": chat.get("text"),
                        "alias": metadata["speaker_a"],
                        "created_at": iso_date,
                    }
                )
                messages_reverse.append(
                    {
                        "role": "assistant",
                        "content": chat.get("text"),
                        "alias": metadata["speaker_b"],
                        "created_at": iso_date,
                    }
                )
            elif chat.get("speaker") == metadata["speaker_b"]:
                messages.append(
                    {
                        "role": "assistant",
                        "content": chat.get("text"),
                        "alias": metadata["speaker_b"],
                        "created_at": iso_date,
                    }
                )
                messages_reverse.append(
                    {
                        "role": "user",
                        "content": chat.get("text"),
                        "alias": metadata["speaker_a"],
                        "created_at": iso_date,
                    }
                )
            else:
                raise ValueError(
                    f"Unknown speaker {chat.get('speaker')} in session {metadata['session_key']}"
                )

        users = client.get_all_users(limit=5000)
        for u in users:
            try:
                if u["additional_fields"]["user_id"] == conv_id + "_speaker_a":
                    user_a = client.get_user(u["id"], no_get=True)
                if u["additional_fields"]["user_id"] == conv_id + "_speaker_b":
                    user_b = client.get_user(u["id"], no_get=True)
            except:
                pass
        memobase_add_memory(user_a, messages)
        memobase_add_memory(user_b, messages_reverse)

    end_time = time.time()
    elapsed_time = round(end_time - start_time, 2)

    return elapsed_time


def process_user(conv_idx, frame, locomo_df, version):
    conversation = locomo_df["conversation"].iloc[conv_idx]
    max_session_count = 35
    start_time = time.time()
    total_session_time = 0
    valid_sessions = 0

    revised_client = None
    if frame == "mem0" or frame == "mem0_graph":
        from mem0 import MemoryClient

        mem0 = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
        mem0.update_project(custom_instructions=custom_instructions)
        client.delete_all(user_id=f"locomo_exp_user_{conv_idx}")
        client.delete_all(user_id=f"{conversation.get('speaker_a')}_{conv_idx}")
        client.delete_all(user_id=f"{conversation.get('speaker_b')}_{conv_idx}")
    elif frame == "memos":
        conv_id = "locomo_exp_user_" + str(conv_idx)
        speaker_a_user_id = conv_id + "_speaker_a"
        speaker_b_user_id = conv_id + "_speaker_b"
        client = get_client("memos", speaker_a_user_id, version)
        revised_client = get_client("memos", speaker_b_user_id, version)
    elif frame == "memos-api":
        from utils.memos_api import MemOSAPI

        client = MemOSAPI()
    elif frame == "memobase":
        from utils.client import memobase_client

        client = memobase_client()
        conv_id = "locomo_exp_user_" + str(conv_idx)
        speaker_a_user_id = conv_id + "_speaker_a"
        speaker_b_user_id = conv_id + "_speaker_b"
        all_users = client.get_all_users(limit=5000)
        for user in all_users:
            try:
                if user["additional_fields"]["user_id"] in [speaker_a_user_id, speaker_b_user_id]:
                    client.delete_user(user["id"])
                    print(f"🗑️  Deleted existing user from Memobase memory...")
            except:
                pass
        memobase_user_id_a = client.add_user({"user_id": speaker_a_user_id})
        memobase_user_id_b = client.add_user({"user_id": speaker_b_user_id})
        user_id_a = memobase_user_id_a
        user_id_b = memobase_user_id_b

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
            "speaker_a_user_id": f"{conversation.get('speaker_a')}_{conv_idx}",
            "speaker_b_user_id": f"{conversation.get('speaker_b')}_{conv_idx}",
            "conv_idx": conv_idx,
            "session_key": session_key,
        }
        sessions_to_process.append((session, metadata))
        valid_sessions += 1

    print(f"Processing {valid_sessions} sessions for user {conv_idx}")

    for session, metadata in sessions_to_process:
        session_time = ingest_session(client, session, frame, version, metadata, revised_client)
        total_session_time += session_time
        print(f"User {conv_idx}, {metadata['session_key']} processed in {session_time} seconds")

    end_time = time.time()
    elapsed_time = round(end_time - start_time, 2)
    print(f"User {conv_idx} processed successfully in {elapsed_time} seconds")

    return elapsed_time


async def main(frame, version="default", num_workers=4):
    load_dotenv()
    locomo_df = pd.read_json("data/locomo/locomo10.json")

    num_users = 10
    start_time = time.time()
    total_time = 0

    print(
        f"Starting processing for {num_users} users in serial mode, each user using {num_workers} workers for sessions..."
    )

    if frame == "zep":
        from zep_cloud.client import AsyncZep

        zep = AsyncZep(api_key=os.getenv("ZEP_API_KEY"), base_url="https://api.getzep.com/api/v2")
        num_users = 10
        max_session_count = 35
        for group_idx in range(num_users):
            conversation = locomo_df["conversation"].iloc[group_idx]
            group_id = f"locomo_exp_user_{group_idx}"
            print(group_id)
            try:
                await zep.group.add(group_id=group_id)
            except Exception:
                pass

            for session_idx in range(max_session_count):
                session_key = f"session_{session_idx}"
                print(session_key)
                session = conversation.get(session_key)
                if session is None:
                    continue
                for msg in session:
                    session_date = conversation.get(f"session_{session_idx}_date_time") + " UTC"
                    date_format = "%I:%M %p on %d %B, %Y UTC"
                    date_string = datetime.strptime(session_date, date_format).replace(
                        tzinfo=timezone.utc
                    )
                    iso_date = date_string.isoformat()
                    blip_caption = msg.get("blip_captions")
                    img_description = (
                        f"(description of attached image: {blip_caption})"
                        if blip_caption is not None
                        else ""
                    )
                    await zep.graph.add(
                        data=msg.get("speaker") + ": " + msg.get("text") + img_description,
                        type="message",
                        created_at=iso_date,
                        group_id=group_id,
                    )

    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = [
                executor.submit(process_user, user_id, frame, locomo_df, version)
                for user_id in range(num_users)
            ]

            for future in concurrent.futures.as_completed(futures):
                session_time = future.result()
                total_time += session_time

        if num_users > 0:
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
        choices=["zep", "memos", "mem0", "mem0_graph", "memos-api", "memobase"],
        default="memos-api",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="0917-test",
        help="Version identifier for saving results (e.g., 1010)",
    )
    parser.add_argument(
        "--workers", type=int, default=10, help="Number of parallel workers to process users"
    )
    args = parser.parse_args()
    lib = args.lib
    version = args.version
    workers = args.workers

    asyncio.run(main(lib, version, workers))
