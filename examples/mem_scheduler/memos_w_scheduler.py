# Prerequisites & Configuration
# To run this script, you must have the following services
# running and configured in your .env file (or environment variables):
# 1. Redis (Required for TaskStatusTracker and Scheduler Queue)
# 2. Graph Database (Required for Memory Storage)
# 3. Vector Database (Required if using Neo4j Community or Preference Memory)

import asyncio
import json
import os
import sys
import time

from pathlib import Path


# Setup paths before imports that depend on them
FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))  # Enable execution from any working directory

# Set environment variables before importing server_router to ensure components are initialized correctly
os.environ["ENABLE_CHAT_API"] = "true"

from memos.api.product_models import APIADDRequest, ChatPlaygroundRequest  # noqa: E402

# Import from server_router for initialization
from memos.api.routers.server_router import (  # noqa: E402
    add_handler,
    chat_stream_playground,
    mem_scheduler,
)
from memos.log import get_logger  # noqa: E402
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem  # noqa: E402
from memos.mem_scheduler.schemas.task_schemas import (  # noqa: E402
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)


logger = get_logger(__name__)


def init_task():
    conversations = [
        {"role": "user", "content": "I just adopted a golden retriever puppy yesterday."},
        {"role": "assistant", "content": "Congratulations! What did you name your new puppy?"},
        {
            "role": "user",
            "content": "His name is Max. I live near Central Park in New York where we'll walk daily.",
        },
        {"role": "assistant", "content": "Max will love those walks! Any favorite treats for him?"},
        {
            "role": "user",
            "content": "He loves peanut butter biscuits. Personally, I'm allergic to nuts though.",
        },
        {"role": "assistant", "content": "Good to know about your allergy. I'll note that."},
        # Question 1 (Pet) - Name
        {"role": "user", "content": "What's my dog's name again?"},
        {"role": "assistant", "content": "Your dog is named Max."},
        # Question 2 (Pet) - Breed
        {"role": "user", "content": "Can you remind me what breed Max is?"},
        {"role": "assistant", "content": "Max is a golden retriever."},
        # Question 3 (Pet) - Treat
        {"role": "user", "content": "What treats does Max like?"},
        {"role": "assistant", "content": "He loves peanut butter biscuits."},
        # Question 4 (Address)
        {"role": "user", "content": "Where did I say I live?"},
        {"role": "assistant", "content": "You live near Central Park in New York."},
        # Question 5 (Allergy)
        {"role": "user", "content": "What food should I avoid due to allergy?"},
        {"role": "assistant", "content": "You're allergic to nuts."},
        {"role": "user", "content": "Perfect, just wanted to check what you remembered."},
        {"role": "assistant", "content": "Happy to help! Let me know if you need anything else."},
    ]

    questions = [
        {"question": "What's my dog's name again?", "category": "Pet"},
        {"question": "Can you remind me what breed Max is?", "category": "Pet"},
        {"question": "What treats does Max like?", "category": "Pet"},
        {"question": "Where did I say I live?", "category": "Address"},
        {"question": "What food should I avoid due to allergy?", "category": "Allergy"},
    ]
    return conversations, questions


working_memories = []


# Define custom query handler function
def custom_query_handler(messages: list[ScheduleMessageItem]):
    for msg in messages:
        # Print user input content
        print(f"\n[scheduler] User input query: {msg.content}")
        # Manually construct a new message with MEM_UPDATE label to trigger memory update
        new_msg = msg.model_copy(update={"label": MEM_UPDATE_TASK_LABEL})
        # Submit the message to the scheduler for processing
        mem_scheduler.submit_messages([new_msg])


# Define custom memory update handler function
def custom_mem_update_handler(messages: list[ScheduleMessageItem]):
    global working_memories
    search_args = {}
    top_k = 2
    for msg in messages:
        # Search for memories relevant to the current content in text memory (return top_k=2)
        results = mem_scheduler.retriever.search(
            query=msg.content,
            user_id=msg.user_id,
            mem_cube_id=msg.mem_cube_id,
            mem_cube=mem_scheduler.current_mem_cube,
            top_k=top_k,
            method=mem_scheduler.search_method,
            search_args=search_args,
        )
        working_memories.extend(results)
        working_memories = working_memories[-5:]
        for mem in results:
            print(f"\n[scheduler] Retrieved memory: {mem.memory}")


async def run_with_scheduler():
    print("==== run_with_automatic_scheduler_init ====")
    conversations, questions = init_task()

    # Initialization using server_router components
    # Configs are loaded via environment variables in init_server()

    user_id = "user_1"
    mem_cube_id = "mem_cube_5"

    print(f"Adding conversations for user {user_id}...")

    # Use add_handler to add memories
    add_req = APIADDRequest(
        user_id=user_id,
        writable_cube_ids=[mem_cube_id],
        messages=conversations,
        async_mode="sync",  # Use sync mode for immediate addition in this example
    )
    add_handler.handle_add_memories(add_req)

    for item in questions:
        print("===== Chat Start =====")
        query = item["question"]
        print(f"Query:\n {query}\n")

        # Use chat_handler to chat
        chat_req = ChatPlaygroundRequest(
            user_id=user_id,
            query=query,
            readable_cube_ids=[mem_cube_id],
            writable_cube_ids=[mem_cube_id],
        )
        response = chat_stream_playground(chat_req)

        answer = ""
        buffer = ""
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8")
            buffer += chunk
            while "\n\n" in buffer:
                msg, buffer = buffer.split("\n\n", 1)
                for line in msg.split("\n"):
                    if line.startswith("data: "):
                        json_str = line[6:]
                        try:
                            data = json.loads(json_str)
                            if data.get("type") == "text":
                                answer += data["data"]
                        except json.JSONDecodeError:
                            pass
        print(f"\nAnswer: {answer}")


if __name__ == "__main__":
    mem_scheduler.register_handlers(
        {
            QUERY_TASK_LABEL: custom_query_handler,  # Query task
            MEM_UPDATE_TASK_LABEL: custom_mem_update_handler,  # Memory update task
        }
    )

    asyncio.run(run_with_scheduler())

    time.sleep(20)
    mem_scheduler.stop()
