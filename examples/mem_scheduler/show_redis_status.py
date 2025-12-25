import time

from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.task_schedule_modules.redis_queue import SchedulerRedisQueue


queue = mem_scheduler.memos_message_queue.memos_message_queue


def fetch_status(queue: SchedulerRedisQueue) -> dict[str, dict[str, int]]:
    """Fetch and print per-user Redis queue status using built-in API.

    Returns a dict mapping user_id -> {"pending": int, "remaining": int}.
    """
    # This method will also print a summary and per-user counts.
    return queue.show_task_status()


def print_diff(prev: dict[str, dict[str, int]], curr: dict[str, dict[str, int]]) -> None:
    """Print aggregated totals and per-user changes compared to previous snapshot."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    tot_p_prev = sum(v.get("pending", 0) for v in prev.values()) if prev else 0
    tot_r_prev = sum(v.get("remaining", 0) for v in prev.values()) if prev else 0
    tot_p_curr = sum(v.get("pending", 0) for v in curr.values())
    tot_r_curr = sum(v.get("remaining", 0) for v in curr.values())

    dp_tot = tot_p_curr - tot_p_prev
    dr_tot = tot_r_curr - tot_r_prev

    print(f"[{ts}] Total pending={tot_p_curr} ({dp_tot:+d}), remaining={tot_r_curr} ({dr_tot:+d})")

    # Print per-user deltas (current counts are already printed by show_task_status)
    all_uids = sorted(set(prev.keys()) | set(curr.keys()))
    for uid in all_uids:
        p_prev = prev.get(uid, {}).get("pending", 0)
        r_prev = prev.get(uid, {}).get("remaining", 0)
        p_curr = curr.get(uid, {}).get("pending", 0)
        r_curr = curr.get(uid, {}).get("remaining", 0)
        dp = p_curr - p_prev
        dr = r_curr - r_prev
        # Only print when there is any change to reduce noise
        if dp != 0 or dr != 0:
            print(f"  Δ {uid}: pending={dp:+d}, remaining={dr:+d}")


# Note: queue.show_task_status() handles printing per-user counts internally.


def main(interval_sec: float = 5.0) -> None:
    prev: dict[str, dict[str, int]] = {}
    while True:
        try:
            curr = fetch_status(queue)
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
    main()
