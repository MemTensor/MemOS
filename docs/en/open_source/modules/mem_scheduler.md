---
title: "MemScheduler"
desc: MemScheduler is your "memory organization scheduler". It asynchronously manages memory flow and updates in the background, coordinating interactions between working memory, long-term memory, and activation memory, enabling conversational systems to dynamically organize and utilize memories.
---

## Key Features

- 🚀 **Concurrent operation with MemOS system**: Runs in independent threads/processes without blocking main business logic.
- 🧠 **Multi-memory coordination**: Intelligently manages the flow of working memory, long-term memory, and user-personalized memory.
- ⚡ **Event-driven scheduling**: Asynchronous task distribution based on message queues (Redis/Local).
- 🔍 **Efficient retrieval**: Integrated vector and graph retrieval for quick location of relevant memories.
- 📊 **Comprehensive monitoring**: Real-time monitoring of memory utilization, task queue status, and scheduling latency.
- 📝 **Detailed logging**: Full-chain tracing of memory operations for debugging and system analysis.

## MemScheduler Architecture

`MemScheduler` adopts a three-layer modular architecture:

### Scheduling Layer (Core)
1. **Scheduler (Router)**: Intelligent message router that dispatches tasks to corresponding handlers based on message types (e.g., `QUERY`, `ANSWER`, `MEM_UPDATE`).
2. **Message Processing**: Event-driven business logic through messages with specific labels, defining message formats and processing rules.

### Execution Layer (Guarantee)
3. **Task Queue**: Supports both Redis Stream (production) and Local Queue (development/testing) modes, providing asynchronous task buffering and persistence.
4. **Memory Management**: Executes read/write, compression, forgetting, and type conversion operations on three-layer memory (Working/Long-term/User).
5. **Retrieval System**: Hybrid retrieval module combining user intent, scenario management, and keyword matching for quick memory location.

### Support Layer (Auxiliary)
6. **Monitoring**: Tracks task accumulation, processing latency, and memory health status.
7. **Logging**: Maintains full-chain memory operation logs for debugging and analysis.

## MemScheduler Initialization

In the MemOS architecture, `MemScheduler` is initialized as part of the server components during startup.

### Initialization in Server Router

In `src/memos/api/routers/server_router.py`, the scheduler is automatically loaded through the `init_server()` function:

```python
from memos.api import handlers
from memos.api.handlers.base_handler import HandlerDependencies
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker

# ... other imports ...

# 1. Initialize all server components (including DB, LLM, Memory, Scheduler)
# init_server() reads environment variables and initializes global singleton components
components = handlers.init_server()

# Create dependency container for handlers
dependencies = HandlerDependencies.from_init_server(components)

# Initialize handlers...
# search_handler = SearchHandler(dependencies)
# ...

# 2. Get the scheduler instance from the components dictionary
# The scheduler is already initialized and started inside init_server (if enabled)
mem_scheduler: BaseScheduler = components["mem_scheduler"]

# 3. Users can also get other scheduling-related components from components (optional, for custom task handling)
# redis_client is used for direct Redis operations or monitoring task status
redis_client = components["redis_client"]
# ...
```

## Scheduling Tasks and Data Models

The scheduler distributes and executes tasks through a message-driven approach. This section introduces supported task types, message structures, and execution logs.

### Message Types and Handlers

The scheduler dispatches and executes tasks by registering specific task labels (Label) with handlers (Handler). The following are the default supported scheduling tasks in the current version (based on `GeneralScheduler` and `OptimizedScheduler`):

