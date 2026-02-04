from __future__ import annotations

import json
import random
import time
import uuid

from dataclasses import dataclass
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from aotai_hike.adapters.companion import CompanionBrain
    from aotai_hike.adapters.memory import MemoryAdapter


from aotai_hike.adapters.background import BackgroundProvider, BackgroundRequest
from aotai_hike.schemas import (
    ActionType,
    ActRequest,
    ActResponse,
    BackgroundAsset,
    Message,
    Role,
    RoleUpsertRequest,
    RoleUpsertResponse,
    SetActiveRoleRequest,
    WorldState,
)
from aotai_hike.world.map_data import AO_TAI_NODES


@dataclass
class GameConfig:
    memory_top_k: int = 5


class GameService:
    def __init__(
        self,
        *,
        memory: MemoryAdapter,
        companion: CompanionBrain,
        background: BackgroundProvider,
        rng_seed: int | None = None,
        config: GameConfig | None = None,
    ):
        self._memory = memory
        self._companion = companion
        self._background = background
        self._rng = random.Random(rng_seed)
        self._config = config or GameConfig()

    def upsert_role(self, world_state: WorldState, req: RoleUpsertRequest) -> RoleUpsertResponse:
        role = req.role
        found = False
        for i, r in enumerate(world_state.roles):
            if r.role_id == role.role_id:
                world_state.roles[i] = role
                found = True
                break
        if not found:
            world_state.roles.append(role)
        if world_state.active_role_id is None:
            world_state.active_role_id = role.role_id
        return RoleUpsertResponse(
            roles=world_state.roles, active_role_id=world_state.active_role_id
        )

    def set_active_role(self, world_state: WorldState, req: SetActiveRoleRequest) -> WorldState:
        if not any(r.role_id == req.active_role_id for r in world_state.roles):
            raise ValueError(f"Unknown role_id: {req.active_role_id}")
        world_state.active_role_id = req.active_role_id
        return world_state

    def act(self, world_state: WorldState, req: ActRequest) -> ActResponse:
        now_ms = int(time.time() * 1000)
        active = self._get_active_role(world_state)
        messages: list[Message] = []

        user_action_desc = self._apply_action(world_state, req, now_ms, messages, active)

        node_after = AO_TAI_NODES[min(world_state.route_node_index, len(AO_TAI_NODES) - 1)]
        bg = self._safe_get_background(node_after.scene_id)

        mem_event = self._format_memory_event(
            world_state, req, node_after, user_action_desc, messages
        )
        self._memory.add_event(
            user_id=world_state.user_id, session_id=world_state.session_id, content=mem_event
        )

        query = self._build_memory_query(world_state, req, node_after, user_action_desc)
        mem_res = self._memory.search(
            user_id=world_state.user_id,
            session_id=world_state.session_id,
            query=query,
            top_k=self._config.memory_top_k,
        )

        comp = self._companion.generate(
            world_state=world_state,
            active_role=active,
            memory_snippets=mem_res.snippets,
            user_action=user_action_desc,
        )
        messages.extend(comp.messages)

        return ActResponse(world_state=world_state, messages=messages, background=bg)

    def _safe_get_background(self, scene_id: str) -> BackgroundAsset:
        try:
            return self._background.get_background(BackgroundRequest(scene_id=scene_id))
        except Exception:
            return BackgroundAsset(scene_id=scene_id, asset_url=None, type="none", meta={})

    def _get_active_role(self, world_state: WorldState) -> Role | None:
        if not world_state.active_role_id:
            return None
        for r in world_state.roles:
            if r.role_id == world_state.active_role_id:
                return r
        return None

    def _apply_action(
        self,
        world_state: WorldState,
        req: ActRequest,
        now_ms: int,
        messages: list[Message],
        active: Role | None,
    ) -> str:
        node = AO_TAI_NODES[min(world_state.route_node_index, len(AO_TAI_NODES) - 1)]
        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content=f"场景：{node.name} · 天气：{world_state.weather} · 时间：Day{world_state.day}/{world_state.time_of_day}",
                timestamp_ms=now_ms,
            )
        )

        if req.action == ActionType.SAY:
            text = str(req.payload.get("text") or "").strip() or "（沉默）"
            if active is not None:
                messages.append(
                    Message(
                        message_id=f"u-{uuid.uuid4().hex[:8]}",
                        role_id=active.role_id,
                        role_name=active.name,
                        kind="speech",
                        content=text,
                        timestamp_ms=now_ms,
                    )
                )
            return f"SAY:{text[:80]}"

        if req.action == ActionType.MOVE_FORWARD:
            if world_state.route_node_index < len(AO_TAI_NODES) - 1:
                world_state.route_node_index += 1
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=-8, mood_delta=-2, exp_delta=1)
            self._maybe_change_weather(world_state)
            ev = self._rng.choice(
                [
                    "碎石路更难走。",
                    "风变大了。",
                    "队伍节奏稳定。",
                    "能见度略差。",
                    "前方地形更开阔。",
                ]
            )
            self._push_event(world_state, ev)
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"你带队前进。{ev}",
                    timestamp_ms=now_ms,
                )
            )
            return "MOVE_FORWARD"

        if req.action == ActionType.REST:
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=10, mood_delta=4, exp_delta=0)
            ev = self._rng.choice(["补水休整。", "调整背负。", "放慢呼吸。", "晒晒太阳。"])
            self._push_event(world_state, ev)
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"你选择休息。{ev}",
                    timestamp_ms=now_ms,
                )
            )
            return "REST"

        if req.action == ActionType.CAMP:
            world_state.time_of_day = "night"
            ev = self._rng.choice(["升起炉火。", "搭好帐篷。", "分配守夜。", "检查余粮。"])
            self._push_event(world_state, f"扎营：{ev}")
            self._tweak_party(world_state, stamina_delta=18, mood_delta=6, exp_delta=0)
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"你决定扎营。{ev}",
                    timestamp_ms=now_ms,
                )
            )
            world_state.day += 1
            world_state.time_of_day = "morning"
            self._maybe_change_weather(world_state)
            return "CAMP"

        if req.action == ActionType.OBSERVE:
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=-2, mood_delta=2, exp_delta=1)
            obs = self._rng.choice(
                [
                    "你观察到远处云层翻涌。",
                    "你发现脚印与折断的灌木。",
                    "你记录了一个更稳的落脚点。",
                    "你听见风里隐约的回声。",
                ]
            )
            self._push_event(world_state, f"观察：{obs}")
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=obs,
                    timestamp_ms=now_ms,
                )
            )
            return "OBSERVE"

        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content=f"未实现动作：{req.action}",
                timestamp_ms=now_ms,
            )
        )
        return str(req.action)

    def _push_event(self, world_state: WorldState, event: str) -> None:
        world_state.recent_events.append(event)
        world_state.recent_events = world_state.recent_events[-10:]

    def _advance_time(self, world_state: WorldState) -> None:
        order = ["morning", "noon", "afternoon", "evening", "night"]
        idx = order.index(world_state.time_of_day)
        if idx < len(order) - 1:
            world_state.time_of_day = order[idx + 1]  # type: ignore[assignment]
        else:
            world_state.day += 1
            world_state.time_of_day = "morning"

    def _tweak_party(
        self, world_state: WorldState, *, stamina_delta: int, mood_delta: int, exp_delta: int
    ) -> None:
        for r in world_state.roles:
            r.attrs.stamina = max(0, min(100, r.attrs.stamina + stamina_delta))
            r.attrs.mood = max(0, min(100, r.attrs.mood + mood_delta))
            r.attrs.experience = max(0, min(100, r.attrs.experience + exp_delta))

    def _maybe_change_weather(self, world_state: WorldState) -> None:
        if self._rng.random() < 0.35:
            world_state.weather = self._rng.choice(["sunny", "cloudy", "windy", "rainy", "foggy"])

    def _format_memory_event(
        self,
        world_state: WorldState,
        req: ActRequest,
        node,
        user_action_desc: str,
        messages: list[Message],
    ) -> str:
        payload = {
            "tag": "ao-tai-demo",
            "session_id": world_state.session_id,
            "node": {"id": node.node_id, "name": node.name, "scene_id": node.scene_id},
            "timeline": {
                "day": world_state.day,
                "time_of_day": world_state.time_of_day,
                "weather": world_state.weather,
            },
            "action": {"type": req.action, "desc": user_action_desc, "payload": req.payload},
            "recent_events": world_state.recent_events[-5:],
            "messages": [
                {"kind": m.kind, "role_name": m.role_name, "content": m.content[:200]}
                for m in messages
                if m.kind != "system"
            ],
        }
        return json.dumps(payload, ensure_ascii=False)

    def _build_memory_query(
        self, world_state: WorldState, req: ActRequest, node, user_action_desc: str
    ) -> str:
        active = self._get_active_role(world_state)
        persona = (active.persona if active else "")[:80]
        ev = "；".join(world_state.recent_events[-3:])
        return f"鳌太线 {node.name} {world_state.weather} {world_state.time_of_day} 动作:{req.action} {user_action_desc} 事件:{ev} 人设:{persona}"
