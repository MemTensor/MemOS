#!/usr/bin/env python3
"""Exercise project Add through its product HTTP routes using isolated synthetic Spaces."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from uuid import NAMESPACE_URL, uuid4, uuid5

import httpx


USER = "promem_smoke"
PROJECT = "local-project"
DOMAIN = "本地验收"
DECISION = (
    "决定了：蓝莓构建的验证报告保留 14 天，索引写入 artifacts/blueberry/reports.json。",
    "收到。蓝莓构建的验证报告保留 14 天，索引写入 artifacts/blueberry/reports.json。",
)
EXPERIENCE = (
    "这次已经验证：蓝莓构建报告的索引写到临时文件，校验成功后再原子重命名。"
    "直接覆盖索引时进程重启会留下半个 JSON。请把验证过的做法记入项目经验。",
    "已用中断重启验证，临时文件校验后原子重命名可避免读到不完整的 JSON。",
)


class SmokeError(Exception):
    """A product response violated a smoke assertion."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def response_data(response: httpx.Response) -> dict | list:
    response.raise_for_status()
    body = response.json()
    require(body.get("code") == 200, f"{response.request.url.path} did not succeed: {body}")
    return body["data"]


def post(client: httpx.Client, path: str, payload: dict) -> dict | list:
    return response_data(client.post(path, json=payload))


def task_status(client: httpx.Client, task_id: str) -> dict:
    response = client.get("/product/scheduler/status", params={"user_id": USER, "task_id": task_id})
    return response_data(response)[0]


def project_result(status: dict) -> dict:
    return status["memory_views"]["project"]


def report_metrics(task_id: str, step: str, state: dict, out: list[dict] | None) -> None:
    """Print the server's timing and attributed usage for one finished Add."""
    metrics = project_result(state)["metrics"]
    episodes = metrics["episodes"]
    usage = metrics["usage"]
    totals = {
        name: sum(episode[name] or 0 for episode in episodes)
        for name in ("queue_ms", "run_ms", "retry_wait_ms")
    }
    print(
        f"METRIC {step} task={task_id} latency_ms={metrics['latency_ms']} "
        f"close_wait_ms={metrics['close_wait_ms']} processing_ms={metrics['processing_ms']} "
        # Episodes of different Spaces run in parallel, so these sums can exceed latency_ms.
        + " ".join(f"sum_{name}={value}" for name, value in totals.items())
        + f" episodes={len(episodes)} total_tokens={usage['total_tokens']} "
        f"usage_complete={usage['complete']}"
    )
    if out is not None:
        out.append({"step": step, "task_id": task_id, **metrics})


def wait_closed(
    client: httpx.Client,
    task_id: str,
    timeout: float,
    *,
    step: str = "",
    metrics: list[dict] | None = None,
) -> dict:
    """Wait until the server reports the Add complete: every Episode holding it has finished.

    Status alone reads completed while an Episode is still collecting Turns, so completion is
    taken from `metrics.completed_at`, and an open Episode must also report no open messages.
    """
    deadline = time.monotonic() + timeout
    while True:
        state = task_status(client, task_id)
        require(state["status"] != "failed", f"Project Add failed: {project_result(state)}")
        result = project_result(state)
        if (
            state["status"] == "completed"
            and result["open_episode_messages"] == 0
            and result["metrics"]["completed_at"]
        ):
            report_metrics(task_id, step or task_id, state, metrics)
            return state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SmokeError(f"Task {task_id} did not finish a closed Episode: {state}")
        time.sleep(min(0.5, remaining))


def payload(
    run_id: str,
    step: str,
    texts: tuple[str, str],
    spaces: list[str],
    chat_time: datetime,
    *,
    conversation_id: str | None = None,
    sync: bool = False,
) -> dict:
    task_id = str(uuid5(NAMESPACE_URL, f"{run_id}/{step}"))
    return {
        "task_id": task_id,
        "user_id": USER,
        "project_id": PROJECT,
        "allow_memory_view": ["project"],
        "space_ids": spaces,
        "domains": [DOMAIN],
        "async_mode": "sync" if sync else "async",
        **({"conversation_id": conversation_id} if conversation_id else {}),
        "messages": [
            {
                "message_id": f"{task_id}:{role}",
                "role": role,
                "content": text,
                "chat_time": (chat_time + timedelta(seconds=order)).isoformat(),
            }
            for order, (role, text) in enumerate(zip(("user", "assistant"), texts, strict=True))
        ],
    }