| Message Label | Constant | Handler Method | Description |
| :--- | :--- | :--- | :--- |
| `query` | `QUERY_TASK_LABEL` | `_query_message_consumer` | Processes user queries, triggers intent recognition, memory retrieval, and converts them to memory update tasks. |
| `answer` | `ANSWER_TASK_LABEL` | `_answer_message_consumer` | Processes AI responses and logs conversations. |
| `mem_update` | `MEM_UPDATE_TASK_LABEL` | `_memory_update_consumer` | Core task. Executes the long-term memory update process, including extracting Query Keywords, updating Monitor, retrieving relevant memories, and replacing Working Memory. |
| `add` | `ADD_TASK_LABEL` | `_add_message_consumer` | Handles logging of new memory additions (supports local and cloud logs). |
| `mem_read` | `MEM_READ_TASK_LABEL` | `_mem_read_message_consumer` | Deep processing and importing external memory content using `MemReader`. |
| `mem_organize` | `MEM_ORGANIZE_TASK_LABEL` | `_mem_reorganize_message_consumer` | Triggers memory reorganization and merge operations. |
| `pref_add` | `PREF_ADD_TASK_LABEL` | `_pref_add_message_consumer` | Handles extraction and addition of user preference memory (Preference Memory). |
| `mem_feedback` | `MEM_FEEDBACK_TASK_LABEL` | `_mem_feedback_message_consumer` | Processes user feedback for correcting or reinforcing preferences. |
| `api_mix_search` | `API_MIX_SEARCH_TASK_LABEL` | `_api_mix_search_message_consumer` | (OptimizedScheduler only) Executes asynchronous hybrid search tasks combining fast and fine retrieval. |

### Message Data Structure (ScheduleMessageItem)

The scheduler uses a unified `ScheduleMessageItem` structure to pass messages in the queue.

> **Note**: The `mem_cube` object itself is not directly included in the message model; instead, it is resolved by the scheduler at runtime through `mem_cube_id`.

| Field | Type | Description | Default/Remarks |
| :--- | :--- | :--- | :--- |
| `item_id` | `str` | Unique message identifier (UUID) | Auto-generated |
| `user_id` | `str` | Associated user ID | (Required) |
| `mem_cube_id` | `str` | Associated Memory Cube ID | (Required) |
| `label` | `str` | Task label (e.g., `query`, `mem_update`) | (Required) |
| `content` | `str` | Message payload (typically JSON string or text) | (Required) |
| `timestamp` | `datetime` | Message submission time | Auto-generated (UTC now) |
| `session_id` | `str` | Session ID for context isolation | `""` |
| `trace_id` | `str` | Trace ID for full-chain log association | Auto-generated |
| `user_name` | `str` | User display name | `""` |
| `task_id` | `str` | Business-level task ID (for associating multiple messages) | `None` |
| `info` | `dict` | Additional custom context information | `None` |
| `stream_key` | `str` | (Internal use) Redis Stream key name | `""` |

### Execution Log Structure (ScheduleLogForWebItem)

The scheduler generates structured log messages for frontend display or persistent storage.

| Field | Type | Description | Remarks |
| :--- | :--- | :--- | :--- |
| `item_id` | `str` | Unique log entry identifier | Auto-generated |
| `task_id` | `str` | Associated parent task ID | Optional |
| `user_id` | `str` | User ID | (Required) |
| `mem_cube_id` | `str` | Memory Cube ID | (Required) |
| `label` | `str` | Log category (e.g., `addMessage`, `addMemory`) | (Required) |
| `log_content` | `str` | Brief log description text | (Required) |
| `from_memory_type` | `str` | Source memory area | e.g., `UserInput`, `LongTermMemory` |
| `to_memory_type` | `str` | Destination memory area | e.g., `WorkingMemory` |
| `memcube_log_content` | `list[dict]` | Structured detailed content | Contains specific memory text, reference IDs, etc. |
| `metadata` | `list[dict]` | Memory item metadata | Contains confidence, status, tags, etc. |
| `status` | `str` | Task status | e.g., `completed`, `failed` |
| `timestamp` | `datetime` | Log creation time | Auto-generated |
| `current_memory_sizes` | `MemorySizes` | Current memory quantity snapshot for each area | For monitoring dashboard display |
| `memory_capacities` | `MemoryCapacities` | Memory capacity limits for each area | For monitoring dashboard display |

