#!/usr/bin/env python3

"""
Algorithm script that 1:1 replays the online AoTai Hike behavior.
It drives `GameService.act()` end-to-end so memory/search/chat flows
match the runtime server logic.

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

from aotai_hike.adapters.background import StaticBackgroundProvider
from aotai_hike.adapters.companion import MemoryCompanionBrain
from aotai_hike.adapters.memory import MemoryNamespace, MemOSMemoryAdapter, MemOSMemoryClient
from aotai_hike.schemas import (
    ActionType,
    ActRequest,
    Role,
    RoleAttrs,
    RoleUpsertRequest,
    SetActiveRoleRequest,
    WorldState,
)
from aotai_hike.services.game_service import GameService


@dataclass(frozen=True)
class ActionStep:
    action: ActionType
    payload: dict[str, object]
    note: str = ""


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
) -> None:
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


def run_scenario(
    *,
    client: MemOSMemoryClient,
    user_id: str,
    session_id: str,
    steps: list[ActionStep],
) -> list[dict[str, str]]:
    memory = MemOSMemoryAdapter(client)
    companion = MemoryCompanionBrain(memory=client)
    game = GameService(
        memory=memory,
        companion=companion,
        background=StaticBackgroundProvider(),
    )

    roles = build_roles()
    world_state = WorldState(
        session_id=session_id,
        user_id=user_id,
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
    )

    for role in roles:
        game.upsert_role(world_state, RoleUpsertRequest(session_id=session_id, role=role))
    game.set_active_role(
        world_state, SetActiveRoleRequest(session_id=session_id, active_role_id=roles[0].role_id)
    )

    logs: list[dict[str, str]] = []

    for step in steps:
        resp = game.act(
            world_state,
            ActRequest(session_id=session_id, action=step.action, payload=step.payload),
        )
        for msg in resp.messages:
            if msg.kind != "speech":
                continue
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
    parser.add_argument("--output", default="", help="Optional JSONL output path")
    args = parser.parse_args()

    client = MemOSMemoryClient(base_url=args.base_url)
    steps = [
        ActionStep(
            action=ActionType.SAY,
            payload={"text": "大家注意脚下，风有点大。"},
            note="player_say",
        ),
        ActionStep(
            action=ActionType.MOVE_FORWARD,
            payload={"step_km": 1.0},
            note="advance_step",
        ),
    ]

    logs = run_scenario(
        client=client,
        user_id=args.user_id,
        session_id=args.session_id,
        steps=steps,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            for item in logs:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
    else:
        print(json.dumps({"responses": logs}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
