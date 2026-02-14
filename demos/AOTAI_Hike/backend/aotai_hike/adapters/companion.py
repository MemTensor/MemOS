from __future__ import annotations

import random
import time

from dataclasses import dataclass
from typing import Any, ClassVar

from aotai_hike.adapters.memory import MemoryNamespace, MemOSMemoryClient
from aotai_hike.schemas import Message, Role, WorldState
from aotai_hike.theme import (
    _lang,
    _theme,
    companion_action_labels,
    companion_action_message_content,
    format_user_action_for_memory,
    mem_leader_vote_player_chose,
    mem_leader_vote_search_prefix,
    mem_player_action_label,
    mem_round_event_header,
    mem_round_no_dialogue,
    mem_round_no_npc,
    mem_search_weather_time,
    mem_speaker_action,
    mem_speaker_said,
    prompt_bailout_suffix,
    prompt_dialogue_prefix_narrator,
    prompt_dialogue_prefix_teammate,
    prompt_dialogue_prefix_you,
    prompt_leader_line,
    prompt_location_line,
    prompt_night_vote_intro,
    prompt_night_vote_output_requirement,
    prompt_night_vote_query,
    prompt_no_key_dialogue,
    prompt_no_recent_dialogue,
    prompt_none,
    prompt_player_role_line,
    prompt_role_focus_line,
    prompt_route_line,
    prompt_section_candidates,
    prompt_section_dialogue,
    prompt_section_memories,
    prompt_story_context_line,
    prompt_terrain_hint_none,
    prompt_unknown_altitude,
)
from aotai_hike.world.map_data import get_graph


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

    def leader_vote(
        self,
        *,
        world_state: WorldState,
        voter: Role,
        candidates: list[Role],
        player_vote_id: str | None = None,
    ) -> tuple[str | None, str]:
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
        lang = _lang(world_state)
        mem_hint = ""
        if memory_snippets:
            hint = memory_snippets[-1]
            mem_hint = f"（想起：{hint[:24]}…）" if lang != "en" else f"(Recall: {hint[:24]}…)"

        templates = [
            "这段路感觉{adj}，我们保持节奏。",
            "我有点{adj}，但还能撑。{mem}",
            "风好大，注意别走散。{mem}",
            "我看前面地形有变化，慢一点。{mem}",
            "要不要{suggestion}一下？",
        ]
        adjs = ["稳", "吃力", "顺", "危险", "安静", "诡异"]
        suggestions = ["休息", "补水", "检查路线", "扎营", "等等队友"]
        if lang == "en":
            templates = [
                "This stretch feels {adj}; let's keep the pace.",
                "I'm a bit {adj}, but I can manage. {mem}",
                "The wind is strong; stay close. {mem}",
                "The terrain ahead looks different; slow down. {mem}",
                "Want to {suggestion}?",
            ]
            adjs = ["steady", "rough", "smooth", "risky", "quiet", "eerie"]
            suggestions = ["rest", "rehydrate", "check the route", "camp", "wait for others"]

        out: list[Message] = []
        action_labels = companion_action_labels(lang)
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
                    content=companion_action_message_content(
                        lang, sp.name, self._rng.choice(action_labels)
                    ),
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

        base_history = list(world_state.chat_history or [])
        current_history: list[dict[str, Any]] = list(base_history)

        out: list[Message] = []
        for sp in speakers:
            text = self._generate_role_reply(
                world_state=world_state,
                role=sp,
                user_action=user_action,
                world_memories=memory_snippets,
                history=current_history,
            )
            if not text:
                continue
            speech_msg = Message(
                message_id=f"m-{world_state.session_id}-{now_ms}-{sp.role_id}",
                role_id=sp.role_id,
                role_name=sp.name,
                kind="speech",
                content=text,
                emote=self._rng.choice(self._EMOTES),
                action_tag=None,
                timestamp_ms=now_ms,
            )
            action_labels = companion_action_labels(_lang(world_state))
            action_msg = Message(
                message_id=f"a-{world_state.session_id}-{now_ms}-{sp.role_id}",
                role_id=sp.role_id,
                role_name=sp.name,
                kind="action",
                content=companion_action_message_content(
                    _lang(world_state), sp.name, self._rng.choice(action_labels)
                ),
                emote=None,
                action_tag=self._rng.choice(self._ACTION_TAGS),
                timestamp_ms=now_ms,
            )
            out.append(speech_msg)
            out.append(action_msg)

            current_history = list(current_history)
            current_history.append(
                {
                    "role": "assistant",
                    "content": text,
                    "speaker_name": sp.name,
                    "kind": "speech",
                    "chat_time": self._format_time_ms(),
                }
            )

        if out:
            round_mem = self._format_round_memory(world_state, out, user_action=user_action)
            chat_time = self._format_time_ms()
            for role in world_state.roles or []:
                cube_id = MemoryNamespace.role_cube_id(user_id=role.role_id, role_id=role.role_id)
                self._memory.add_memory(
                    user_id=role.role_id,
                    cube_id=cube_id,
                    session_id=world_state.session_id,
                    async_mode="async",
                    mode=self._config.mode,
                    messages=[
                        {
                            "role": "user",
                            "content": round_mem,
                            "chat_time": chat_time,
                            "role_id": role.role_id,
                            "role_name": role.name,
                        }
                    ],
                    info={
                        "event": "npc_round",
                        "user_action": format_user_action_for_memory(
                            _lang(world_state), user_action
                        ),
                        "weather": world_state.weather,
                        "time_of_day": world_state.time_of_day,
                        "scene_id": world_state.current_node_id,
                    },
                )

        require_p = 0.22
        requires_player_say = bool(active_role) and (self._rng.random() < require_p)
        return CompanionOutput(messages=out, requires_player_say=requires_player_say)

    def leader_vote(
        self,
        *,
        world_state: WorldState,
        voter: Role,
        candidates: list[Role],
        player_vote_id: str | None = None,
    ) -> tuple[str | None, str]:
        lang = _lang(world_state)
        if (
            player_vote_id
            and world_state.active_role_id
            and voter.role_id == world_state.active_role_id
        ):
            return player_vote_id, mem_leader_vote_player_chose(lang)

        cube_id = MemoryNamespace.role_cube_id(user_id=voter.role_id, role_id=voter.role_id)

        search_query = (
            f"{voter.persona} {mem_leader_vote_search_prefix(lang)}"
            f"{mem_search_weather_time(lang, world_state.weather, world_state.time_of_day)}"
        )
        memories = self._memory.search_memory(
            user_id=voter.role_id,
            cube_id=cube_id,
            query=search_query,
            top_k=self._config.memory_top_k,
            session_id=world_state.session_id,
        ).snippets

        cand_lines = []
        cand_ids: list[str] = []
        for r in candidates:
            cand_ids.append(r.role_id)
            cand_lines.append(f"- {r.name} (id={r.role_id})：{r.persona}")
        candidates_block = "\n".join(cand_lines)

        lang = _lang(world_state)
        history = list(world_state.chat_history or [])[-8:]
        dialogue_lines: list[str] = []
        for h in history:
            content = str(h.get("content") or "").strip()
            if not content:
                continue
            speaker_name = str(h.get("speaker_name") or "").strip()
            role_tag = str(h.get("role") or "").strip() or "assistant"
            if role_tag == "system":
                prefix = prompt_dialogue_prefix_narrator(lang)
            elif role_tag == "user":
                prefix = prompt_dialogue_prefix_you(lang)
            else:
                prefix = (
                    f"[{speaker_name}]" if speaker_name else prompt_dialogue_prefix_teammate(lang)
                )
            dialogue_lines.append(f"{prefix}{content}")
        dialogue_block = (
            "\n".join(dialogue_lines) if dialogue_lines else prompt_no_recent_dialogue(lang)
        )

        memories_block = (
            "\n".join(f"- {m}" for m in memories[:8]) if memories else prompt_none(lang)
        )
        system_prompt = (
            prompt_night_vote_intro(lang) + f"{prompt_section_candidates(lang)}\n"
            f"{candidates_block}\n\n"
            f"{prompt_section_memories(lang)}\n"
            f"{memories_block}\n\n"
            f"{prompt_section_dialogue(lang)}\n"
            f"{dialogue_block}\n\n"
            f"{prompt_night_vote_output_requirement(lang)}"
        )

        vote_query = prompt_night_vote_query(lang, voter.name)

        raw = self._memory.chat_complete(
            user_id=voter.role_id,
            cube_id=cube_id,
            query=vote_query,
            system_prompt=system_prompt,
            history=None,
            session_id=world_state.session_id,
            top_k=1,
            mode=self._config.mode,
            add_message_on_answer=False,
        )
        raw = (raw or "").strip()

        vote_id, reason = self._parse_leader_vote_response(raw, candidates_ids=cand_ids)
        return vote_id, reason

    def _generate_role_reply(
        self,
        *,
        world_state: WorldState,
        role: Role,
        user_action: str,
        world_memories: list[str],
        history: list[dict[str, Any]] | None = None,
    ) -> str:
        lang = _lang(world_state)
        user_action_str = format_user_action_for_memory(lang, user_action)

        cube_id = MemoryNamespace.role_cube_id(user_id=role.role_id, role_id=role.role_id)
        search_query = f"{role.persona} {user_action_str}{mem_search_weather_time(lang, world_state.weather, world_state.time_of_day)}"
        memories = self._memory.search_memory(
            user_id=role.role_id,
            cube_id=cube_id,
            query=search_query,
            top_k=self._config.memory_top_k,
            session_id=world_state.session_id,
        ).snippets
        combined_memories = [*world_memories, *memories]

        if history is None:
            history = list(world_state.chat_history or [])
        system_prompt = self._build_system_prompt(
            world_state=world_state,
            role=role,
            memories=combined_memories,
            history=history,
        )

        response = self._memory.chat_complete(
            user_id=role.role_id,
            cube_id=cube_id,
            query=user_action_str,
            system_prompt=system_prompt,
            history=None,
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
        return response

    def _format_round_memory(
        self, world_state: WorldState, messages: list[Message], *, user_action: str
    ) -> str:
        """Compress all NPC dialogues and actions in this round into a single memory entry (lang-aware)."""
        lang = _lang(world_state)
        if not messages:
            return mem_round_no_npc(lang)

        try:
            node = get_graph(_theme(world_state)).get_node(world_state.current_node_id)
            location_name = node.name if node else world_state.current_node_id
        except Exception:
            location_name = world_state.current_node_id

        header = (
            mem_round_event_header(
                lang, location_name, world_state.weather, world_state.time_of_day
            )
            + mem_player_action_label(lang)
            + format_user_action_for_memory(lang, user_action)
            + "."
        )

        lines: list[str] = []
        teammate = "teammate" if lang == "en" else "队员"
        for m in messages:
            speaker = m.role_name or m.role_id or teammate
            if m.kind == "speech":
                lines.append(f"{speaker}{mem_speaker_said(lang)}{m.content}")
            elif m.kind == "action":
                lines.append(f"{speaker}{mem_speaker_action(lang)}{m.content}")

        body = " ".join(lines) if lines else mem_round_no_dialogue(lang)
        return f"{header} {body}"

    def _build_system_prompt(
        self,
        *,
        world_state: WorldState,
        role: Role,
        memories: list[str],
        history: list[dict[str, Any]] | None = None,
    ) -> str:
        lang = _lang(world_state)
        # Get current node name + altitude + terrain hint
        try:
            node = get_graph(_theme(world_state)).get_node(world_state.current_node_id)
            location_name = node.name if node else world_state.current_node_id
            altitude = (
                f"{node.altitude_m}m"
                if node and getattr(node, "altitude_m", None) is not None
                else prompt_unknown_altitude(lang)
            )
            terrain_hint = getattr(node, "hint", "") or ""
        except Exception:
            location_name = world_state.current_node_id
            altitude = prompt_unknown_altitude(lang)
            terrain_hint = ""

        # Build NPC info section (current role + other roles)
        all_roles = world_state.roles or []
        npc_info_lines = []
        for r in all_roles:
            attrs = r.attrs
            if lang == "en":
                npc_info_lines.append(
                    f"```|<{r.name}>|\n"
                    f"# {r.name} persona: {r.persona}\n"
                    f"State: stamina{attrs.stamina}/100, mood{attrs.mood}/100, exp{attrs.experience}/100, risk{attrs.risk_tolerance}/100, supplies{attrs.supplies}/100\n"
                    f"```"
                )
            else:
                npc_info_lines.append(
                    f"```|<{r.name}>|\n"
                    f"# {r.name}设定：{r.persona}\n"
                    f"当前状态：体力{attrs.stamina}/100，情绪{attrs.mood}/100，经验{attrs.experience}/100，风险偏好{attrs.risk_tolerance}/100，物资{attrs.supplies}/100\n"
                    f"```"
                )
        npc_info_section = "\n".join(npc_info_lines)
        # Build memories section
        mem_lines = "\n".join(f"- {m}" for m in memories[:12]) if memories else prompt_none(lang)

        # Build recent dialogue section (who said what).
        recent_history = (history or [])[-8:]
        dialogue_lines_b: list[str] = []
        for h in recent_history:
            content = str(h.get("content") or "").strip()
            if not content:
                continue
            role_tag = str(h.get("role") or "").strip() or "assistant"
            speaker_name = str(h.get("speaker_name") or "").strip()
            if role_tag == "system":
                prefix = "|<" + prompt_dialogue_prefix_narrator(lang).strip("[]") + ">|"
            elif role_tag == "user":
                prefix = "|<" + prompt_dialogue_prefix_you(lang).strip("[]") + ">|"
            else:
                prefix = (
                    f"|<{speaker_name}>|"
                    if speaker_name
                    else "|<" + prompt_dialogue_prefix_teammate(lang).strip("[]") + ">|"
                )
            dialogue_lines_b.append(f"{prefix}{content}")
        dialogue_block = (
            "\n".join(dialogue_lines_b) if dialogue_lines_b else prompt_no_key_dialogue(lang)
        )

        # Get active role name
        active_role = next((r for r in all_roles if r.role_id == world_state.active_role_id), None)
        active_name = active_role.name if active_role else ("Player" if lang == "en" else "玩家")

        # Build story background
        leader_role = next((r for r in all_roles if r.role_id == world_state.leader_role_id), None)
        leader_name = leader_role.name if leader_role else ("Unknown" if lang == "en" else "未知")

        # Build simple textual map overview and mark current node.
        route_nodes = [
            "start",
            "slope_forest",
            "camp_2800",
            "stone_sea",
            "ridge_wind",
            "da_ye_hai",
            "ba_xian_tai",
            "end_exit",
        ]
        # Map of mainline nodes to their bailout exits
        bailout_map = {
            "camp_2800": "bailout_2800",
            "ridge_wind": "bailout_ridge",
        }

        def _label_node(nid: str) -> str:
            try:
                n = get_graph(_theme(world_state)).get_node(nid)
                base = n.name
            except Exception:
                base = nid
            if nid == world_state.current_node_id:
                return f"[{base}]"
            return base

        def _format_route_node(nid: str) -> str:
            label = _label_node(nid)
            if nid in bailout_map:
                bailout_id = bailout_map[nid]
                bailout_label = _label_node(bailout_id)
                return f"{label}{prompt_bailout_suffix(lang, bailout_label)}"
            return label

        mainline_str = " → ".join(_format_route_node(nid) for nid in route_nodes)
        terrain_str = terrain_hint or prompt_terrain_hint_none(lang)

        if lang == "en":
            return (
                "# Task\n"
                "You are the narrative engine of an interactive story. Based on the script, character settings and context, respond to user input. Keep logic and character consistency.\n"
                "1. Flow: your output -> other characters -> ... -> your output -> user input.\n"
                "2. Each output should acknowledge the user, advance the plot, and set up the next step.\n"
                "3. Keep reply under 120 words.\n"
                "<Format>\n"
                "(expression) dialogue\n"
                "</Format>\n\n"
                "<Your character info>\n"
                f"{npc_info_section}\n"
                "</Your character info>\n\n"
                "<Story context>\n"
                f"{prompt_story_context_line(lang, world_state.day, world_state.time_of_day, world_state.weather)}"
                f"{prompt_location_line(lang, location_name, altitude, terrain_str)}"
                f"{prompt_leader_line(lang, leader_name)}"
                f"{prompt_player_role_line(lang, active_name)}"
                f"{prompt_role_focus_line(lang, role.name)}"
                f"{prompt_route_line(lang, mainline_str)}"
                "</Story context>\n\n"
                "<Dialogue record>\n"
                f"{dialogue_block}\n"
                "</Dialogue record>\n\n"
                "<Relevant memories>\n"
                f"{mem_lines}\n"
                "</Relevant memories>\n\n"
                "# Output rules\n"
                "1. Keep plot logic and character consistency.\n"
                "2. Speak according to character persona and growth.\n"
                '3. Address the user as "you"; do not speak for the user.\n'
                f"4. Current speaker is {role.name}; respond as {role.name}.\n"
                "5. Create tension and choices around characters' goals; reveal gradually.\n"
                "6. Weave in weather, time, location and state naturally.\n"
                "7. Keep tone natural and concise.\n"
            )

        return (
            "# 任务描述\n"
            "你是互动剧情游戏的叙事引擎，根据提供的剧本/<本章剧情>、人物设定/<主演NPC信息介绍>和上下文，针对用户输入进行情节演绎。输出内容须符合剧本描述，逻辑连贯，人物发言符合其设定和成长轨迹。\n"
            "1. 游戏流程：你的输出->其他角色输入->...->你的输出->用户输入。\n"
            "2. 每次输出应：对用户输入有承接、中段推进剧情、末段提供铺垫，确保用户有明确目标感。\n"
            "3. 回复的字数不超过120字。\n"
            "<符号与格式>\n"
            "（神态描写）台词\n"
            "</符号与格式>\n\n"
            "<你的信息介绍>\n"
            f"{npc_info_section}\n"
            "</你的信息介绍>\n\n"
            "<故事背景>\n"
            f"{prompt_story_context_line(lang, world_state.day, world_state.time_of_day, world_state.weather)}"
            f"{prompt_location_line(lang, location_name, altitude, terrain_str)}"
            f"{prompt_leader_line(lang, leader_name)}"
            f"{prompt_player_role_line(lang, active_name)}"
            f"{prompt_role_focus_line(lang, role.name)}"
            f"{prompt_route_line(lang, mainline_str)}"
            "</故事背景>\n\n"
            "<对话记录>\n"
            f"{dialogue_block}\n"
            "</对话记录>\n\n"
            "<相关记忆>\n"
            f"{mem_lines}\n"
            "</相关记忆>\n\n"
            "# 剧情输出规则\n"
            "1. 保持情节逻辑、人物塑造与情感连贯性\n"
            "2. 发言符合人物设定和成长轨迹，包括表面人设与隐藏动机。\n"
            '3. 以用户为核心展开剧情，使用"你"指代用户，禁止代替用户发言或使用"用户"一词。\n'
            f"4. 当前发言角色是{role.name}，请以{role.name}的身份和口吻进行回应。\n"
            "5. 在推进剧情时，要有意识地围绕各角色的真实目的制造冲突与选择，但不要一次性泄露全部真相，应通过多轮对话逐步显露。\n"
            "6. 结合当前天气、时间、位置和角色状态，让事件合理发生，例如在恶劣天气或体力不足时暴露队伍分歧或私心。\n"
            "7. 回复用简短自然的口吻，不要罗列条目。"
        )

    @staticmethod
    def _parse_leader_vote_response(
        text: str, *, candidates_ids: list[str]
    ) -> tuple[str | None, str]:
        if not text:
            return None, ""

        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.strip("`")
            lines = cleaned.splitlines()
            if lines and lines[0].lstrip().startswith("json"):
                lines = lines[1:]
            cleaned = "\n".join(lines).strip()

        import json

        try:
            data = json.loads(cleaned)
            if isinstance(data, list) and data:
                data = data[0]
        except Exception:
            data = None

        vote_id: str | None = None
        reason: str = ""

        if isinstance(data, dict):
            if isinstance(data.get("vote_role_id"), str):
                vote_id = data.get("vote_role_id") or None
            elif isinstance(data.get("leader_role_id"), str):
                vote_id = data.get("leader_role_id") or None
            if isinstance(data.get("reason"), str):
                reason = data.get("reason") or ""

        # Validate that vote_id is in the candidates list
        if vote_id not in candidates_ids:
            vote_id = None

        if not reason:
            reason = cleaned if len(cleaned) <= 80 else cleaned[:80] + "…"

        return vote_id, reason

    @staticmethod
    def _format_time_ms() -> str:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