## Scheduling Function Examples

### 1. Message Processing and Custom Handlers

The scheduler's most powerful feature is support for registering custom message handlers. You can define specific message types (e.g., `MY_CUSTOM_TASK`) and write functions to handle them.

```python
import uuid
from datetime import datetime

# 1. Import necessary type definitions and scheduler instance
# Note: mem_scheduler needs to be imported from server_router as it's a global singleton
from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem

# Define a custom task label
MY_TASK_LABEL = "MY_CUSTOM_TASK"


# Define a handler function
def my_task_handler(messages: list[ScheduleMessageItem]):
    """
    Function to handle custom tasks
    """
    for msg in messages:
        print(f"⚡️ [Handler] Received task: {msg.item_id}")
        print(f"📦 Content: {msg.content}")
        # Execute your business logic here, e.g., call LLM, write to database, trigger other tasks, etc.


# 2. Register the handler to the scheduler
# This step mounts your custom logic to the scheduling system
mem_scheduler.register_handlers({
    MY_TASK_LABEL: my_task_handler
})

# 3. Submit a task
task = ScheduleMessageItem(
    item_id=str(uuid.uuid4()),
    user_id="user_123",
    mem_cube_id="cube_001",
    label=MY_TASK_LABEL,
    content="This is a test message",
    timestamp=datetime.now()
)

# If the scheduler is not started, the task will be queued for processing
# or in local queue mode may require calling mem_scheduler.start() first
mem_scheduler.submit_messages([task])

print(f"Task submitted: {task.item_id}")

# Prevent scheduler main process from exiting prematurely
time.sleep(10)
```

### 2. Redis Queue vs Local Queue

- **Local Queue**:
  - **Use case**: Unit tests, simple single-machine scripts.
  - **Characteristics**: Fast, but data is lost after process restart; does not support multi-process/multi-instance sharing.
  - **Configuration**: `MOS_SCHEDULER_USE_REDIS_QUEUE=false`

- **Redis Queue (Redis Stream)**:
  - **Use case**: Production environment, distributed deployment.
  - **Characteristics**: Data persistence, supports consumer groups allowing multiple scheduler instances to handle tasks together (load balancing).
  - **Configuration**: `MOS_SCHEDULER_USE_REDIS_QUEUE=true`
  - **Debugging**: Use the `show_redis_status.py` script to check queue accumulation.

## Comprehensive Application Scenarios

### Scenario 1: Basic Conversation Flow and Memory Update

The following is a complete example demonstrating how to initialize the environment, register custom logic, simulate conversation flow, and trigger memory updates.

