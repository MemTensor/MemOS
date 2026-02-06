#!/usr/bin/env python3

"""
Pure algorithm script for AoTai Hike multi-role memory + chat tuning.

Run:
  python -m aotai_hike.scripts.algorithm_tuning \
    --user-id demo_user \
    --session-id demo_session \
    --base-url http://0.0.0.0:8001
"""

from __future__ import annotations

import argparse
import json
import os
import time
import uuid

from dataclasses import dataclass

from aotai_hike.adapters.companion import MemoryChatConfig, MemoryCompanionBrain
from aotai_hike.adapters.memory import MemoryNamespace, MemOSMemoryClient
from aotai_hike.schemas import Role, RoleAttrs, WorldState


@dataclass(frozen=True)
class ActionStep:
    user_text: str
    user_action: str
    world_event: str


def _now_str() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())


def build_roles() -> list[Role]:
    return [
        Role(
            role_id="r_ao",
            name="阿鳌",
            avatar_key="green",
            persona="阿鳌：队伍领队，路线熟悉，偏谨慎。",
            attrs=RoleAttrs(stamina=75, mood=58, experience=35, risk_tolerance=35),
        ),
        Role(
            role_id="r_tb",
            name="太白",
            avatar_key="blue",
            persona="太白：装备党，喜欢记录数据与天气变化。",
            attrs=RoleAttrs(stamina=68, mood=62, experience=42, risk_tolerance=45),
        ),
        Role(
            role_id="r_xs",
            name="小山",
            avatar_key="red",
            persona="小山：乐观的新人徒步者，敢想敢冲但听劝。",
            attrs=RoleAttrs(stamina=70, mood=72, experience=12, risk_tolerance=65),
        ),
    ]


def seed_memories(
    *,
    client: MemOSMemoryClient,
    user_id: str,
    session_id: str,
    world_cube_id: str,
    role_cube_ids: dict[str, str],
    dry_run: bool,
) -> None:
    if dry_run:
        return

    client.add_memory(
        user_id=user_id,
        cube_id=world_cube_id,
        session_id=session_id,
        async_mode="sync",
        mode="fine",
        memory_content="队伍即将进入多云、有风的上坡路段。",
        source="aotai_hike_seed",
    )
    client.add_memory(
        user_id=user_id,
        cube_id=role_cube_ids["r_tb"],
        session_id=session_id,
        async_mode="sync",
        mode="fine",
        memory_content="太白喜欢记录温度、风速，并提醒大家补水。",
        source="aotai_hike_seed",
    )


def add_world_event(
    *,
    client: MemOSMemoryClient,
    user_id: str,
    session_id: str,
    world_cube_id: str,
    event_text: str,
    dry_run: bool,
) -> None:
    if dry_run:
        return
    client.add_memory(
        user_id=user_id,
        cube_id=world_cube_id,
        session_id=session_id,
        async_mode="sync",
        mode="fine",
        memory_content=event_text,
        source="aotai_hike_event",
    )


def append_chat_history(history: list[dict[str, str]], role: str, content: str) -> None:
    history.append({"role": role, "content": content, "chat_time": _now_str()})


def run_scenario(
    *,
    client: MemOSMemoryClient,
    user_id: str,
    session_id: str,
    steps: list[ActionStep],
    dry_run: bool,
) -> list[dict[str, str]]:
    roles = build_roles()
    world_state = WorldState(
        session_id=session_id,
        user_id=user_id,
        active_role_id=roles[0].role_id,
        roles=roles,
        weather="windy",
        time_of_day="afternoon",
        current_node_id="start",
        recent_events=[],
        chat_history=[],
    )

    role_cube_ids = {
        role.role_id: MemoryNamespace.role_cube_id(user_id=user_id, role_id=role.role_id)
        for role in roles
    }
    world_cube_id = MemoryNamespace.world_cube_id(user_id=user_id)

    seed_memories(
        client=client,
        user_id=user_id,
        session_id=session_id,
        world_cube_id=world_cube_id,
        role_cube_ids=role_cube_ids,
        dry_run=dry_run,
    )

    brain = MemoryCompanionBrain(
        memory=client,
        config=MemoryChatConfig(memory_top_k=5, history_max_items=20, mode="fine"),
        seed=42,
    )

    logs: list[dict[str, str]] = []

    for step in steps:
        append_chat_history(world_state.chat_history, "user", step.user_text)
        add_world_event(
            client=client,
            user_id=user_id,
            session_id=session_id,
            world_cube_id=world_cube_id,
            event_text=step.world_event,
            dry_run=dry_run,
        )

        world_memories = client.search_memory(
            user_id=user_id,
            cube_id=world_cube_id,
            query=step.user_action,
            top_k=5,
            mode="fine",
            session_id=session_id,
        ).snippets

        output = brain.generate(
            world_state=world_state,
            active_role=roles[0],
            memory_snippets=world_memories,
            user_action=step.user_action,
        )

        for msg in output.messages:
            if msg.kind != "speech":
                continue
            append_chat_history(world_state.chat_history, "assistant", msg.content)
            logs.append(
                {
                    "role_id": msg.role_id or "",
                    "role_name": msg.role_name or "",
                    "content": msg.content,
                    "chat_time": _now_str(),
                }
            )

    return logs


def main() -> None:
    parser = argparse.ArgumentParser(description="AoTai Hike memory+chat tuning script")
    parser.add_argument("--user-id", default="demo_user")
    parser.add_argument("--session-id", default=f"algo-{uuid.uuid4().hex[:6]}")
    parser.add_argument(
        "--base-url", default=os.getenv("MEMOS_API_BASE_URL", "http://0.0.0.0:8001")
    )
    parser.add_argument("--dry-run", action="store_true", help="Skip add_memory writes")
    parser.add_argument("--output", default="", help="Optional JSONL output path")
    args = parser.parse_args()

    client = MemOSMemoryClient(base_url=args.base_url)
    steps = [
        ActionStep(
            user_text="大家注意脚下，风有点大。",
            user_action="SAY:大家注意脚下，风有点大。",
            world_event="队伍提醒注意脚下，风力增强。",
        ),
        ActionStep(
            user_text="我们继续保持速度，别走散。",
            user_action="MOVE_FORWARD:keep_pace",
            world_event="队伍继续前进，保持队形。",
        ),
    ]

    logs = run_scenario(
        client=client,
        user_id=args.user_id,
        session_id=args.session_id,
        steps=steps,
        dry_run=args.dry_run,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            for item in logs:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
    else:
        print(json.dumps({"responses": logs}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
