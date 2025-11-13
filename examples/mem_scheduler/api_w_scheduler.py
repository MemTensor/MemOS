from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


# Debug: Print scheduler configuration
print("=== Scheduler Configuration Debug ===")
print(f"Scheduler type: {type(mem_scheduler).__name__}")
print(f"Config: {mem_scheduler.config}")
print(f"use_redis_queue: {mem_scheduler.use_redis_queue}")
print(f"Queue type: {type(mem_scheduler.memos_message_queue).__name__}")
print(f"Queue maxsize: {getattr(mem_scheduler.memos_message_queue, 'maxsize', 'N/A')}")

# Check if Redis queue is connected
if hasattr(mem_scheduler.memos_message_queue, "_is_connected"):
    print(f"Redis connected: {mem_scheduler.memos_message_queue._is_connected}")
if hasattr(mem_scheduler.memos_message_queue, "_redis_conn"):
    print(f"Redis connection: {mem_scheduler.memos_message_queue._redis_conn}")
print("=====================================\n")

queue = mem_scheduler.memos_message_queue
queue.clear()


# 1. Define a handler function
def my_test_handler(messages: list[ScheduleMessageItem]):
    print(f"My test handler received {len(messages)} messages:")
    for msg in messages:
        print(f" my_test_handler - {msg.item_id}: {msg.content}")
        print(
            f"{queue._redis_conn.xinfo_groups(queue.stream_name)} qsize: {queue.qsize()} messages:{messages}"
        )


# 2. Register the handler
TEST_HANDLER_LABEL = "test_handler"
mem_scheduler.register_handlers({TEST_HANDLER_LABEL: my_test_handler})

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
    mem_scheduler.submit_messages([mes])

# 6. Wait for messages to be processed (limited to 100 checks)
print("Waiting for messages to be consumed (max 100 checks)...")
mem_scheduler.mem_scheduler_wait()


# 7. Stop the scheduler
print("Stopping the scheduler...")
mem_scheduler.stop()