```python
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# --- Environment Setup ---
# 1. Add project root to sys.path to ensure memos module can be imported
FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

# 2. Set necessary environment variables (simulating .env configuration)
os.environ["ENABLE_CHAT_API"] = "true"
os.environ["MOS_ENABLE_SCHEDULER"] = "true"
# Choose between Redis or Local queue
os.environ["MOS_SCHEDULER_USE_REDIS_QUEUE"] = "false"

# --- Import Components ---
# Note: Importing server_router triggers component initialization,
# ensure environment variables are set before this import
from memos.api.product_models import APIADDRequest, ChatPlaygroundRequest
from memos.api.routers.server_router import (
    add_handler,
    chat_stream_playground,
    mem_scheduler,  # mem_scheduler here is already an initialized singleton
)
from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)

logger = get_logger(__name__)

# Global variable for demonstrating memory retrieval results
working_memories = []

# --- Custom Handlers ---

def custom_query_handler(messages: list[ScheduleMessageItem]):
    """
    Handle user query messages:
    1. Print query content
    2. Convert message to MEM_UPDATE task, triggering memory retrieval/update process
    """
    for msg in messages:
        print(f"\n[Scheduler 🟢] Received user query: {msg.content}")

        # Copy message and change label to MEM_UPDATE, a common "task chaining" pattern
        new_msg = msg.model_copy(update={"label": MEM_UPDATE_TASK_LABEL})

        # Submit new task back to scheduler
        mem_scheduler.submit_messages([new_msg])


def custom_mem_update_handler(messages: list[ScheduleMessageItem]):
    """
    Handle memory update tasks:
    1. Use retriever to find relevant memories
    2. Update global working memory list
    """
    global working_memories
    search_args = {}
    top_k = 2

    for msg in messages:
        print(f"[Scheduler 🔵] Retrieving memories for query...")
        # Call core retrieval functionality
        results = mem_scheduler.retriever.search(
            query=msg.content,
            user_id=msg.user_id,
            mem_cube_id=msg.mem_cube_id,
            mem_cube=mem_scheduler.current_mem_cube,
            top_k=top_k,
            method=mem_scheduler.search_method,
            search_args=search_args,
        )

        # Simulate working memory update
        working_memories.extend(results)
        working_memories = working_memories[-5:] # Keep the latest 5

        for mem in results:
            # Print retrieved memory fragments
            print(f"  ↳ [Memory Found]: {mem.memory[:50]}...")

# --- Mock Business Data ---

def get_mock_data():
    """Generate mock conversation data"""
    conversations = [
        {"role": "user", "content": "I just adopted a golden retriever puppy named Max."},
        {"role": "assistant", "content": "That's exciting! Max is a great name."},
        {"role": "user", "content": "He loves peanut butter treats but I am allergic to nuts."},
        {"role": "assistant", "content": "Noted. Peanut butter for Max, no nuts for you."},
    ]

    questions = [
        {"question": "What is my dog's name?", "category": "Pet"},
        {"question": "What am I allergic to?", "category": "Allergy"},
    ]
    return conversations, questions

# --- Main Flow ---

async def run_demo():
    print("==== MemScheduler Demo Start ====")
    conversations, questions = get_mock_data()

    user_id = "demo_user_001"
    mem_cube_id = "cube_demo_001"

    print(f"1. Initialize user memory library ({user_id})...")
    # Use API Handler to add initial memories (synchronous mode)
    add_req = APIADDRequest(
        user_id=user_id,
        writable_cube_ids=[mem_cube_id],
        messages=conversations,
        async_mode="sync",
    )
    add_handler.handle_add_memories(add_req)
    print("   Memory addition completed.")

    print("\n2. Start conversation testing (triggering background scheduling tasks)...")
    for item in questions:
        query = item["question"]
        print(f"\n>> User: {query}")

        # Initiate chat request
        chat_req = ChatPlaygroundRequest(
            user_id=user_id,
            query=query,
            readable_cube_ids=[mem_cube_id],
            writable_cube_ids=[mem_cube_id],
        )

        # Get streaming response
        response = chat_stream_playground(chat_req)

        # Handle streaming output (simplified)
        full_answer = ""
        buffer = ""
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8")
            buffer += chunk
            while "\n\n" in buffer:
                msg, buffer = buffer.split("\n\n", 1)
                for line in msg.split("\n"):
                    if line.startswith("data: "):
                        try:
                            data = json.loads(line[6:])
                            if data.get("type") == "text":
                                full_answer += data["data"]
                        except: pass

        print(f">> AI: {full_answer}")

        # Wait a moment for background scheduler to process tasks and print logs
        await asyncio.sleep(1)

if __name__ == "__main__":
    # 1. Register our custom handlers
    # This will override or add to the default scheduling logic
    mem_scheduler.register_handlers(
        {
            QUERY_TASK_LABEL: custom_query_handler,
            MEM_UPDATE_TASK_LABEL: custom_mem_update_handler,
        }
    )

    # 2. Ensure scheduler is started
    if not mem_scheduler._running:
        mem_scheduler.start()

    try:
        asyncio.run(run_demo())
    except KeyboardInterrupt:
        pass
    finally:
        # Prevent scheduler main process from exiting prematurely
        time.sleep(10)

        print("\n==== Stopping scheduler ====")
        mem_scheduler.stop()
```

