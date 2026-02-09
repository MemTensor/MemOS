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
import sys
import time
import uuid

from dataclasses import dataclass

from loguru import logger

from aotai_hike.adapters.background import StaticBackgroundProvider
from aotai_hike.adapters.companion import MemoryCompanionBrain
from aotai_hike.adapters.memory import (
    MemoryNamespace,
    MemorySearchResult,
    MemOSMemoryAdapter,
    MemOSMemoryClient,
)
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
    def __init__(self, base: MemOSMemoryClient, *, user_id: str, log_world_search: bool):
        self._base = base
        self._user_id = user_id
        self._log_world_search = log_world_search

    def add_memory(self, **kwargs):
        cube_id = str(kwargs.get("cube_id") or "")
        payload = {
            "user_id": kwargs.get("user_id") or self._user_id,
            "writable_cube_ids": [cube_id],
            "mem_cube_id": cube_id,
            "async_mode": kwargs.get("async_mode") or "sync",
        }
        if kwargs.get("session_id"):
            payload["session_id"] = kwargs.get("session_id")
        if kwargs.get("mode"):
            payload["mode"] = kwargs.get("mode")
        if kwargs.get("memory_content"):
            payload["memory_content"] = kwargs.get("memory_content")
        if kwargs.get("messages"):
            payload["messages"] = kwargs.get("messages")
        if kwargs.get("chat_history") is not None:
            payload["chat_history"] = kwargs.get("chat_history")
        if kwargs.get("info"):
            payload["info"] = kwargs.get("info")
        if kwargs.get("custom_tags"):
            payload["custom_tags"] = kwargs.get("custom_tags")
        if kwargs.get("source"):
            payload["source"] = kwargs.get("source")
        resp = self._base._post("/product/add", payload)
        logger.info(
            "[mem:add to cube: {}] response={}",
            cube_id,
            json.dumps(resp, ensure_ascii=False),
        )
        return resp

    def search_memory(self, **kwargs):
        cube_id = str(kwargs.get("cube_id") or "")
        query = kwargs.get("query") or ""
        suppress = (not self._log_world_search) and cube_id.endswith("_world")
        payload = {
            "user_id": kwargs.get("user_id") or self._user_id,
            "query": query,
            "top_k": kwargs.get("top_k")
            if kwargs.get("top_k") is not None
            else getattr(self._base, "_default_top_k", 5),
            "readable_cube_ids": [cube_id],
            "mem_cube_id": cube_id,
            "include_skill_memory": False,
            "include_preference": False,
            "mode": kwargs.get("mode") or getattr(self._base, "_default_mode", "fine"),
        }
        if kwargs.get("session_id"):
            payload["session_id"] = kwargs.get("session_id")
        data = self._base._post("/product/search", payload)
        snippets: list[str] = []
        try:
            mem_data = (data or {}).get("data", {})
            for entry in mem_data.get("text_mem", []) or []:
                for mem in entry.get("memories", []) or []:
                    text = mem.get("memory")
                    if text:
                        snippets.append(text)
        except Exception:
            snippets = []
        snippet_preview = " | ".join(s[:300] for s in snippets[:5])
        if not suppress:
            logger.info(
                "[mem:search from cube: {}] hits={} query={} snippets={}",
                cube_id,
                len(snippets),
                query,
                snippet_preview,
            )
        return MemorySearchResult(snippets=snippets)

    def chat_complete(self, **kwargs):
        cube_id = str(kwargs.get("cube_id") or "")
        query = kwargs.get("query") or ""
        payload = {
            "user_id": kwargs.get("user_id") or self._user_id,
            "query": query,
            "readable_cube_ids": [cube_id],
            "writable_cube_ids": [cube_id],
            "mem_cube_id": cube_id,
            "top_k": max(1, int(kwargs.get("top_k") or 1)),
            "mode": kwargs.get("mode") or getattr(self._base, "_default_mode", "fine"),
            "add_message_on_answer": kwargs.get("add_message_on_answer", False),
        }
        if kwargs.get("system_prompt"):
            payload["system_prompt"] = kwargs.get("system_prompt")
        if kwargs.get("history") is not None:
            payload["history"] = kwargs.get("history")
        if kwargs.get("session_id"):
            payload["session_id"] = kwargs.get("session_id")
        if kwargs.get("model_name_or_path"):
            payload["model_name_or_path"] = kwargs.get("model_name_or_path")
        if kwargs.get("temperature") is not None:
            payload["temperature"] = kwargs.get("temperature")
        if kwargs.get("max_tokens") is not None:
            payload["max_tokens"] = kwargs.get("max_tokens")
        data = self._base._post("/product/chat/complete", payload)
        response = ((data or {}).get("data") or {}).get("response") or ""
        logger.info(
            "[mem:chat with cube: {}] prompt={} output={}{}",
            cube_id,
            (kwargs.get("system_prompt") or "")[:200],
            response[:200],
            "…" if len(response) > 200 else "",
        )
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
    logger.info("[seed] writing initial memories...")
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


