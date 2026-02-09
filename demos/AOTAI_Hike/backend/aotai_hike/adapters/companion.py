from __future__ import annotations

import random
import time

from dataclasses import dataclass
from typing import ClassVar

from aotai_hike.adapters.memory import MemoryNamespace, MemOSMemoryClient
from aotai_hike.schemas import Message, Role, WorldState


@dataclass
class CompanionOutput:
    messages: list[Message]
    requires_player_say: bool = False


class CompanionBrain:
    def generate(
        self,
        *,
        world_state: WorldState,
        active_role: Role | None,
        memory_snippets: list[str],
        user_action: str,
    ) -> CompanionOutput:
        raise NotImplementedError


class MockCompanionBrain(CompanionBrain):
    _EMOTES: ClassVar[tuple[str, ...]] = ("calm", "tired", "happy", "panic", "focused", "grumpy")
    _ACTION_TAGS: ClassVar[tuple[str, ...]] = (
        "walk",
        "sit",
        "lookaround",
        "adjust_pack",
        "drink",
        "check_map",
    )

    def __init__(self, seed: int | None = None):
        self._rng = random.Random(seed)

    def generate(
        self,
        *,
        world_state: WorldState,
        active_role: Role | None,
        memory_snippets: list[str],
        user_action: str,
    ) -> CompanionOutput:
        now_ms = int(time.time() * 1000)
        active_id = active_role.role_id if active_role else None
        others = [r for r in world_state.roles if r.role_id != active_id]
        if not others:
            return CompanionOutput(messages=[])

        # --- "step chat" cadence ---
        # - Always at least 1 NPC speaks (if there is any NPC).
        # - After the first speaker, other NPCs may speak in a random order with a probability.
        first = self._rng.choice(others)
        rest = [r for r in others if r.role_id != first.role_id]
        self._rng.shuffle(rest)
        follow_p = 0.45
        speakers = [first] + [r for r in rest if self._rng.random() < follow_p]
        mem_hint = ""
        if memory_snippets:
            hint = memory_snippets[-1]
            mem_hint = f"（想起：{hint[:24]}…）"

        templates = [
            "这段路感觉{adj}，我们保持节奏。",
            "我有点{adj}，但还能撑。{mem}",
            "风好大，注意别走散。{mem}",
            "我看前面地形有变化，慢一点。{mem}",
            "要不要{suggestion}一下？",
        ]
        adjs = ["稳", "吃力", "顺", "危险", "安静", "诡异"]
        suggestions = ["休息", "补水", "检查路线", "扎营", "等等队友"]

        out: list[Message] = []
        for sp in speakers:
            t = self._rng.choice(templates)
            text = (
                t.replace("{adj}", self._rng.choice(adjs))
                .replace("{suggestion}", self._rng.choice(suggestions))
                .replace("{mem}", mem_hint)
            )
            out.append(
                Message(
                    message_id=f"m-{world_state.session_id}-{now_ms}-{sp.role_id}",
                    role_id=sp.role_id,
                    role_name=sp.name,
                    kind="speech",
                    content=text,
                    emote=self._rng.choice(self._EMOTES),
                    action_tag=None,
                    timestamp_ms=now_ms,
                )
            )
            out.append(
                Message(
                    message_id=f"a-{world_state.session_id}-{now_ms}-{sp.role_id}",
                    role_id=sp.role_id,
                    role_name=sp.name,
                    kind="action",
                    content=f"{sp.name}：{self._rng.choice(['调整背包', '观察地形', '喝水', '擦汗'])}",
                    emote=None,
                    action_tag=self._rng.choice(self._ACTION_TAGS),
                    timestamp_ms=now_ms,
                )
            )
        # Some turns require the player to respond before the world can proceed.
        require_p = 0.22
        requires_player_say = bool(active_role) and (self._rng.random() < require_p)
        return CompanionOutput(messages=out, requires_player_say=requires_player_say)


@dataclass
class MemoryChatConfig:
    memory_top_k: int = 5
    history_max_items: int = 20
    mode: str = "fine"
    max_response_chars: int = 180


