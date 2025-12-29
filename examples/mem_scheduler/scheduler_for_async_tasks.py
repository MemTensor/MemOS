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


# Define a handler function
def my_test_handler(messages: list[ScheduleMessageItem]):
    print(f"My test handler received {len(messages)} messages: {[one.item_id for one in messages]}")
    for msg in messages:
        # Create a file named by task_id (use item_id as numeric id 0..99)
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
    # Submit messages in batch and print completion
    print(f"Submitting {len(messages_to_send)} messages to the scheduler...")
    mem_scheduler.memos_message_queue.submit_messages(messages_to_send)
    print(f"Task submission done! tasks in queue: {mem_scheduler.get_tasks_status()}")


# Register the handler
TEST_HANDLER_LABEL = "test_handler"
mem_scheduler.register_handlers({TEST_HANDLER_LABEL: my_test_handler})

# 10s to restart
mem_scheduler.orchestrator.tasks_min_idle_ms[TEST_HANDLER_LABEL] = 5_000

tmp_dir = Path("./tmp")
tmp_dir.mkdir(exist_ok=True)

# Test stop-and-restart: if tmp already has >1 files, skip submission and print info
existing_count = len(list(Path("tmp").glob("*.txt"))) if Path("tmp").exists() else 0
if existing_count > 1:
    print(f"Skip submission: found {existing_count} files in tmp (>1), continue processing")
else:
    submit_tasks()

# 6. Wait until tmp has 100 files or timeout
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

# 7. Stop the scheduler
sleep(20)
print("Stopping the scheduler...")
mem_scheduler.stop()
