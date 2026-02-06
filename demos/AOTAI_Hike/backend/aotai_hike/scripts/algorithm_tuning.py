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


class LoggingMemoryClient:
    def __init__(self, base: MemOSMemoryClient, *, user_id: str):
        self._base = base
        self._user_id = user_id

    def add_memory(self, **kwargs):
        cube_id = str(kwargs.get("cube_id") or "")
        messages = kwargs.get("messages") or []
        mem_text = ""
        if messages:
            mem_text = "; ".join(
                f"{m.get('role')}: {m.get('content')}" for m in messages if isinstance(m, dict)
            )
        print(f"[mem:add] cube={cube_id} content={mem_text[:160]}")
        return self._base.add_memory(**kwargs)

    def search_memory(self, **kwargs):
        cube_id = str(kwargs.get("cube_id") or "")
        query = kwargs.get("query") or ""
        print(f"[mem:search] cube={cube_id} query={query}")
        result = self._base.search_memory(**kwargs)
        snippet_preview = " | ".join(s[:80] for s in result.snippets[:5])
        print(f"[mem:search] hits={len(result.snippets)} snippets={snippet_preview}")
        return result

    def chat_complete(self, **kwargs):
        cube_id = str(kwargs.get("cube_id") or "")
        query = kwargs.get("query") or ""
        print(f"[mem:chat] cube={cube_id} query={query}")
        response = self._base.chat_complete(**kwargs)
        print(f"[mem:chat] response={response[:200]}{'…' if len(response) > 200 else ''}")
        return response

    def __getattr__(self, item):
        return getattr(self._base, item)


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
    print("[seed] writing initial memories...")
    client.add_memory(
        user_id=user_id,
        cube_id=world_cube_id,
        session_id=session_id,
        async_mode="sync",
        mode="fine",
        messages=[{"role": "user", "content": "队伍即将进入多云、有风的上坡路段。"}],
        source="aotai_hike_seed",
    )
    client.add_memory(
        user_id=user_id,
        cube_id=role_cube_ids["r_tb"],
        session_id=session_id,
        async_mode="sync",
        mode="fine",
        messages=[{"role": "user", "content": "太白喜欢记录温度、风速，并提醒大家补水。"}],
        source="aotai_hike_seed",
    )
    print("[seed] done.")


def run_scenario(
    *,
    client: MemOSMemoryClient,
    user_id: str,
    session_id: str,
    steps: list[ActionStep],
) -> list[dict[str, str]]:
    print(f"[init] user_id={user_id} session_id={session_id}")
    logging_client = LoggingMemoryClient(client, user_id=user_id)
    memory = MemOSMemoryAdapter(logging_client)
    companion = MemoryCompanionBrain(memory=logging_client)
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
        client=logging_client,
        user_id=user_id,
        session_id=session_id,
        world_cube_id=world_cube_id,
        role_cube_ids=role_cube_ids,
    )
    print(f"[init] roles={len(roles)} active_role={roles[0].role_id}")

    for role in roles:
        game.upsert_role(world_state, RoleUpsertRequest(session_id=session_id, role=role))
    game.set_active_role(
        world_state, SetActiveRoleRequest(session_id=session_id, active_role_id=roles[0].role_id)
    )

    logs: list[dict[str, str]] = []

    for idx, step in enumerate(steps, start=1):
        print(
            f"[step {idx}] action={step.action} payload={json.dumps(step.payload, ensure_ascii=False)}"
        )
        resp = game.act(
            world_state,
            ActRequest(session_id=session_id, action=step.action, payload=step.payload),
        )
        print(
            f"[step {idx}] messages={len(resp.messages)} phase={resp.world_state.phase} "
            f"time={resp.world_state.time_of_day} weather={resp.world_state.weather}"
        )
        for msg in resp.messages:
            if msg.kind != "speech":
                continue
            print(
                f"[npc] {msg.role_name or msg.role_id}: {msg.content[:120]}"
                f"{'…' if len(msg.content) > 120 else ''}"
            )
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
        "--base-url", default=os.getenv("MEMOS_API_BASE_URL", "http://0.0.0.0:8002")
    )
    parser.add_argument("--output", default="", help="Optional JSONL output path")
    args = parser.parse_args()

    print(f"[config] base_url={args.base_url}")
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
