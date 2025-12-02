import sys

from collections import defaultdict
from pathlib import Path

from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))


def make_message(user_id: str, mem_cube_id: str, label: str, idx: int | str) -> ScheduleMessageItem:
    return ScheduleMessageItem(
        item_id=f"{user_id}:{mem_cube_id}:{label}:{idx}",
        user_id=user_id,
        mem_cube_id=mem_cube_id,
        label=label,
        content=f"msg-{idx} for {user_id}/{mem_cube_id}/{label}",
    )


def seed_messages_for_test_fairness(queue, combos, per_stream):
    # send overwhelm message by one user
    (u, c, label) = combos[0]
    task_target = 100
    print(f"{u}:{c}:{label} submit {task_target} messages")
    for i in range(task_target):
        msg = make_message(u, c, label, f"overwhelm_{i}")
        queue.submit_messages(msg)

    for u, c, label in combos:
        print(f"{u}:{c}:{label} submit {per_stream} messages")
        for i in range(per_stream):
            msg = make_message(u, c, label, i)
            queue.submit_messages(msg)
    print("======= seed_messages Done ===========")


def count_by_stream(messages):
    counts = defaultdict(int)
    for m in messages:
        key = f"{m.user_id}:{m.mem_cube_id}:{m.label}"
        counts[key] += 1
    return counts


def run_fair_redis_schedule(batch_size: int = 3):
    print("=== Redis Fairness Demo ===")
    print(f"use_redis_queue: {mem_scheduler.use_redis_queue}")
    mem_scheduler.consume_batch = batch_size
    queue = mem_scheduler.memos_message_queue

    # Isolate and clear queue
    queue.clear()

    # Define multiple streams: (user_id, mem_cube_id, task_label)
    combos = [
        ("u1", "u1", "labelX"),
        ("u1", "u1", "labelY"),
        ("u2", "u2", "labelX"),
        ("u2", "u2", "labelY"),
    ]
    per_stream = 5

    # Seed messages evenly across streams
    seed_messages_for_test_fairness(queue, combos, per_stream)

    # Compute target batch size (fair split across streams)
    print(f"Request batch_size={batch_size} for {len(combos)} streams")

    for _ in range(len(combos)):
        # Fetch one brokered pack
        msgs = queue.get_messages(batch_size=batch_size)
        print(f"Fetched {len(msgs)} messages in first pack")

        # Check fairness: counts per stream
        counts = count_by_stream(msgs)
        for k in sorted(counts):
            print(f"{k}: {counts[k]}")


if __name__ == "__main__":
    # task 1 fair redis schedule
    run_fair_redis_schedule()
