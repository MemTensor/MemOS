from __future__ import annotations

import random
import time

from dataclasses import dataclass
from typing import Any, ClassVar

from aotai_hike.adapters.memory import MemoryNamespace, MemOSMemoryClient
from aotai_hike.schemas import Message, Role, WorldState
from aotai_hike.world.map_data import AoTaiGraph


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
            action_msg = Message(
                message_id=f"a-{world_state.session_id}-{now_ms}-{sp.role_id}",
                role_id=sp.role_id,
                role_name=sp.name,
                kind="action",
                content=f"{sp.name}：{self._rng.choice(['调整背包', '观察地形', '喝水', '擦汗'])}",
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
                        "user_action": self._format_user_action_cn(user_action),
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
        if (
            player_vote_id
            and world_state.active_role_id
            and voter.role_id == world_state.active_role_id
        ):
            return player_vote_id, "玩家在界面中明确选择。"

        cube_id = MemoryNamespace.role_cube_id(user_id=voter.role_id, role_id=voter.role_id)

        search_query = (
            f"{voter.persona} 选择今晚队长。"
            f" 天气:{world_state.weather} 时间:{world_state.time_of_day}"
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

        history = list(world_state.chat_history or [])[-8:]
        dialogue_lines: list[str] = []
        for h in history:
            content = str(h.get("content") or "").strip()
            if not content:
                continue
            speaker_name = str(h.get("speaker_name") or "").strip()
            role_tag = str(h.get("role") or "").strip() or "assistant"
            if role_tag == "system":
                prefix = "[旁白]"
            elif role_tag == "user":
                prefix = "[你]"
            else:
                prefix = f"[{speaker_name}]" if speaker_name else "[队友]"
            dialogue_lines.append(f"{prefix}{content}")
        dialogue_block = "\n".join(dialogue_lines) if dialogue_lines else "（暂无近期对话）"

        memories_block = "\n".join(f"- {m}" for m in memories[:8]) if memories else "（暂无）"

        system_prompt = (
            "你正在参与鳌太线徒步剧情游戏，现在是夜晚，需要在队伍中选出一位今晚的队长。\n"
            "你将扮演当前说话的队员，根据每个人的性格、人设、最近状态和对话，做出理性但有主观色彩的选择。\n\n"
            "【候选人列表】\n"
            f"{candidates_block}\n\n"
            "【你的记忆片段】\n"
            f"{memories_block}\n\n"
            "【最近对话】\n"
            f"{dialogue_block}\n\n"
            "【输出要求】\n"
            "1. 只能从候选人列表中的 id 里选择一位作为队长。\n"
            "2. 请输出一个 JSON 对象，格式严格为：\n"
            '{"vote_role_id": "<候选人id>", "reason": "<不超过40字的中文理由>"}\n'
            "3. 不要输出任何多余文字，不要加注释，不要加前后缀。\n"
        )

        vote_query = f"你是队员「{voter.name}」，请在候选人中选出今晚的队长，并给出一句理由。"

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
        user_action_cn = self._format_user_action_cn(user_action)

        cube_id = MemoryNamespace.role_cube_id(user_id=role.role_id, role_id=role.role_id)
        search_query = f"{role.persona} {user_action_cn} 天气:{world_state.weather} 时间:{world_state.time_of_day}"
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
            query=user_action_cn,
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
        """Compress all NPC dialogues and actions in this round into a single Chinese memory entry."""
        if not messages:
            return "本轮无NPC发言。"

        try:
            node = AoTaiGraph.get_node(world_state.current_node_id)
            location_name = node.name if node else world_state.current_node_id
        except Exception:
            location_name = world_state.current_node_id

        header = (
            f"本轮事件：位置 {location_name}，天气 {world_state.weather}，时间段 {world_state.time_of_day}。"
            f" 玩家动作：{self._format_user_action_cn(user_action)}。"
        )

        lines: list[str] = []
        for m in messages:
            speaker = m.role_name or m.role_id or "队员"
            if m.kind == "speech":
                lines.append(f"{speaker}说：{m.content}")
            elif m.kind == "action":
                lines.append(f"{speaker}动作：{m.content}")

        body = " ".join(lines) if lines else "本轮暂无有效对话或动作。"
        return f"{header} {body}"

    def _build_system_prompt(
        self,
        *,
        world_state: WorldState,
        role: Role,
        memories: list[str],
        history: list[dict[str, Any]] | None = None,
    ) -> str:
        # Get current node name + altitude + terrain hint
        try:
            node = AoTaiGraph.get_node(world_state.current_node_id)
            location_name = node.name if node else world_state.current_node_id
            altitude = (
                f"{getattr(node, 'altitude_m', '未知')}m"
                if node and getattr(node, "altitude_m", None) is not None
                else "未知海拔"
            )
            terrain_hint = getattr(node, "hint", "") or ""
        except Exception:
            location_name = world_state.current_node_id
            altitude = "未知海拔"
            terrain_hint = ""

        # Build NPC info section (current role + other roles)
        all_roles = world_state.roles or []
        npc_info_lines = []
        for r in all_roles:
            attrs = r.attrs
            npc_info_lines.append(
                f"```|<{r.name}>|\n"
                f"# {r.name}设定：{r.persona}\n"
                f"当前状态：体力{attrs.stamina}/100，情绪{attrs.mood}/100，经验{attrs.experience}/100，风险偏好{attrs.risk_tolerance}/100，物资{attrs.supplies}/100\n"
                f"```"
            )
        npc_info_section = "\n".join(npc_info_lines)

        # Build memories section
        mem_lines = "\n".join(f"- {m}" for m in memories[:12]) if memories else "（无）"

        # Build recent dialogue section (who said what).
        recent_history = (history or [])[-8:]
        dialogue_lines: list[str] = []
        for h in recent_history:
            content = str(h.get("content") or "").strip()
            if not content:
                continue
            role_tag = str(h.get("role") or "").strip() or "assistant"
            speaker_name = str(h.get("speaker_name") or "").strip()
            if role_tag == "system":
                prefix = "|<旁白>|"
            elif role_tag == "user":
                prefix = "|<你>|"
            else:
                prefix = f"|<{speaker_name}>|" if speaker_name else "|<队友>|"
            dialogue_lines.append(f"{prefix}{content}")
        dialogue_block = "\n".join(dialogue_lines) if dialogue_lines else "（暂无关键对话）"

        # Get active role name
        active_role = next((r for r in all_roles if r.role_id == world_state.active_role_id), None)
        active_name = active_role.name if active_role else "玩家"

        # Build story background
        leader_role = next((r for r in all_roles if r.role_id == world_state.leader_role_id), None)
        leader_name = leader_role.name if leader_role else "未知"

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
                n = AoTaiGraph.get_node(nid)
                base = n.name
            except Exception:
                base = nid
            if nid == world_state.current_node_id:
                return f"[{base}]"
            return base

        def _format_route_node(nid: str) -> str:
            label = _label_node(nid)
            # Check if this node has a bailout exit
            if nid in bailout_map:
                bailout_id = bailout_map[nid]
                bailout_label = _label_node(bailout_id)
                return f"{label}(可下撤至{bailout_label})"
            return label

        mainline_str = " → ".join(_format_route_node(nid) for nid in route_nodes)

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
            f"你们是一支徒步队伍，正在穿越危险的鳌太线。今天是第{world_state.day}天，当前时间是{world_state.time_of_day}，天气：{world_state.weather}。\n"
            f"你们现在位于：{location_name}（{altitude}），地形提示：{terrain_hint or '无特别提示'}。\n"
            f"当前队长是：{leader_name}。\n"
            f"玩家当前扮演的角色是：{active_name}。\n"
            f"剧情围绕{role.name}展开，{role.name}需要根据当前情况做出反应和发言。\n"
            f"整条路线示意：{mainline_str}。\n"
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
    def _format_user_action_cn(user_action: str) -> str:
        ua = str(user_action or "").strip()
        if not ua:
            return "无动作"

        if ua.startswith("SAY:"):
            text = ua.split(":", 1)[1] if ":" in ua else ""
            text = text.strip()
            return f"玩家发言：{text}" if text else "玩家发言"

        if ua.startswith("MOVE_FORWARD:"):
            if ":arrive:" in ua:
                return "队伍前进并抵达新的路段节点"
            if ":retreat_rain" in ua:
                return "下撤途中遇雨，队伍被迫返回岔路"
            if ":start" in ua:
                return "队伍从当前节点出发，开始新的前进路段"
            if ":step" in ua:
                return "队伍在路线上继续前进"
            if ":end" in ua:
                return "已到达终点或无可前进路线"
            return "队伍前进"

        if ua == "REST":
            return "队伍选择原地休息调整状态"
        if ua == "CAMP":
            return "队长决定扎营过夜，恢复体力但消耗物资"
        if ua == "OBSERVE":
            return "队伍停下观察周围环境与路况"

        if ua.startswith("DECIDE:"):
            kind = ua.split(":", 1)[1] if ":" in ua else ""
            if kind == "night_vote":
                return "进行夜间票选决定队长"
            if kind == "camp_meeting":
                return "讨论并决定下一步路线"
            return f"做出决策：{kind or '未知'}"

        return ua

    @staticmethod
    def _format_time_ms() -> str:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
