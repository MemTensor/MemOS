from memos.api.handlers.scheduler_handler import (
    handle_scheduler_status,
    handle_scheduler_wait,
)
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

mem_scheduler.memos_message_queue.debug_mode_on()
queue = mem_scheduler.memos_message_queue
queue.clear()


# 1. Define a handler function
def my_test_handler(messages: list[ScheduleMessageItem]):
    print(f"My test handler received {len(messages)} messages:")
    for msg in messages:
        print(f" my_test_handler - {msg.item_id}: {msg.content}")
        user_status_running = handle_scheduler_status(
            user_name=USER_MEM_CUBE, mem_scheduler=mem_scheduler, instance_id="api_w_scheduler"
        )
        print(f"[Monitor] Status for {USER_MEM_CUBE} after submit:", user_status_running)


# 2. Register the handler
TEST_HANDLER_LABEL = "test_handler"
mem_scheduler.register_handlers({TEST_HANDLER_LABEL: my_test_handler})

# 2.1 Monitor global scheduler status before submitting tasks
global_status_before = handle_scheduler_status(
    user_name=None, mem_scheduler=mem_scheduler, instance_id="api_w_scheduler"
)
print("[Monitor] Global status before submit:", global_status_before)

# 3. Create messages
messages_to_send = [
    ScheduleMessageItem(
        item_id=f"test_item_{i}",
        user_id="test_user",
        mem_cube_id="test_mem_cube",
        label=TEST_HANDLER_LABEL,
        content=f"This is test message {i}",
    )
    for i in range(5)
]

# 5. Submit messages
for mes in messages_to_send:
    print(f"Submitting message {mes.item_id} to the scheduler...")
    mem_scheduler.memos_message_queue.submit_messages([mes])

# 5.1 Monitor status for specific mem_cube while running
USER_MEM_CUBE = "test_mem_cube"

# 6. Wait for messages to be processed (limited to 100 checks)
print("Waiting for messages to be consumed (max 100 checks)...")
mem_scheduler.mem_scheduler_wait()

# 6.1 Wait until idle for specific mem_cube via handler
wait_result = handle_scheduler_wait(
    user_name=USER_MEM_CUBE,
    timeout_seconds=120.0,
    poll_interval=0.2,
    mem_scheduler=mem_scheduler,
)
print(f"[Monitor] Wait result for {USER_MEM_CUBE}:", wait_result)

# 6.2 Monitor global scheduler status after processing
global_status_after = handle_scheduler_status(
    user_name=None, mem_scheduler=mem_scheduler, instance_id="api_w_scheduler"
)
print("[Monitor] Global status after processing:", global_status_after)

# 7. Stop the scheduler
print("Stopping the scheduler...")
mem_scheduler.stop()