class MemoryCompanionBrain(CompanionBrain):
    _EMOTES: ClassVar[tuple[str, ...]] = ("calm", "tired", "happy", "panic", "focused", "grumpy")
    _ACTION_TAGS: ClassVar[tuple[str, ...]] = (
        "walk",
        "sit",
        "lookaround",
        "adjust_pack",
        "drink",
        "check_map",
    )
    _FALLBACK_LINES: ClassVar[tuple[str, ...]] = (
        "路况还行，我们保持节奏。",
        "大家注意脚下，慢一点。",
        "风有点大，别走散。",
    )

    def __init__(
        self,
        *,
        memory: MemOSMemoryClient,
        config: MemoryChatConfig | None = None,
        seed: int | None = None,
    ):
        self._memory = memory
        self._rng = random.Random(seed)
        self._config = config or MemoryChatConfig()

    def generate(
        self,
        *,
        world_state: WorldState,
        active_role: Role | None,
        memory_snippets: list[str],
        user_action: str,
    ) -> CompanionOutput:
        now_ms = int(time.time() * 1000)
        active_id = active_role.role_id if active_role else None
        others = [r for r in world_state.roles if r.role_id != active_id]
        if not others:
            return CompanionOutput(messages=[])

        first = self._rng.choice(others)
        rest = [r for r in others if r.role_id != first.role_id]
        self._rng.shuffle(rest)
        follow_p = 0.45
        speakers = [first] + [r for r in rest if self._rng.random() < follow_p]

        out: list[Message] = []
        for sp in speakers:
            text = self._generate_role_reply(
                world_state=world_state,
                role=sp,
                user_action=user_action,
                world_memories=memory_snippets,
            )
            if not text:
                continue
            out.append(
                Message(
                    message_id=f"m-{world_state.session_id}-{now_ms}-{sp.role_id}",
                    role_id=sp.role_id,
                    role_name=sp.name,
                    kind="speech",
                    content=text,
                    emote=self._rng.choice(self._EMOTES),
                    action_tag=None,
                    timestamp_ms=now_ms,
                )
            )
            out.append(
                Message(
                    message_id=f"a-{world_state.session_id}-{now_ms}-{sp.role_id}",
                    role_id=sp.role_id,
                    role_name=sp.name,
                    kind="action",
                    content=f"{sp.name}：{self._rng.choice(['调整背包', '观察地形', '喝水', '擦汗'])}",
                    emote=None,
                    action_tag=self._rng.choice(self._ACTION_TAGS),
                    timestamp_ms=now_ms,
                )
            )

        require_p = 0.22
        requires_player_say = bool(active_role) and (self._rng.random() < require_p)
        return CompanionOutput(messages=out, requires_player_say=requires_player_say)

    def _generate_role_reply(
        self,
        *,
        world_state: WorldState,
        role: Role,
        user_action: str,
        world_memories: list[str],
    ) -> str:
        try:
            cube_id = MemoryNamespace.role_cube_id(
                user_id=world_state.user_id, role_id=role.role_id
            )
            search_query = f"{role.persona} {user_action} 天气:{world_state.weather} 时间:{world_state.time_of_day}"
            memories = self._memory.search_memory(
                user_id=world_state.user_id,
                cube_id=cube_id,
                query=search_query,
                top_k=self._config.memory_top_k,
                mode=self._config.mode,
                session_id=world_state.session_id,
            ).snippets
            combined_memories = [*world_memories, *memories]

            system_prompt = self._build_system_prompt(
                world_state=world_state,
                role=role,
                memories=combined_memories,
            )

            history = (world_state.chat_history or [])[-self._config.history_max_items :]
            response = self._memory.chat_complete(
                user_id=world_state.user_id,
                cube_id=cube_id,
                query=user_action,
                system_prompt=system_prompt,
                history=history if history else None,
                session_id=world_state.session_id,
                top_k=1,
                mode=self._config.mode,
                add_message_on_answer=False,
            )
            response = (response or "").strip()
            if not response:
                return ""

            if len(response) > self._config.max_response_chars:
                response = response[: self._config.max_response_chars].rstrip() + "…"

            chat_time = self._format_time_ms()
            self._memory.add_memory(
                user_id=world_state.user_id,
                cube_id=cube_id,
                session_id=world_state.session_id,
                async_mode="sync",
                mode=self._config.mode,
                messages=[
                    {"role": "user", "content": user_action, "chat_time": chat_time},
                    {"role": "assistant", "content": response, "chat_time": chat_time},
                ],
                info={
                    "role_id": role.role_id,
                    "role_name": role.name,
                    "weather": world_state.weather,
                    "time_of_day": world_state.time_of_day,
                    "scene_id": world_state.current_node_id,
                    "event": "npc_chat",
                },
            )
            return response
        except Exception:
            return self._rng.choice(self._FALLBACK_LINES)

    def _build_system_prompt(
        self, *, world_state: WorldState, role: Role, memories: list[str]
    ) -> str:
        mem_lines = "\n".join(f"- {m}" for m in memories[:12]) if memories else "（无）"
        attrs = role.attrs
        return (
            f"你是徒步队伍中的角色：{role.name}。\n"
            f"角色设定：{role.persona}\n"
            f"当前天气：{world_state.weather}，时间：{world_state.time_of_day}，位置：{world_state.current_node_id}\n"
            f"角色状态：体力{attrs.stamina}/100，情绪{attrs.mood}/100，经验{attrs.experience}/100，风险偏好{attrs.risk_tolerance}/100\n"
            f"相关记忆：\n{mem_lines}\n"
            "请结合玩家动作和当前场景，用简短自然的口吻回应，不要罗列条目。"
        )

    @staticmethod
    def _format_time_ms() -> str:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
