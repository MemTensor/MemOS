"""
# Prerequisites:
# 1. Ensure a Redis server is running locally on the default port (6379).
#    You can start it with: `redis-server`
#    On macOS with Homebrew: `/opt/homebrew/bin/redis-server` or `brew services start redis`
#    On Linux: `sudo service redis-server start`
# 2. If Redis is running on a different host/port, update the configuration or environment variables accordingly.
"""

import time

from memos.mem_scheduler.task_schedule_modules.orchestrator import SchedulerOrchestrator
from memos.mem_scheduler.task_schedule_modules.redis_queue import SchedulerRedisQueue


# Explicitly initialize Redis queue for monitoring
queue = SchedulerRedisQueue(
    max_len=None,
    consumer_group="scheduler_group",
    consumer_name="monitor_consumer",
    orchestrator=SchedulerOrchestrator(),
)


def fetch_status(
    queue: SchedulerRedisQueue, stream_key_prefix: str | None = None
) -> dict[str, dict[str, int]]:
    """Fetch and print per-user Redis queue status using built-in API.

    Returns a dict mapping user_id -> {"remaining": int}.
    """
    # This method will also print a summary and per-user counts.
    return queue.show_task_status(stream_key_prefix=stream_key_prefix)


def print_diff(prev: dict[str, dict[str, int]], curr: dict[str, dict[str, int]]) -> None:
    """Print aggregated totals and per-user changes compared to previous snapshot."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    tot_r_prev = sum(v.get("remaining", 0) for v in prev.values()) if prev else 0
    tot_r_curr = sum(v.get("remaining", 0) for v in curr.values())

    dr_tot = tot_r_curr - tot_r_prev

    print(f"[{ts}] Total remaining={tot_r_curr} ({dr_tot:+d})")

    # Print per-user deltas (current counts are already printed by show_task_status)
    all_uids = sorted(set(prev.keys()) | set(curr.keys()))
    for uid in all_uids:
        r_prev = prev.get(uid, {}).get("remaining", 0)
        r_curr = curr.get(uid, {}).get("remaining", 0)
        dr = r_curr - r_prev
        # Only print when there is any change to reduce noise
        if dr != 0:
            print(f"  Δ {uid}: remaining={dr:+d}")


# Note: queue.show_task_status() handles printing per-user counts internally.


def main(interval_sec: float = 5.0, stream_key_prefix: str | None = None) -> None:
    prev: dict[str, dict[str, int]] = {}
    while True:
        try:
            curr = fetch_status(queue, stream_key_prefix=stream_key_prefix)
            print_diff(prev, curr)
            print(f"stream_cache ({len(queue._stream_keys_cache)}): {queue._stream_keys_cache}")
            prev = curr
            time.sleep(interval_sec)
        except KeyboardInterrupt:
            print("Stopped.")
            break
        except Exception as e:
            print(f"Error while fetching status: {e}")
            time.sleep(interval_sec)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--prefix", type=str, default=None)
    args = parser.parse_args()

    main(interval_sec=args.interval, stream_key_prefix=args.prefix)
