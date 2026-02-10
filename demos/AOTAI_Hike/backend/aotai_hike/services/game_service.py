from __future__ import annotations

import json
import random
import time
import uuid

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from aotai_hike.adapters.background import BackgroundProvider, BackgroundRequest
from aotai_hike.schemas import (
    ActionType,
    ActRequest,
    ActResponse,
    AoTaiEdge,
    BackgroundAsset,
    CampMeetingState,
    Message,
    Phase,
    Role,
    RoleUpsertRequest,
    RoleUpsertResponse,
    SetActiveRoleRequest,
    WorldState,
)
from aotai_hike.world.map_data import AoTaiGraph
from loguru import logger


if TYPE_CHECKING:
    from aotai_hike.adapters.companion import CompanionBrain
    from aotai_hike.adapters.memory import MemoryAdapter


@dataclass
class GameConfig:
    memory_top_k: int = 5
    chat_history_max_len: int = 40


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
        # Leader is assigned at runtime (random default on first act), not during role creation.
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
        logger.info("[act] action={} phase={}", req.action, world_state.phase)

        # Random default leader (assigned on first act after roles exist).
        if world_state.roles and world_state.leader_role_id is None:
            world_state.leader_role_id = self._rng.choice(world_state.roles).role_id
            leader = next(
                (r for r in world_state.roles if r.role_id == world_state.leader_role_id), None
            )
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"今日团长：{leader.name if leader else world_state.leader_role_id}",
                    timestamp_ms=now_ms,
                )
            )

        # Phase gates: some phases only accept specific actions.
        if world_state.phase == Phase.NIGHT_WAIT_PLAYER and req.action != ActionType.SAY:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content="夜幕降临：请你先发言（发送一句话）后，才能开始票选团长。",
                    timestamp_ms=now_ms,
                )
            )
            node_after = AoTaiGraph.get_node(world_state.current_node_id)
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if world_state.phase == Phase.NIGHT_VOTE_READY and req.action != ActionType.DECIDE:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content="夜晚票选准备就绪：请选择一位队长继续。",
                    timestamp_ms=now_ms,
                )
            )
            node_after = AoTaiGraph.get_node(world_state.current_node_id)
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if world_state.phase == Phase.AWAIT_PLAYER_SAY and req.action != ActionType.SAY:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content="需要你先用“发言”回应队伍（发送一句话）后才能继续。",
                    timestamp_ms=now_ms,
                )
            )
            node_after = AoTaiGraph.get_node(world_state.current_node_id)
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if req.action == ActionType.DECIDE:
            user_action_desc = self._apply_decision(world_state, req, now_ms, messages)
        else:
            user_action_desc = self._apply_action(world_state, req, now_ms, messages, active)

        node_after = AoTaiGraph.get_node(world_state.current_node_id)
        bg = self._safe_get_background(node_after.scene_id)

        mem_event = self._format_memory_event(
            world_state, req, node_after, user_action_desc, messages
        )
        logger.info("[mem:event] {}", mem_event)
        self._memory.add_event(
            user_id=world_state.user_id,
            session_id=world_state.session_id,
            content=mem_event,
        )

        query = self._build_memory_query(world_state, req, node_after, user_action_desc)
        logger.info("[mem:search] query={}", query)
        mem_res = self._memory.search(
            user_id=world_state.user_id,
            session_id=world_state.session_id,
            query=query,
            top_k=self._config.memory_top_k,
        )

        # Night arrival: pause, darken, and require player speech before voting.
        # Skip NPC chat if we're entering night vote phase.
        is_entering_night_vote = (
            world_state.time_of_day == "night" and world_state.phase == Phase.FREE
        )
        if is_entering_night_vote:
            world_state.phase = Phase.NIGHT_WAIT_PLAYER
        else:
            # Per-step NPC cadence:
            # - Only trigger NPC chatter after a MOVE_FORWARD step.
            # - It may gate further progress until the player replies.
            # - Skip chat if we're already in night vote phases.
            if (
                req.action == ActionType.MOVE_FORWARD
                and user_action_desc.startswith("MOVE_FORWARD")
                and world_state.phase != Phase.NIGHT_WAIT_PLAYER
                and world_state.phase != Phase.NIGHT_VOTE_READY
            ):
                comp = self._companion.generate(
                    world_state=world_state,
                    active_role=active,
                    memory_snippets=mem_res.snippets,
                    user_action=user_action_desc,
                )
                messages.extend(comp.messages)
                for m in comp.messages:
                    if m.kind == "speech":
                        logger.info("[npc] {}: {}", m.role_name or m.role_id, m.content)
                self._apply_message_effects(world_state, comp.messages)
                if getattr(comp, "requires_player_say", False):
                    world_state.phase = Phase.AWAIT_PLAYER_SAY
                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content="队友看向你：轮到你发言了（发一句话后才能继续）。",
                            timestamp_ms=now_ms,
                        )
                    )

        self._append_chat_history(world_state, messages)
        return ActResponse(world_state=world_state, messages=messages, background=bg)

    def _apply_decision(
        self, world_state: WorldState, req: ActRequest, now_ms: int, messages: list[Message]
    ) -> str:
        kind = str(req.payload.get("kind") or "").strip()
        if kind == "night_vote":
            player_vote_id = str(req.payload.get("leader_role_id") or "").strip() or None
            self._run_leader_vote(world_state, now_ms, messages, player_vote_id=player_vote_id)
            # Night finishes: light recovery, new day, weather update.
            self._tweak_party(world_state, stamina_delta=6, mood_delta=2, exp_delta=0)
            world_state.day += 1
            world_state.time_of_day = "morning"
            world_state.time_step_counter = 0
            self._maybe_change_weather(world_state)
            world_state.phase = Phase.FREE
            return "DECIDE:night_vote"
        if kind == "camp_meeting":
            next_id = str(req.payload.get("consensus_next_node_id") or "").strip() or None
            leader_id = str(req.payload.get("leader_role_id") or "").strip() or None
            lock_strength = str(req.payload.get("lock_strength") or "").strip() or "soft"

            if next_id and next_id not in (world_state.camp_meeting.options_next_node_ids or []):
                raise ValueError(f"Invalid consensus_next_node_id: {next_id}")
            if leader_id and not any(r.role_id == leader_id for r in world_state.roles):
                raise ValueError(f"Invalid leader_role_id: {leader_id}")

            world_state.consensus_next_node_id = next_id
            world_state.leader_role_id = leader_id or world_state.leader_role_id
            world_state.lock_strength = lock_strength  # pydantic will validate enum

            # Write a "consensus memory" into recent events (memory adapter will store the act payload anyway).
            who = next(
                (r.name for r in world_state.roles if r.role_id == world_state.leader_role_id),
                "未知",
            )
            node_name = AoTaiGraph.get_node(world_state.current_node_id).name
            plan_name = AoTaiGraph.get_node(next_id).name if next_id else "（未选择）"
            ev = f"营地共识：在 {node_name}，共识路线=去 {plan_name}，锁强度={world_state.lock_strength}，次日团长={who}"
            self._push_event(world_state, ev)
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=ev,
                    timestamp_ms=now_ms,
                )
            )

            # Overnight settlement (light recovery; lock_strength can add small stress)
            base_stamina = 8
            base_mood = 3
            mood_penalty = 0
            if str(world_state.lock_strength) == "hard":
                mood_penalty = 1
            if str(world_state.lock_strength) == "iron":
                mood_penalty = 2
            self._tweak_party(
                world_state,
                stamina_delta=base_stamina,
                mood_delta=base_mood - mood_penalty,
                exp_delta=0,
            )

            # Advance to next morning
            world_state.day += 1
            world_state.time_of_day = "morning"
            world_state.time_step_counter = 0
            self._maybe_change_weather(world_state)

            # Exit meeting
            world_state.camp_meeting = CampMeetingState()
            world_state.phase = Phase.FREE
            return "DECIDE:camp_meeting"

        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content=f"未知决策类型：{kind}",
                timestamp_ms=now_ms,
            )
        )
        return f"DECIDE:{kind or 'unknown'}"

    def _run_leader_vote(
        self,
        world_state: WorldState,
        now_ms: int,
        messages: list[Message],
        *,
        player_vote_id: str | None = None,
    ) -> None:
        """
        Mock voting process with optional forced leader choice:
        - each role casts one vote (action message + reason)
        - system announces result and updates leader_role_id
        """
        if not world_state.roles:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content="票选失败：队伍为空。",
                    timestamp_ms=now_ms,
                )
            )
            return

        old = world_state.leader_role_id
        old_name = next((r.name for r in world_state.roles if r.role_id == old), "（无）")

        candidates = [r.role_id for r in world_state.roles]
        vote_order = candidates[:]
        self._rng.shuffle(vote_order)
        tally: dict[str, int] = dict.fromkeys(candidates, 0)

        def _pick_vote(voter_id: str) -> str:
            # Player selection is only the player's vote, not a forced result.
            if player_vote_id and voter_id == world_state.active_role_id:
                return player_vote_id
            # Small incumbency bias (keep the current leader).
            if old and self._rng.random() < 0.28:
                return old
            return self._rng.choice(candidates)

        def _pick_reason(voter_id: str, choice_id: str) -> str:
            pool = [
                "路况判断更稳。",
                "更能照顾大家节奏。",
                "今天状态最好。",
                "路线经验更足。",
                "愿意承担风险。",
                "团队更信服。",
            ]
            if player_vote_id and voter_id == world_state.active_role_id:
                return "玩家选择。"
            if choice_id == old:
                return "延续昨日安排。"
            return self._rng.choice(pool)

        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content="开始票选团长：每人投一票。",
                timestamp_ms=now_ms,
            )
        )

        for voter_id in vote_order:
            voter = next((r for r in world_state.roles if r.role_id == voter_id), None)
            if not voter:
                continue
            choice = _pick_vote(voter_id)
            tally[choice] = int(tally.get(choice, 0)) + 1
            choice_name = next((r.name for r in world_state.roles if r.role_id == choice), choice)
            reason = _pick_reason(voter_id, choice)
            messages.append(
                Message(
                    message_id=f"v-{world_state.session_id}-{now_ms}-{voter_id}",
                    role_id=voter_id,
                    role_name=voter.name,
                    kind="action",
                    content=f"{voter.name} 投票：{choice_name}（理由：{reason}）",
                    timestamp_ms=now_ms,
                )
            )

        max_votes = max(tally.values()) if tally else 0
        winners = [rid for rid, n in tally.items() if n == max_votes] if tally else []
        if winners:
            world_state.leader_role_id = self._rng.choice(winners)

        new_name = next(
            (r.name for r in world_state.roles if r.role_id == world_state.leader_role_id),
            world_state.leader_role_id,
        )

        if world_state.leader_role_id != old:
            self._push_event(world_state, f"票选团长：{old_name} → {new_name}")
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"票选结果：更换团长 {old_name} → {new_name}",
                    timestamp_ms=now_ms,
                )
            )
        else:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"票选结果：团长继续由 {new_name} 担任。",
                    timestamp_ms=now_ms,
                )
            )

    def _enter_camp_meeting(
        self, world_state: WorldState, now_ms: int, messages: list[Message]
    ) -> None:
        # Prepare meeting options: from current node, use outgoing edges as "tomorrow proposals".
        outgoing = AoTaiGraph.outgoing(world_state.current_node_id)
        opts = [e.to_node_id for e in outgoing]
        order = [r.role_id for r in world_state.roles]
        self._rng.shuffle(order)

        world_state.camp_meeting = CampMeetingState(
            active=True,
            options_next_node_ids=opts,
            proposals_order_role_ids=order,
            proposed_at_ms=now_ms,
        )
        world_state.phase = Phase.CAMP_MEETING_DECIDE

        # Step 1: proposals (one per role, random order)
        for rid in order:
            role = next((r for r in world_state.roles if r.role_id == rid), None)
            if not role:
                continue
            # Very light mock proposal: pick one option (or "原地" if none)
            if opts:
                pick = self._rng.choice(opts)
                dest = AoTaiGraph.get_node(pick).name
                text = f"明天我建议：去 {dest}。"
            else:
                text = "明天我建议：先原地休整再决定。"
            messages.append(
                Message(
                    message_id=f"m-{world_state.session_id}-{now_ms}-{rid}",
                    role_id=rid,
                    role_name=role.name,
                    kind="speech",
                    content=text,
                    timestamp_ms=now_ms,
                )
            )
        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content="营地会议：请选择“共识路线/锁强度/明日团长”，提交后进入第二天早晨。",
                timestamp_ms=now_ms,
            )
        )

    def _auto_camp_meeting(
        self, world_state: WorldState, now_ms: int, messages: list[Message]
    ) -> None:
        """
        Auto camp meeting:
        - random proposal order
        - optional leader change (mock)
        - overnight settlement
        - advance to next morning
        """
        if not world_state.roles:
            # Nothing to do; still advance to next morning
            world_state.day += 1
            world_state.time_of_day = "morning"
            world_state.time_step_counter = 0
            self._maybe_change_weather(world_state)
            return

        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content="夜晚到来：营地会议开始（自动）。",
                timestamp_ms=now_ms,
            )
        )

        outgoing = AoTaiGraph.outgoing(world_state.current_node_id)
        opts = [e.to_node_id for e in outgoing]

        order = [r.role_id for r in world_state.roles]
        self._rng.shuffle(order)
        for rid in order:
            role = next((r for r in world_state.roles if r.role_id == rid), None)
            if not role:
                continue
            if opts:
                pick = self._rng.choice(opts)
                dest = AoTaiGraph.get_node(pick).name
                text = f"明天我建议：去 {dest}。"
            else:
                text = "明天我建议：先原地休整再决定。"
            messages.append(
                Message(
                    message_id=f"m-{world_state.session_id}-{now_ms}-{rid}",
                    role_id=rid,
                    role_name=role.name,
                    kind="speech",
                    content=text,
                    timestamp_ms=now_ms,
                )
            )

        # Vote for leader (mock): each role casts one vote in random order.
        old = world_state.leader_role_id
        old_name = next((r.name for r in world_state.roles if r.role_id == old), "（无）")

        candidates = [r.role_id for r in world_state.roles]
        vote_order = candidates[:]
        self._rng.shuffle(vote_order)
        tally: dict[str, int] = dict.fromkeys(candidates, 0)

        def _pick_vote(voter_id: str) -> str:
            # Small incumbency bias (keep the current leader).
            if old and self._rng.random() < 0.28:
                return old
            # Otherwise, random vote among candidates.
            return self._rng.choice(candidates)

        for voter_id in vote_order:
            voter = next((r for r in world_state.roles if r.role_id == voter_id), None)
            if not voter:
                continue
            choice = _pick_vote(voter_id)
            tally[choice] = tally.get(choice, 0) + 1
            choice_name = next((r.name for r in world_state.roles if r.role_id == choice), choice)
            messages.append(
                Message(
                    message_id=f"v-{world_state.session_id}-{now_ms}-{voter_id}",
                    role_id=voter_id,
                    role_name=voter.name,
                    kind="action",
                    content=f"{voter.name} 投票：{choice_name}",
                    timestamp_ms=now_ms,
                )
            )

        # Winner: max votes; tie-break randomly among tied.
        max_votes = max(tally.values()) if tally else 0
        winners = [rid for rid, n in tally.items() if n == max_votes] if tally else []
        if winners:
            world_state.leader_role_id = self._rng.choice(winners)

        new_name = next(
            (r.name for r in world_state.roles if r.role_id == world_state.leader_role_id),
            world_state.leader_role_id,
        )

        if world_state.leader_role_id != old:
            self._push_event(world_state, f"营地会议：更换团长 {old_name} → {new_name}（票选）")
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"营地会议结果（票选）：更换团长 {old_name} → {new_name}",
                    timestamp_ms=now_ms,
                )
            )
        else:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=f"营地会议结果（票选）：团长继续由 {new_name} 担任。",
                    timestamp_ms=now_ms,
                )
            )

        # Overnight settlement then advance to next morning.
        self._tweak_party(world_state, stamina_delta=8, mood_delta=3, exp_delta=0)
        world_state.day += 1
        world_state.time_of_day = "morning"
        world_state.time_step_counter = 0
        self._maybe_change_weather(world_state)

    def _apply_message_effects(self, world_state: WorldState, messages: list[Message]) -> None:
        # Minimal, deterministic mapping from emote/action_tag -> attr deltas.
        # (This is a placeholder for LLM-driven state updates.)
        by_role: dict[str, dict[str, int]] = {}
        for m in messages:
            if not m.role_id:
                continue
            if m.kind not in ("speech", "action"):
                continue
            rid = str(m.role_id)
            d = by_role.setdefault(rid, {"stamina": 0, "mood": 0, "experience": 0})
            em = (m.emote or "").strip()
            if em == "tired":
                d["stamina"] -= 1
                d["mood"] -= 1
            elif em == "happy":
                d["mood"] += 2
            elif em == "panic":
                d["mood"] -= 2
                d["stamina"] -= 1
            elif em == "focused":
                d["experience"] += 1
            elif em == "grumpy":
                d["mood"] -= 1
            elif em == "calm":
                d["mood"] += 1

            tag = (m.action_tag or "").strip()
            if tag in ("check_map", "lookaround"):
                d["experience"] += 1
            if tag in ("drink",):
                d["mood"] += 1

        for r in world_state.roles:
            delta = by_role.get(r.role_id)
            if not delta:
                continue
            r.attrs.stamina = max(0, min(100, r.attrs.stamina + int(delta["stamina"])))
            r.attrs.mood = max(0, min(100, r.attrs.mood + int(delta["mood"])))
            r.attrs.experience = max(0, min(100, r.attrs.experience + int(delta["experience"])))

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
        time.sleep(2)
        # Alias: CONTINUE means "advance one step" (same as MOVE_FORWARD with default payload).
        if req.action == ActionType.CONTINUE:
            req.action = ActionType.MOVE_FORWARD

        node = AoTaiGraph.get_node(world_state.current_node_id)
        # UI-only; we keep it empty in the auto-run flow unless we explicitly need a user choice.
        world_state.available_next_node_ids = []

        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content=f"位置：{node.name} · 天气：{world_state.weather} · 时间：Day{world_state.day}/{world_state.time_of_day}",
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
            # Night flow: player speech unlocks the vote button (do NOT resume auto-run yet).
            if world_state.phase == Phase.NIGHT_WAIT_PLAYER:
                world_state.phase = Phase.NIGHT_VOTE_READY
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content="收到你的发言：现在请选择一位队长开始票选。",
                        timestamp_ms=now_ms,
                    )
                )
                return f"SAY:{text[:80]}"
            # If we were waiting for the player to respond, a SAY clears the gate.
            if world_state.phase == Phase.AWAIT_PLAYER_SAY:
                world_state.phase = Phase.FREE
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content="收到你的回应，队伍继续前进。",
                        timestamp_ms=now_ms,
                    )
                )
            return f"SAY:{text[:80]}"

        if req.action == ActionType.MOVE_FORWARD:
            step_km = float(req.payload.get("step_km") or 1.0)
            if step_km <= 0:
                step_km = 1.0

            # If already in transit, keep advancing along the same segment.
            if world_state.in_transit_to_node_id:
                world_state.in_transit_progress_km += step_km
                self._advance_time(world_state)
                self._tweak_party(world_state, stamina_delta=-3, mood_delta=-1, exp_delta=0)

                # If we are on an exit route and it turns rainy, retreat back to the junction.
                try:
                    edge_kind = None
                    if world_state.in_transit_from_node_id and world_state.in_transit_to_node_id:
                        for e in AoTaiGraph.outgoing(world_state.in_transit_from_node_id):
                            if e.to_node_id == world_state.in_transit_to_node_id:
                                edge_kind = getattr(e, "kind", None)
                                break
                    if edge_kind == "exit" and str(world_state.weather) == "rainy":
                        messages.append(
                            Message(
                                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                                kind="system",
                                content="下撤途中遇雨，撤退失败，返回岔路继续前进。",
                                timestamp_ms=now_ms,
                            )
                        )
                        world_state.in_transit_from_node_id = None
                        world_state.in_transit_to_node_id = None
                        world_state.in_transit_progress_km = 0.0
                        world_state.in_transit_total_km = 0.0
                        world_state.available_next_node_ids = AoTaiGraph.next_node_ids(
                            world_state.current_node_id
                        )
                        return "MOVE_FORWARD:retreat_rain"
                except Exception:
                    pass

                if world_state.in_transit_progress_km + 1e-6 >= world_state.in_transit_total_km:
                    # Arrive
                    next_id = world_state.in_transit_to_node_id
                    world_state.current_node_id = next_id
                    if next_id not in world_state.visited_node_ids:
                        world_state.visited_node_ids.append(next_id)
                    world_state.route_node_index = len(world_state.visited_node_ids) - 1

                    # Clear transit
                    world_state.in_transit_from_node_id = None
                    world_state.in_transit_to_node_id = None
                    world_state.in_transit_progress_km = 0.0
                    world_state.in_transit_total_km = 0.0

                    world_state.available_next_node_ids = AoTaiGraph.next_node_ids(next_id)

                    ev = self._rng.choice(
                        ["你终于看见前方地标。", "脚步放轻，稳稳抵达。", "风声渐远，你到达了节点。"]
                    )
                    self._push_event(world_state, ev)
                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content=f"前进 {step_km:.0f}km，已抵达：{AoTaiGraph.get_node(next_id).name}。{ev}",
                            timestamp_ms=now_ms,
                        )
                    )
                    if world_state.time_of_day == "night":
                        world_state.time_of_day = "evening"
                    return f"MOVE_FORWARD:arrive:{next_id}"
                else:
                    left = max(
                        0.0, world_state.in_transit_total_km - world_state.in_transit_progress_km
                    )
                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content=(
                                f"前进 {step_km:.0f}km，路上…（{world_state.in_transit_progress_km:.0f}/"
                                f"{world_state.in_transit_total_km:.0f}km，剩余 {left:.0f}km）"
                            ),
                            timestamp_ms=now_ms,
                        )
                    )
                    world_state.available_next_node_ids = []
                    return "MOVE_FORWARD:step"

            # Not in transit: choose next edge from current node.
            outgoing = AoTaiGraph.outgoing(world_state.current_node_id)
            if not outgoing:
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content="已到达终点/无可用前进路线。",
                        timestamp_ms=now_ms,
                    )
                )
                return "MOVE_FORWARD:end"

            next_edge = None
            if len(outgoing) == 1:
                next_edge = outgoing[0]
            else:
                picked = str(req.payload.get("next_node_id") or "").strip()
                valid = {e.to_node_id: e for e in outgoing}
                if picked and picked in valid:
                    next_edge = valid[picked]
                else:
                    # If player is the leader, require manual selection.
                    if (
                        world_state.leader_role_id and world_state.active_role_id
                    ) and world_state.leader_role_id == world_state.active_role_id:
                        world_state.available_next_node_ids = [e.to_node_id for e in outgoing]
                        world_state.phase = Phase.JUNCTION_DECISION
                        messages.append(
                            Message(
                                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                                kind="system",
                                content="到达岔路：请团长选择路线。",
                                timestamp_ms=now_ms,
                            )
                        )
                        return "MOVE_FORWARD:await_choice"

                    # Auto junction pick by leader (NPC).
                    leader_name = next(
                        (
                            r.name
                            for r in world_state.roles
                            if r.role_id == world_state.leader_role_id
                        ),
                        "团长",
                    )
                    next_edge = self._rng.choice(outgoing)

                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content=f"到达岔路：{leader_name}做出选择 → {AoTaiGraph.get_node(next_edge.to_node_id).name}。",
                            timestamp_ms=now_ms,
                        )
                    )

            # If choosing a bailout route, it can fail and force a retreat.
            if getattr(next_edge, "kind", None) == "exit":
                prev_id = None
                if world_state.visited_node_ids and len(world_state.visited_node_ids) >= 2:
                    prev_id = world_state.visited_node_ids[-2]
                rainy_fail = str(world_state.weather) == "rainy"
                if rainy_fail:
                    non_exit = [e for e in outgoing if getattr(e, "kind", None) != "exit"]
                    if non_exit:
                        next_edge = self._rng.choice(non_exit)
                        messages.append(
                            Message(
                                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                                kind="system",
                                content="雨天不适合下撤，改走主线路线。",
                                timestamp_ms=now_ms,
                            )
                        )
                    elif prev_id:
                        messages.append(
                            Message(
                                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                                kind="system",
                                content="雨天无法下撤，只能回撤上一步。",
                                timestamp_ms=now_ms,
                            )
                        )
                        next_edge = AoTaiEdge(
                            from_node_id=world_state.current_node_id,
                            to_node_id=prev_id,
                            kind="main",
                            label="回撤",
                            distance_km=float(getattr(next_edge, "distance_km", 1.0) or 1.0),
                        )

            # Start transit along chosen edge
            world_state.phase = Phase.FREE
            world_state.in_transit_from_node_id = world_state.current_node_id
            world_state.in_transit_to_node_id = next_edge.to_node_id
            world_state.in_transit_total_km = float(getattr(next_edge, "distance_km", 1.0) or 1.0)
            world_state.in_transit_progress_km = 0.0
            world_state.available_next_node_ids = []

            # Immediately take first step
            world_state.in_transit_progress_km += step_km
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=-3, mood_delta=-1, exp_delta=0)

            if world_state.in_transit_progress_km + 1e-6 >= world_state.in_transit_total_km:
                # Arrive in the same action
                next_id = world_state.in_transit_to_node_id
                world_state.current_node_id = next_id
                world_state.visited_node_ids.append(next_id)
                world_state.route_node_index = len(world_state.visited_node_ids) - 1

                world_state.in_transit_from_node_id = None
                world_state.in_transit_to_node_id = None
                world_state.in_transit_progress_km = 0.0
                world_state.in_transit_total_km = 0.0

                world_state.available_next_node_ids = AoTaiGraph.next_node_ids(next_id)

                ev = self._rng.choice(["你来到新的地标。", "脚下坡度变化明显。", "视野忽然开阔。"])
                self._push_event(world_state, ev)
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content=f"前进 {step_km:.0f}km，已抵达：{AoTaiGraph.get_node(next_id).name}。{ev}",
                        timestamp_ms=now_ms,
                    )
                )
                if world_state.time_of_day == "night":
                    world_state.time_of_day = "evening"
                return f"MOVE_FORWARD:arrive:{next_id}"

            left = max(0.0, world_state.in_transit_total_km - world_state.in_transit_progress_km)
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=(
                        f"出发去 {AoTaiGraph.get_node(next_edge.to_node_id).name}，前进 {step_km:.0f}km…（"
                        f"{world_state.in_transit_progress_km:.0f}/{world_state.in_transit_total_km:.0f}km，剩余 {left:.0f}km）"
                    ),
                    timestamp_ms=now_ms,
                )
            )
            return "MOVE_FORWARD:start"

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
            world_state.time_step_counter = 0
            self._maybe_change_weather(world_state)
            return "CAMP"

        if req.action == ActionType.OBSERVE:
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=-3, mood_delta=2, exp_delta=1)
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
        # Slow down time: advance only every 2 steps.
        world_state.time_step_counter = int(world_state.time_step_counter or 0) + 1
        if world_state.time_step_counter % 2 != 0:
            return
        order = ["morning", "noon", "afternoon", "evening", "night"]
        idx = order.index(world_state.time_of_day)
        if idx < len(order) - 1:
            world_state.time_of_day = order[idx + 1]  # type: ignore[assignment]
        else:
            world_state.day += 1
            world_state.time_of_day = "morning"
            world_state.time_step_counter = 0
        # Weather can change on every time advance.
        self._maybe_change_weather(world_state)

    def _tweak_party(
        self, world_state: WorldState, *, stamina_delta: int, mood_delta: int, exp_delta: int
    ) -> None:
        for r in world_state.roles:
            r.attrs.stamina = max(0, min(100, r.attrs.stamina + stamina_delta))
            r.attrs.mood = max(0, min(100, r.attrs.mood + mood_delta))
            r.attrs.experience = max(0, min(100, r.attrs.experience + exp_delta))

    def _maybe_change_weather(self, world_state: WorldState) -> None:
        if self._rng.random() < 0.7:
            world_state.weather = self._rng.choice(
                ["sunny", "cloudy", "windy", "rainy", "snowy", "foggy"]
            )

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
            "action": {"type": str(req.action), "desc": user_action_desc, "payload": req.payload},
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

    def _append_chat_history(self, world_state: WorldState, messages: list[Message]) -> None:
        if not messages:
            return
        history = list(world_state.chat_history or [])
        for msg in messages:
            if msg.kind == "action":
                continue
            if msg.kind == "system":
                role = "system"
            elif msg.role_id and msg.role_id == world_state.active_role_id:
                role = "user"
            else:
                role = "assistant"
            item: dict[str, Any] = {
                "role": role,
                "content": msg.content,
            }
            # Preserve speaker identity for prompt reconstruction.
            if msg.role_id:
                item["speaker_id"] = msg.role_id
            if msg.role_name:
                item["speaker_name"] = msg.role_name
            if msg.kind:
                item["kind"] = msg.kind
            if msg.timestamp_ms:
                item["chat_time"] = time.strftime(
                    "%Y-%m-%d %H:%M:%S", time.localtime(msg.timestamp_ms / 1000)
                )
            history.append(item)
        max_len = self._config.chat_history_max_len
        if max_len and len(history) > max_len:
            history = history[-max_len:]
        world_state.chat_history = history
