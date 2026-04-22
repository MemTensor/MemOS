import os
import time

import requests

from dotenv import load_dotenv


def wait_until_completed(params: dict, interval: float = 2.0, timeout: float = 600.0):
    """
    Keep polling /product/scheduler/status until status == 'completed' (or terminal).

    params: dict passed as query params, e.g. {"user_id": "xxx"} or {"user_id": "xxx", "task_id": "..."}
    interval: seconds between polls
    timeout: max seconds to wait before raising TimeoutError
    """
    load_dotenv()
    base_url = os.getenv("MEMOS_URL")
    if not base_url:
        raise RuntimeError("MEMOS_URL not set in environment")

    url = f"{base_url}/product/scheduler/status"
    start = time.time()
    active_states = {"waiting", "pending", "in_progress"}

    while True:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()

        items = data.get("data", []) if isinstance(data, dict) else []
        statuses = [item.get("status") for item in items if isinstance(item, dict)]
        status_set = set(statuses)

        # Print current status snapshot
        print(f"Current status: {status_set or 'empty'}")

        # Completed if no active states remain
        if not status_set or status_set.isdisjoint(active_states):
            print("Task completed!")
            return data

        if (time.time() - start) > timeout:
            raise TimeoutError(f"Timeout after {timeout}s; last statuses={status_set or 'empty'}")

        time.sleep(interval)


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--user_id", default="longbench_v2_0_long-bench-v2-1208-2119-async", help="User ID to query"
    )
    parser.add_argument("--task_id", help="Optional task_id to query")
    parser.add_argument("--interval", type=float, default=2.0, help="Poll interval seconds")
    parser.add_argument("--timeout", type=float, default=600.0, help="Timeout seconds")
    args = parser.parse_args()

    params = {"user_id": args.user_id}
    if args.task_id:
        params["task_id"] = args.task_id

    result = wait_until_completed(params, interval=args.interval, timeout=args.timeout)
    print(json.dumps(result, indent=2, ensure_ascii=False))