def run_scenario(
    *,
    client: MemOSMemoryClient,
    user_id: str,
    session_id: str,
    max_steps: int,
    log_world_search: bool,
) -> list[dict[str, str]]:
    logger.info("[init] user_id={} session_id={}", user_id, session_id)
    logging_client = LoggingMemoryClient(client, user_id=user_id, log_world_search=log_world_search)
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
    logger.info("[init] roles={} active_role={}", len(roles), roles[0].role_id)

    for role in roles:
        game.upsert_role(world_state, RoleUpsertRequest(session_id=session_id, role=role))
    game.set_active_role(
        world_state, SetActiveRoleRequest(session_id=session_id, active_role_id=roles[0].role_id)
    )

    logs: list[dict[str, str]] = []
    action_queue: list[ActionStep] = []

    for idx in range(1, max_steps + 1):
        if not action_queue:
            phase = str(getattr(world_state.phase, "value", world_state.phase) or "free").lower()
            if phase == "free":
                action_queue.append(
                    ActionStep(action=ActionType.CONTINUE, payload={}, note="auto_continue")
                )
            elif phase in ("await_player_say", "night_wait_player"):
                say_text = ""
                while not say_text:
                    say_text = input("[input] SAY> ").strip()
                action_queue.append(
                    ActionStep(
                        action=ActionType.SAY,
                        payload={"text": say_text},
                        note="player_say",
                    )
                )
            elif phase == "night_vote_ready":
                leader_id = world_state.leader_role_id or world_state.active_role_id
                if not leader_id and world_state.roles:
                    leader_id = world_state.roles[0].role_id
                action_queue.append(
                    ActionStep(
                        action=ActionType.DECIDE,
                        payload={
                            "kind": "night_vote",
                            "leader_role_id": leader_id,
                        },
                        note="night_vote",
                    )
                )
            else:
                logger.warning("[step {}] phase={} no action generated; stopping.", idx, phase)
                break

        step = action_queue.pop(0)
        logger.info(
            "[step {}] action={} payload={}",
            idx,
            step.action,
            json.dumps(step.payload, ensure_ascii=False),
        )
        resp = game.act(
            world_state,
            ActRequest(session_id=session_id, action=step.action, payload=step.payload),
        )
        logger.info(
            "[step {}] messages={} phase={} time={} weather={}",
            idx,
            len(resp.messages),
            resp.world_state.phase,
            resp.world_state.time_of_day,
            resp.world_state.weather,
        )
        for msg in resp.messages:
            if msg.kind != "speech":
                continue
            logger.info(
                "[npc] {}: {}{}",
                msg.role_name or msg.role_id,
                msg.content[:120],
                "…" if len(msg.content) > 120 else "",
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
    parser.add_argument("--user-id", default="demo_user_06")
    parser.add_argument("--session-id", default=f"algo-{uuid.uuid4().hex[:6]}")
    parser.add_argument(
        "--base-url", default=os.getenv("MEMOS_API_BASE_URL", "http://0.0.0.0:8002")
    )
    parser.add_argument("--max-steps", type=int, default=8)
    parser.add_argument(
        "--log-world-search",
        action="store_true",
        help="Log world-cube searches (default: off)",
    )
    parser.add_argument("--output", default="", help="Optional JSONL output path")
    args = parser.parse_args()

    logger.remove()
    logger.add(sys.stdout, level="INFO", format="{time:YYYY-MM-DD HH:mm:ss} | {level} | {message}")
    logger.info("[config] base_url={}", args.base_url)
    client = MemOSMemoryClient(base_url=args.base_url)
    logs = run_scenario(
        client=client,
        user_id=args.user_id,
        session_id=args.session_id,
        max_steps=args.max_steps,
        log_world_search=args.log_world_search,
    )

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            for item in logs:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
    else:
        logger.info(json.dumps({"responses": logs}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