def add(client: httpx.Client, body: dict) -> dict:
    row = post(client, "/product/add", body)[0]
    require(row["memory_view"] == "project", "Add response did not contain project memory")
    require(row["status"] in {"running", "completed"}, f"Add failed: {row}")
    return row


def assert_open(client: httpx.Client, task_id: str) -> None:
    state = task_status(client, task_id)
    require(state["status"] == "completed", f"Open Episode should remain buffered: {state}")
    count = project_result(state)["open_episode_messages"]
    require(count == 2, f"One Turn in two Spaces should report two open messages, got {count}")
    metrics = project_result(state)["metrics"]
    require(metrics["completed_at"] is None, f"An open Episode reported completion: {metrics}")


def assert_source(
    client: httpx.Client, conversation: str, spaces: list[str], turns: list[dict]
) -> None:
    original = [message for turn in turns for message in turn["messages"]]
    expected = [(message["message_id"], message["content"]) for message in original]
    for scope in [{}, *({"space_id": space} for space in spaces)]:
        data = post(client, "/product/get_message", {"conversation_id": conversation, **scope})
        replayed = [(item["message_id"], item["content"]) for item in data["message_detail_list"]]
        require(replayed == expected, "Original messages were duplicated, omitted or changed")


def run_smoke(
    client: httpx.Client,
    peer: httpx.Client,
    *,
    scenario: str,
    wait_seconds: float,
    keep: bool,
    require_topic: bool,
    metrics: list[dict] | None = None,
) -> None:
    for endpoint in (client, peer):
        endpoint.get("/health").raise_for_status()
    run_id = f"promem-smoke-{uuid4().hex}"
    conversation = f"{run_id}:conversation"
    now = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=1)
    spaces: list[str] = []
    topic_ids: set[str] = set()
    try:
        for index, endpoint in enumerate((client, peer), 1):
            space = post(
                endpoint,
                "/product/create_space",
                {
                    "project_id": PROJECT,
                    "space_name": f"{run_id}-{index}",
                    "domains": [{"name": DOMAIN}],
                },
            )
            spaces.append(space["space_id"])

        fixtures = {
            "decision": [DECISION],
            "experience": [EXPERIENCE],
            "all": [DECISION, EXPERIENCE],
        }
        for index, texts in enumerate(fixtures[scenario], 1):
            one_shot = payload(run_id, f"standalone-{index}", texts, spaces, now, sync=True)
            receipt = add(client, one_shot)
            require(receipt["task_id"] == one_shot["task_id"], "Standalone Task ID changed")
            result = wait_closed(
                peer, receipt["task_id"], wait_seconds, step=f"standalone-{index}", metrics=metrics
            )
            topic_ids.update(project_result(result)["memory_ids"])
        print("PASS standalone Add closed in both Spaces")

        first = payload(run_id, "open", DECISION, spaces, now, conversation_id=conversation)
        task = add(client, first)["task_id"]
        assert_open(peer, task)
        replay = {**first, "task_id": str(uuid4())}
        require(add(peer, replay)["task_id"] == task, "Exact replay returned a new Task ID")
        assert_source(client, conversation, spaces, [first])

        conflicting = deepcopy(replay)
        conflicting["messages"][0]["content"] += " 同一个 ID 的正文发生变化。"
        rejected = peer.post("/product/add", json=conflicting)
        require(rejected.status_code == 409, f"Conflicting replay returned {rejected.status_code}")
        foreign = peer.get(
            "/product/scheduler/status", params={"user_id": "promem_smoke_other", "task_id": task}
        )
        require(foreign.status_code == 404, f"Unowned Task returned {foreign.status_code}")
        print("PASS shared open receipt, source deduplication, replay conflict and owner isolation")

        end = payload(
            run_id,
            "end",
            ("到此为止。", "收到。"),
            spaces,
            now + timedelta(seconds=4),
            conversation_id=conversation,
        )
        ending = add(peer, end)["task_id"]
        completed = wait_closed(client, task, wait_seconds, step="open", metrics=metrics)
        topic_ids.update(project_result(completed)["memory_ids"])
        wait_closed(client, ending, wait_seconds, step="end", metrics=metrics)
        continued = payload(
            run_id,
            "continued",
            (
                "补充刚才的决定：蓝莓构建的验证报告改为保留 21 天。索引路径不变。",
                "收到，验证报告保留 21 天，索引路径保持原样。",
            ),
            spaces,
            now + timedelta(seconds=8),
            conversation_id=conversation,
        )
        new_task = add(client, continued)["task_id"]
        require(new_task != task, "Continuing the conversation reused the closed Task")
        assert_open(peer, new_task)
        require(
            project_result(task_status(peer, task))["open_episode_messages"] == 0,
            "Closed Task reopened",
        )
        assert_source(peer, conversation, spaces, [first, end, continued])
        print("PASS explicit Episode closure and same-conversation continuation")

        if require_topic:
            for space in spaces:
                memory = post(peer, "/product/get_memory", {"space_id": space})
                topics = [t for t in memory["topic_detail_list"] if t["id"] in topic_ids]
                require(bool(topics), f"No committed Topic for Space {space}")
                expected = topics[0]
                recalled = post(
                    peer,
                    "/product/search",
                    {
                        "user_id": USER,
                        "space_ids": [space],
                        "conversation_id": f"{run_id}:recall",
                        "include_memory_view": ["project"],
                        "query": expected["topic_name"],
                    },
                )
                require(
                    any(t["id"] == expected["id"] for t in recalled["topic_detail_list"]),
                    f"Search did not return the committed Topic in Space {space}",
                )
            print("PASS committed Topics retrieved from another conversation in both Spaces")
    finally:
        if keep:
            print(f"Scratch Spaces: {', '.join(spaces)}")
        else:
            for space in spaces:
                try:
                    post(client, "/product/delete_space", {"space_id": space})
                except (httpx.HTTPError, SmokeError, ValueError) as exc:
                    print(f"Could not clean scratch Space {space}: {exc}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8000")
    parser.add_argument("--peer", help="second API endpoint sharing PostgreSQL and Redis")
    parser.add_argument("--scenario", default="all", choices=["all", "decision", "experience"])
    parser.add_argument("--timeout", type=float, default=180, help="HTTP request timeout (seconds)")
    parser.add_argument("--wait", type=float, default=240, help="closed Episode timeout (seconds)")
    parser.add_argument("--keep", action="store_true", help="retain the scratch Spaces")
    parser.add_argument(
        "--require-topic", action="store_true", help="also require both Topics to commit"
    )
    parser.add_argument(
        "--metrics-out", help="write each finished Add's server metrics as JSON lines to this file"
    )
    args = parser.parse_args()
    metrics: list[dict] | None = [] if args.metrics_out else None
    headers = (
        {"Authorization": f"Bearer {token}"} if (token := os.getenv("MEMOS_SMOKE_TOKEN")) else {}
    )
    try:
        with (
            httpx.Client(base_url=args.base, timeout=args.timeout, headers=headers) as client,
            httpx.Client(
                base_url=args.peer or args.base, timeout=args.timeout, headers=headers
            ) as peer,
        ):
            run_smoke(
                client,
                peer,
                scenario=args.scenario,
                wait_seconds=args.wait,
                keep=args.keep,
                require_topic=args.require_topic,
                metrics=metrics,
            )
    except (httpx.HTTPError, KeyError, SmokeError, ValueError) as exc:
        print(f"FAIL project-memory smoke: {exc}", file=sys.stderr)
        return 1
    finally:
        if metrics:
            with open(args.metrics_out, "w", encoding="utf-8") as handle:
                for row in metrics:
                    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
