from __future__ import annotations

import random
import time

from dataclasses import dataclass
from typing import ClassVar

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