### Scenario 2: Concurrent Asynchronous Tasks and Checkpoint Restart (Redis)

This example demonstrates how to use Redis queues to achieve concurrent asynchronous task processing and checkpoint restart functionality. Running this example requires Redis environment configuration.

```python
from pathlib import Path
from time import sleep

from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


# Debug: Print scheduler configuration
print("=== Scheduler Configuration Debug ===")
print(f"Scheduler type: {type(mem_scheduler).__name__}")
print(f"Config: {mem_scheduler.config}")
print(f"use_redis_queue: {mem_scheduler.use_redis_queue}")
print(f"Queue type: {type(mem_scheduler.memos_message_queue).__name__}")
print(f"Queue maxsize: {getattr(mem_scheduler.memos_message_queue, 'maxsize', 'N/A')}")
print("=====================================\n")

queue = mem_scheduler.memos_message_queue


# Define handler function
def my_test_handler(messages: list[ScheduleMessageItem]):
    print(f"My test handler received {len(messages)} messages: {[one.item_id for one in messages]}")
    for msg in messages:
        # Create file based on task_id (use item_id as numeric ID 0..99)
        task_id = str(msg.item_id)
        file_path = tmp_dir / f"{task_id}.txt"
        try:
            sleep(5)
            file_path.write_text(f"Task {task_id} processed.\n")
            print(f"writing {file_path} done")
        except Exception as e:
            print(f"Failed to write {file_path}: {e}")


def submit_tasks():
    mem_scheduler.memos_message_queue.clear()

    # Create 100 messages (task_id 0..99)
    users = ["user_A", "user_B"]
    messages_to_send = [
        ScheduleMessageItem(
            item_id=str(i),
            user_id=users[i % 2],
            mem_cube_id="test_mem_cube",
            label=TEST_HANDLER_LABEL,
            content=f"Create file for task {i}",
        )
        for i in range(100)
    ]
    # Batch submit messages and print completion info
    print(f"Submitting {len(messages_to_send)} messages to the scheduler...")
    mem_scheduler.memos_message_queue.submit_messages(messages_to_send)
    print(f"Task submission done! tasks in queue: {mem_scheduler.get_tasks_status()}")


# Register handler function
TEST_HANDLER_LABEL = "test_handler"
mem_scheduler.register_handlers({TEST_HANDLER_LABEL: my_test_handler})

# 5 second restart
mem_scheduler.orchestrator.tasks_min_idle_ms[TEST_HANDLER_LABEL] = 5_000

tmp_dir = Path("./tmp")
tmp_dir.mkdir(exist_ok=True)

# Test stop and restart: if tmp has >1 files, skip submission and print info
existing_count = len(list(Path("tmp").glob("*.txt"))) if Path("tmp").exists() else 0
if existing_count > 1:
    print(f"Skip submission: found {existing_count} files in tmp (>1), continue processing")
else:
    submit_tasks()

# Wait until tmp has 100 files or timeout
poll_interval = 1
expected = 100
tmp_dir = Path("tmp")
tasks_status = mem_scheduler.get_tasks_status()
mem_scheduler.print_tasks_status(tasks_status=tasks_status)
while (
    mem_scheduler.get_tasks_status()["remaining"] != 0
    or mem_scheduler.get_tasks_status()["running"] != 0
):
    count = len(list(tmp_dir.glob("*.txt"))) if tmp_dir.exists() else 0
    tasks_status = mem_scheduler.get_tasks_status()
    mem_scheduler.print_tasks_status(tasks_status=tasks_status)
    print(f"[Monitor] Files in tmp: {count}/{expected}")
    sleep(poll_interval)
print(f"[Result] Final files in tmp: {len(list(tmp_dir.glob('*.txt')))})")

# Stop scheduler
sleep(20)
print("Stopping the scheduler...")
mem_scheduler.stop()
```
