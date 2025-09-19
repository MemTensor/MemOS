import concurrent.futures
import sys
import time
import traceback

from datetime import datetime, timezone
from pathlib import Path

from modules.constants import (
    MEM0_GRAPH_MODEL,
    MEM0_MODEL,
    MEMOS_MODEL,
    MEMOS_SCHEDULER_MODEL,
    ZEP_MODEL,
)
from modules.locomo_eval_module import LocomoEvalModelModules
from tqdm import tqdm

from memos.log import get_logger


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

logger = get_logger(__name__)


class LocomoIngestor(LocomoEvalModelModules):
    def __init__(self, args):
        super().__init__(args=args)

    def ingest_session(self, client, session, frame, metadata, revised_client=None):
        session_date = metadata["session_date"]
        date_format = "%I:%M %p on %d %B, %Y UTC"
        date_string = datetime.strptime(session_date, date_format).replace(tzinfo=timezone.utc)
        iso_date = date_string.isoformat()
        conv_id = metadata["conv_id"]
        conv_id = "locomo_exp_user_" + str(conv_id)
        dt = datetime.fromisoformat(iso_date)
        timestamp = int(dt.timestamp())
        print(f"Processing conv {conv_id}, session {metadata['session_key']}")
        start_time = time.time()
        print_once = True  # Print example only once per session

        if frame == ZEP_MODEL:
            for chat in tqdm(session, desc=f"{metadata['session_key']}"):
                data = chat.get("speaker") + ": " + chat.get("text")

                # Print example only once per session
                if print_once:
                    print({"context": data, "conv_id": conv_id, "created_at": iso_date})
                    print_once = False

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

        elif frame in [MEMOS_MODEL, MEMOS_SCHEDULER_MODEL]:
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
                    messages_reverse.append(
                        {"role": "user", "content": data, "chat_time": iso_date}
                    )
                else:
                    raise ValueError(
                        f"Unknown speaker {chat.get('speaker')} in session {metadata['session_key']}"
                    )

                # Print example only once per session
                if print_once:
                    print({"context": data, "conv_id": conv_id, "created_at": iso_date})
                    print_once = False

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

        elif frame in [MEM0_MODEL, MEM0_GRAPH_MODEL]:
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

                # Print example only once per session
                if print_once:
                    print({"context": data, "conv_id": conv_id, "created_at": iso_date})
                    print_once = False

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

    def process_user_for_ingestion(self, conv_id, frame, locomo_df, version, num_workers=1):
        try:
            # Check if locomo_df is empty or doesn't have the required columns
            if locomo_df.empty or "conversation" not in locomo_df.columns:
                logger.warning(
                    f"Skipping user {conv_id}: locomo_df is empty or missing 'conversation' column"
                )
                return 0

            conversation = locomo_df["conversation"].iloc[conv_id]
            max_session_count = 35
            start_time = time.time()
            total_session_time = 0
            valid_sessions = 0

            revised_client = None
            if frame == "zep":
                client = self.get_client_for_ingestion(frame=frame, user_id=None, version="default")
            elif frame == "mem0" or frame == "mem0_graph":
                client = self.get_client_for_ingestion(frame=frame, user_id=None, version="default")
                client.delete_all(user_id=f"locomo_exp_user_{conv_id}")
                client.delete_all(user_id=f"{conversation.get('speaker_a')}_{conv_id}")
                client.delete_all(user_id=f"{conversation.get('speaker_b')}_{conv_id}")
            elif frame in ["memos", "memos_scheduler"]:
                conv_id = "locomo_exp_user_" + str(conv_id)
                speaker_a_user_id = conv_id + "_speaker_a"
                speaker_b_user_id = conv_id + "_speaker_b"

                client = self.get_client_for_ingestion(
                    frame=frame, user_id=speaker_a_user_id, version=version
                )
                revised_client = self.get_client_for_ingestion(
                    frame=frame, user_id=speaker_b_user_id, version=version
                )
            else:
                raise NotImplementedError()

            sessions_to_process = []
            for session_idx in tqdm(range(max_session_count), desc=f"process_user {conv_id}"):
                session_key = f"session_{session_idx}"
                session = conversation.get(session_key)
                if session is None:
                    continue

                metadata = {
                    "session_date": conversation.get(f"session_{session_idx}_date_time") + " UTC",
                    "speaker_a": conversation.get("speaker_a"),
                    "speaker_b": conversation.get("speaker_b"),
                    "speaker_a_user_id": f"{conversation.get('speaker_a')}_{conv_id}",
                    "speaker_b_user_id": f"{conversation.get('speaker_b')}_{conv_id}",
                    "conv_id": conv_id,
                    "session_key": session_key,
                }
                sessions_to_process.append((session, metadata))
                valid_sessions += 1

            print(
                f"Processing {valid_sessions} sessions for user {conv_id} with {num_workers} workers"
            )
            with concurrent.futures.ThreadPoolExecutor(max_workers=num_workers) as executor:
                futures = {
                    executor.submit(
                        self.ingest_session, client, session, frame, metadata, revised_client
                    ): metadata["session_key"]
                    for session, metadata in sessions_to_process
                }

                for future in concurrent.futures.as_completed(futures):
                    session_key = futures[future]
                    try:
                        session_time = future.result()
                        total_session_time += session_time
                        print(f"User {conv_id}, {session_key} processed in {session_time} seconds")
                    except Exception as e:
                        print(f"Error processing user {conv_id}, session {session_key}: {e!s}")

            end_time = time.time()
            elapsed_time = round(end_time - start_time, 2)
            print(f"User {conv_id} processed successfully in {elapsed_time} seconds")

            return elapsed_time

        except Exception as e:
            return f"Error processing user {conv_id}: {e!s}. Exception: {traceback.format_exc()}"

    def run_ingestion(self):
        frame = self.frame
        version = self.version
        num_workers = self.workers

        num_users = 10
        start_time = time.time()
        total_time = 0

        print(
            f"Starting processing for {num_users} users in serial mode,"
            f" each user using {num_workers} workers for sessions..."
        )

        for user_id in range(num_users):
            try:
                result = self.process_user_for_ingestion(
                    user_id, frame, self.locomo_df, version, num_workers
                )
                if isinstance(result, float):
                    total_time += result
                else:
                    print(result)
            except Exception as e:
                print(
                    f"Error processing user {user_id}: {e!s}. Traceback: {traceback.format_exc()}"
                )

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
