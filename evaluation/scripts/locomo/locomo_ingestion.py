import argparse
import concurrent.futures
import json
import os
import time

from datetime import datetime, timezone

import pandas as pd

from dotenv import load_dotenv
from mem0 import MemoryClient
from tqdm import tqdm
from zep_cloud.client import Zep

from memos.configs.mem_cube import GeneralMemCubeConfig
from memos.configs.mem_os import MOSConfig
from memos.mem_cube.general import GeneralMemCube
from memos.mem_os.main import MOS


custom_instructions = """
Generate personal memories that follow these guidelines:

1. Each memory should be self-contained with complete context, including:
   - The person's name, do not use "user" while creating memories
   - Personal details (career aspirations, hobbies, life circumstances)
   - Emotional states and reactions
   - Ongoing journeys or future plans
   - Specific dates when events occurred

2. Include meaningful personal narratives focusing on:
   - Identity and self-acceptance journeys
   - Family planning and parenting
   - Creative outlets and hobbies
   - Mental health and self-care activities
   - Career aspirations and education goals
   - Important life events and milestones

3. Make each memory rich with specific details rather than general statements
   - Include timeframes (exact dates when possible)
   - Name specific activities (e.g., "charity race for mental health" rather than just "exercise")
   - Include emotional context and personal growth elements

4. Extract memories only from user messages, not incorporating assistant responses

5. Format each memory as a paragraph with a clear narrative structure that captures the person's experience, challenges, and aspirations
"""


def get_client(frame: str, user_id: str | None = None, version: str = "default"):
    if frame == "zep":
        zep = Zep(api_key=os.getenv("ZEP_API_KEY"), base_url="https://api.getzep.com/api/v2")
        return zep

    elif frame == "mem0" or frame == "mem0_graph":
        mem0 = MemoryClient(api_key=os.getenv("MEM0_API_KEY"))
        mem0.update_project(custom_instructions=custom_instructions)
        return mem0

    elif frame == "memos":
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


def ingest_session(client, session, frame, metadata, revised_client=None):
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

    if frame == "zep":
        for chat in tqdm(session, desc=f"{metadata['session_key']}"):
            data = chat.get("speaker") + ": " + chat.get("text")
            print({"context": data, "conv_id": conv_id, "created_at": iso_date})

            # Check if the group exists, if not create it
            groups = client.group.get_all_groups()
            groups = dict(groups)["groups"]
            exist_ids = [gp.group_id for gp in groups]
            if conv_id not in exist_ids:
                client.group.add(group_id=conv_id)

            # Add the message to the group
            client.graph.add(
                data=data,
                type="message",
                created_at=iso_date,
                group_id=conv_id,
            )

    elif frame == "memos":
        messages = []
        messages_reverse = []

        for chat in tqdm(session, desc=f"{metadata['session_key']}"):
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

            print({"context": data, "conv_id": conv_id, "created_at": iso_date})

        speaker_a_user_id = conv_id + "_speaker_a"
        speaker_b_user_id = conv_id + "_speaker_b"

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
        print(f"Processing abc for {metadata['session_key']}")
        messages = []
        messages_reverse = []

        for chat in tqdm(session, desc=f"{metadata['session_key']}"):
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

            print({"context": data, "conv_id": conv_id, "created_at": iso_date})

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

    end_time = time.time()
    elapsed_time = round(end_time - start_time, 2)

    return elapsed_time


def process_user(conv_idx, frame, locomo_df, version, num_workers=1):
    try:
        conversation = locomo_df["conversation"].iloc[conv_idx]
        max_session_count = 35
        start_time = time.time()
        total_session_time = 0
        valid_sessions = 0

        revised_client = None
        if frame == "zep":
            client = get_client("zep")
        elif frame == "mem0" or frame == "mem0_graph":
            client = get_client(frame)
            client.delete_all(user_id=f"locomo_exp_user_{conv_idx}")
            client.delete_all(user_id=f"{conversation.get('speaker_a')}_{conv_idx}")
            client.delete_all(user_id=f"{conversation.get('speaker_b')}_{conv_idx}")
        elif frame == "memos":
            conv_id = "locomo_exp_user_" + str(conv_idx)
            speaker_a_user_id = conv_id + "_speaker_a"
            speaker_b_user_id = conv_id + "_speaker_b"
            client = get_client("memos", speaker_a_user_id, version)
            revised_client = get_client("memos", speaker_b_user_id, version)

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

        print(
            f"Processing {valid_sessions} sessions for user {conv_idx} with {num_workers} workers"
        )
        with concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor:
            futures = {
                executor.submit(
                    ingest_session, client, session, frame, metadata, revised_client
                ): metadata["session_key"]
                for session, metadata in sessions_to_process
            }

            for future in concurrent.futures.as_completed(futures):
                session_key = futures[future]
                try:
                    session_time = future.result()
                    total_session_time += session_time
                    print(f"User {conv_idx}, {session_key} processed in {session_time} seconds")
                except Exception as e:
                    print(f"Error processing user {conv_idx}, session {session_key}: {e!s}")

        end_time = time.time()
        elapsed_time = round(end_time - start_time, 2)
        print(f"User {conv_idx} processed successfully in {elapsed_time} seconds")

        return elapsed_time

    except Exception as e:
        return f"Error processing user {conv_idx}: {e!s}"


def main(frame, version="default", num_workers=4):
    load_dotenv()
    locomo_df = pd.read_json("data/locomo/locomo10.json")

    num_users = 10
    start_time = time.time()
    total_time = 0

    print(
        f"Starting processing for {num_users} users in serial mode, each user using {num_workers} workers for sessions..."
    )

    for user_id in range(num_users):
        try:
            result = process_user(user_id, frame, locomo_df, version, num_workers)
            if isinstance(result, float):
                total_time += result
            else:
                print(result)
        except Exception as e:
            print(f"Error processing user {user_id}: {e!s}")

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
        choices=["zep", "memos", "mem0", "mem0_graph"],
        help="Specify the memory framework (zep or memos or mem0 or mem0_graph)",
    )
    parser.add_argument(
        "--version",
        type=str,
        default="default",
        help="Version identifier for saving results (e.g., 1010)",
    )
    parser.add_argument(
        "--workers", type=int, default=1, help="Number of parallel workers to process users"
    )
    args = parser.parse_args()
    lib = args.lib
    version = args.version
    workers = args.workers

    main(lib, version, workers)
