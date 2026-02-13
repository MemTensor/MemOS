from __future__ import annotations

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
from aotai_hike.theme import (
    _lang,
    _theme,
    event_arrived_phrases,
    event_arrived_phrases_start,
    event_camp_label,
    event_camp_phrases,
    event_observe_label,
    event_observe_phrases,
    event_rest_phrases,
    prompt_memory_tag_by_theme,
    sys_advance_km_arrived,
    sys_advance_km_en_route,
    sys_at_junction_choose_leader,
    sys_at_junction_leader_chose,
    sys_camp_meeting,
    sys_camp_meeting_result_vote,
    sys_camp_or_forward,
    sys_camp_proposal_dest,
    sys_camp_proposal_rest,
    sys_decide_camp,
    sys_depart_for_advance,
    sys_end_no_route,
    sys_location_weather_time,
    sys_need_say_first,
    sys_night_camp_meeting,
    sys_night_fall_say_first,
    sys_night_vote_ready,
    sys_only_leader_camp,
    sys_rainy_no_retreat_back,
    sys_rainy_no_retreat_main,
    sys_received_say_choose_leader,
    sys_received_say_leader_camp_or_forward,
    sys_received_say_party_forward,
    sys_retreat_rain,
    sys_silence,
    sys_start_leader_vote,
    sys_teammate_look_at_you,
    sys_today_leader,
    sys_unimplemented_action,
    sys_unknown_decision,
    sys_vote_action,
    sys_vote_action_short,
    sys_vote_failed_empty,
    sys_vote_result_change,
    sys_vote_result_keep,
    sys_you_choose_rest,
)
from aotai_hike.world.map_data import get_graph
from loguru import logger


if TYPE_CHECKING:
    from aotai_hike.adapters.companion import CompanionBrain
    from aotai_hike.adapters.memory import MemoryAdapter


def _is_junction(node_id: str, theme: str | None = None) -> bool:
    return len(get_graph(theme).outgoing(node_id)) > 1


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
            # Check if this is a default role by name (AoTai: 阿鳌/太白/小山; Kilimanjaro: 利奥/山姆/杰德 or Leo/Sam/Jade)
            # For default roles, ALWAYS preserve the attrs as-is, never modify them
            _default_names = ("阿鳌", "太白", "小山", "利奥", "山姆", "杰德", "Leo", "Sam", "Jade")
            is_default_role = role.name in _default_names

            if is_default_role:
                # Default roles from _DEFAULT_ROLES - preserve attrs exactly as passed
                # Do not modify or randomize them under any circumstances
                logger.info(
                    f"Adding default role {role.name} with attrs: stamina={role.attrs.stamina}, mood={role.attrs.mood}, experience={role.attrs.experience}, risk_tolerance={role.attrs.risk_tolerance}, supplies={role.attrs.supplies}"
                )
                world_state.roles.append(role)
            else:
                # For new user-created roles (not from default templates), initialize attrs with random values if not provided
                from aotai_hike.schemas import RoleAttrs

                default_attrs = RoleAttrs()

                # Only randomize if:
                # 1. attrs is None, OR
                # 2. All values match defaults (user didn't provide custom attrs)
                if role.attrs is None:
                    # Generate random attributes within reasonable ranges
                    stamina = self._rng.randint(50, 90)
                    mood = self._rng.randint(40, 80)
                    experience = self._rng.randint(5, 40)
                    risk_tolerance = self._rng.randint(20, 70)
                    supplies = self._rng.randint(60, 90)
                    role.attrs = RoleAttrs(
                        stamina=stamina,
                        mood=mood,
                        experience=experience,
                        risk_tolerance=risk_tolerance,
                        supplies=supplies,
                    )
                elif (
                    role.attrs.stamina == default_attrs.stamina
                    and role.attrs.mood == default_attrs.mood
                    and role.attrs.experience == default_attrs.experience
                    and role.attrs.risk_tolerance == default_attrs.risk_tolerance
                    and role.attrs.supplies == default_attrs.supplies
                ):
                    # All values match defaults (stamina=70, mood=60, experience=10, risk_tolerance=50, supplies=80)
                    # User likely didn't provide custom attrs - randomize them
                    stamina = self._rng.randint(50, 90)
                    mood = self._rng.randint(40, 80)
                    experience = self._rng.randint(5, 40)
                    risk_tolerance = self._rng.randint(20, 70)
                    supplies = self._rng.randint(60, 90)
                    role.attrs = RoleAttrs(
                        stamina=stamina,
                        mood=mood,
                        experience=experience,
                        risk_tolerance=risk_tolerance,
                        supplies=supplies,
                    )
                # If attrs has custom values, keep them as-is
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
                    content=sys_today_leader(
                        _lang(world_state),
                        leader.name if leader else world_state.leader_role_id,
                    ),
                    timestamp_ms=now_ms,
                )
            )

        # Phase gates: some phases only accept specific actions.
        if world_state.phase == Phase.NIGHT_WAIT_PLAYER and req.action != ActionType.SAY:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_night_fall_say_first(_lang(world_state)),
                    timestamp_ms=now_ms,
                )
            )
            node_after = get_graph(getattr(world_state, "theme", "aotai")).get_node(
                world_state.current_node_id
            )
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if world_state.phase == Phase.NIGHT_VOTE_READY and req.action != ActionType.DECIDE:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_night_vote_ready(_lang(world_state)),
                    timestamp_ms=now_ms,
                )
            )
            node_after = get_graph(getattr(world_state, "theme", "aotai")).get_node(
                world_state.current_node_id
            )
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if world_state.phase == Phase.AWAIT_PLAYER_SAY and req.action != ActionType.SAY:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_need_say_first(_lang(world_state)),
                    timestamp_ms=now_ms,
                )
            )
            node_after = get_graph(getattr(world_state, "theme", "aotai")).get_node(
                world_state.current_node_id
            )
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if world_state.phase == Phase.AWAIT_CAMP_DECISION and req.action not in (
            ActionType.CAMP,
            ActionType.MOVE_FORWARD,
        ):
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_camp_or_forward(_lang(world_state)),
                    timestamp_ms=now_ms,
                )
            )
            node_after = get_graph(getattr(world_state, "theme", "aotai")).get_node(
                world_state.current_node_id
            )
            bg = self._safe_get_background(node_after.scene_id)
            self._append_chat_history(world_state, messages)
            return ActResponse(world_state=world_state, messages=messages, background=bg)

        if req.action == ActionType.DECIDE:
            world_state.stats.decision_times = int(world_state.stats.decision_times or 0) + 1
            user_action_desc = self._apply_decision(world_state, req, now_ms, messages)
        else:
            user_action_desc = self._apply_action(world_state, req, now_ms, messages, active)

        node_after = get_graph(getattr(world_state, "theme", "aotai")).get_node(
            world_state.current_node_id
        )
        bg = self._safe_get_background(node_after.scene_id)

        mem_event = self._format_memory_event(
            world_state, req, node_after, user_action_desc, messages
        )
        logger.info(
            "[mem:event] user_id={} role_id={} role_name={} {}",
            world_state.user_id,
            active.role_id if active else None,
            active.name if active else None,
            mem_event,
        )
        self._memory.add_event(
            user_id=world_state.user_id,
            session_id=world_state.session_id,
            content=mem_event,
            role_id=active.role_id if active else None,
            role_name=active.name if active else None,
        )

        query = self._build_memory_query(world_state, req, node_after, user_action_desc)
        logger.info(
            "[mem:search] user_id={} role_id={} role_name={} query={}",
            world_state.user_id,
            active.role_id if active else None,
            active.name if active else None,
            query,
        )
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
                and world_state.phase != Phase.JUNCTION_DECISION
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
                            content=sys_teammate_look_at_you(_lang(world_state)),
                            timestamp_ms=now_ms,
                        )
                    )

        # If we were in AWAIT_CAMP_DECISION and player chose to continue (MOVE_FORWARD),
        # return to FREE phase
        if world_state.phase == Phase.AWAIT_CAMP_DECISION and req.action == ActionType.MOVE_FORWARD:
            world_state.phase = Phase.FREE

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
            node_name = (
                get_graph(getattr(world_state, "theme", "aotai"))
                .get_node(world_state.current_node_id)
                .name
            )
            plan_name = (
                get_graph(getattr(world_state, "theme", "aotai")).get_node(next_id).name
                if next_id
                else "（未选择）"
            )
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
                content=sys_unknown_decision(_lang(world_state), kind),
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
                    content=sys_vote_failed_empty(_lang(world_state)),
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

        def _fallback_pick_vote(voter_id: str) -> str:
            # Player selection is only the player's vote, not a forced result.
            if player_vote_id and voter_id == world_state.active_role_id:
                return player_vote_id
            # Small incumbency bias (keep the current leader).
            if old and self._rng.random() < 0.28:
                return old
            return self._rng.choice(candidates)

        def _fallback_pick_reason(voter_id: str, choice_id: str) -> str:
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
                content=sys_start_leader_vote(_lang(world_state)),
                timestamp_ms=now_ms,
            )
        )

        for voter_id in vote_order:
            voter = next((r for r in world_state.roles if r.role_id == voter_id), None)
            if not voter:
                continue

            choice: str | None = None
            reason: str = ""
            try:
                leader_vote_fn = getattr(self._companion, "leader_vote", None)
                if callable(leader_vote_fn):
                    choice, reason = leader_vote_fn(
                        world_state=world_state,
                        voter=voter,
                        candidates=world_state.roles,
                        player_vote_id=player_vote_id,
                    )
            except Exception:
                logger.exception(
                    "leader_vote via companion failed; falling back to heuristic vote."
                )
                choice, reason = None, ""

            if not choice or choice not in candidates:
                choice = _fallback_pick_vote(voter_id)
                reason = _fallback_pick_reason(voter_id, choice)

            tally[choice] = int(tally.get(choice, 0)) + 1
            choice_name = next((r.name for r in world_state.roles if r.role_id == choice), choice)
            messages.append(
                Message(
                    message_id=f"v-{world_state.session_id}-{now_ms}-{voter_id}",
                    role_id=voter_id,
                    role_name=voter.name,
                    kind="action",
                    content=sys_vote_action(_lang(world_state), voter.name, choice_name, reason),
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

        world_state.stats.vote_times = int(world_state.stats.vote_times or 0) + 1
        if world_state.active_role_id and world_state.leader_role_id == world_state.active_role_id:
            world_state.stats.leader_times = int(world_state.stats.leader_times or 0) + 1

        if world_state.leader_role_id != old:
            self._push_event(world_state, f"票选团长：{old_name} → {new_name}")
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_vote_result_change(_lang(world_state), old_name, new_name),
                    timestamp_ms=now_ms,
                )
            )
        else:
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_vote_result_keep(_lang(world_state), new_name),
                    timestamp_ms=now_ms,
                )
            )

    def _enter_camp_meeting(
        self, world_state: WorldState, now_ms: int, messages: list[Message]
    ) -> None:
        # Prepare meeting options: from current node, use outgoing edges as "tomorrow proposals".
        outgoing = get_graph(getattr(world_state, "theme", "aotai")).outgoing(
            world_state.current_node_id
        )
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
            # Very light mock proposal: pick one option (or "stay" if none)
            if opts:
                pick = self._rng.choice(opts)
                dest = get_graph(getattr(world_state, "theme", "aotai")).get_node(pick).name
                text = sys_camp_proposal_dest(_lang(world_state), dest)
            else:
                text = sys_camp_proposal_rest(_lang(world_state))
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
                content=sys_camp_meeting(_lang(world_state)),
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
                content=sys_night_camp_meeting(_lang(world_state)),
                timestamp_ms=now_ms,
            )
        )

        outgoing = get_graph(getattr(world_state, "theme", "aotai")).outgoing(
            world_state.current_node_id
        )
        opts = [e.to_node_id for e in outgoing]

        order = [r.role_id for r in world_state.roles]
        self._rng.shuffle(order)
        for rid in order:
            role = next((r for r in world_state.roles if r.role_id == rid), None)
            if not role:
                continue
            if opts:
                pick = self._rng.choice(opts)
                dest = get_graph(getattr(world_state, "theme", "aotai")).get_node(pick).name
                text = sys_camp_proposal_dest(_lang(world_state), dest)
            else:
                text = sys_camp_proposal_rest(_lang(world_state))
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
                    content=sys_vote_action_short(_lang(world_state), voter.name, choice_name),
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
                content=sys_camp_meeting_result_vote(
                    _lang(world_state), old_name, new_name, world_state.leader_role_id != old
                ),
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

        node = get_graph(getattr(world_state, "theme", "aotai")).get_node(
            world_state.current_node_id
        )
        # UI-only; we keep it empty in the auto-run flow unless we explicitly need a user choice.
        world_state.available_next_node_ids = []

        messages.append(
            Message(
                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                kind="system",
                content=sys_location_weather_time(
                    _lang(world_state),
                    node.name,
                    world_state.weather,
                    world_state.day,
                    world_state.time_of_day,
                ),
                timestamp_ms=now_ms,
            )
        )

        if req.action == ActionType.SAY:
            text = str(req.payload.get("text") or "").strip() or sys_silence(_lang(world_state))
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
                        content=sys_received_say_choose_leader(_lang(world_state)),
                        timestamp_ms=now_ms,
                    )
                )
                return f"SAY:{text[:80]}"
            # If we were waiting for the player to respond, a SAY clears the gate.
            if world_state.phase == Phase.AWAIT_PLAYER_SAY:
                # If player is leader, allow them to decide whether to camp
                if active and active.role_id == world_state.leader_role_id:
                    world_state.phase = Phase.AWAIT_CAMP_DECISION
                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content=sys_received_say_leader_camp_or_forward(_lang(world_state)),
                            timestamp_ms=now_ms,
                        )
                    )
                else:
                    world_state.phase = Phase.FREE
                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content=sys_received_say_party_forward(_lang(world_state)),
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
                # Moving forward consumes stamina, mood, and supplies
                self._tweak_party(
                    world_state, stamina_delta=-3, mood_delta=-1, exp_delta=0, supplies_delta=-5
                )

                # If we are on an exit route and it turns rainy, retreat back to the junction.
                try:
                    edge_kind = None
                    if world_state.in_transit_from_node_id and world_state.in_transit_to_node_id:
                        for e in get_graph(getattr(world_state, "theme", "aotai")).outgoing(
                            world_state.in_transit_from_node_id
                        ):
                            if e.to_node_id == world_state.in_transit_to_node_id:
                                edge_kind = getattr(e, "kind", None)
                                break
                    if edge_kind == "exit" and str(world_state.weather) == "rainy":
                        messages.append(
                            Message(
                                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                                kind="system",
                                content=sys_retreat_rain(_lang(world_state)),
                                timestamp_ms=now_ms,
                            )
                        )
                        world_state.in_transit_from_node_id = None
                        world_state.in_transit_to_node_id = None
                        world_state.in_transit_progress_km = 0.0
                        world_state.in_transit_total_km = 0.0
                        world_state.available_next_node_ids = get_graph(
                            getattr(world_state, "theme", "aotai")
                        ).next_node_ids(world_state.current_node_id)
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

                    world_state.available_next_node_ids = get_graph(
                        getattr(world_state, "theme", "aotai")
                    ).next_node_ids(next_id)

                    ev = self._rng.choice(event_arrived_phrases(_lang(world_state)))
                    self._push_event(world_state, ev)
                    node_name = (
                        get_graph(getattr(world_state, "theme", "aotai")).get_node(next_id).name
                    )
                    messages.append(
                        Message(
                            message_id=f"sys-{uuid.uuid4().hex[:8]}",
                            kind="system",
                            content=sys_advance_km_arrived(
                                _lang(world_state), step_km, node_name, ev
                            ),
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
                            content=sys_advance_km_en_route(
                                _lang(world_state),
                                step_km,
                                world_state.in_transit_progress_km,
                                world_state.in_transit_total_km,
                                left,
                            ),
                            timestamp_ms=now_ms,
                        )
                    )
                    world_state.available_next_node_ids = []
                    return "MOVE_FORWARD:step"

            # Not in transit: choose next edge from current node.
            outgoing = get_graph(getattr(world_state, "theme", "aotai")).outgoing(
                world_state.current_node_id
            )
            if not outgoing:
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content=sys_end_no_route(_lang(world_state)),
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
                                content=sys_at_junction_choose_leader(_lang(world_state)),
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
                            content=sys_at_junction_leader_chose(
                                _lang(world_state),
                                leader_name,
                                get_graph(getattr(world_state, "theme", "aotai"))
                                .get_node(next_edge.to_node_id)
                                .name,
                            ),
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
                                content=sys_rainy_no_retreat_main(_lang(world_state)),
                                timestamp_ms=now_ms,
                            )
                        )
                    elif prev_id:
                        messages.append(
                            Message(
                                message_id=f"sys-{uuid.uuid4().hex[:8]}",
                                kind="system",
                                content=sys_rainy_no_retreat_back(_lang(world_state)),
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
            # Moving forward consumes stamina, mood, and supplies
            self._tweak_party(
                world_state, stamina_delta=-3, mood_delta=-1, exp_delta=0, supplies_delta=-5
            )
            if str(world_state.weather) in ("rainy", "snowy", "windy", "foggy"):
                world_state.stats.bad_weather_steps = (
                    int(world_state.stats.bad_weather_steps or 0) + 1
                )
            if str(world_state.weather) in ("rainy", "snowy", "windy", "foggy"):
                world_state.stats.bad_weather_steps = (
                    int(world_state.stats.bad_weather_steps or 0) + 1
                )

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

                world_state.available_next_node_ids = get_graph(
                    getattr(world_state, "theme", "aotai")
                ).next_node_ids(next_id)

                ev = self._rng.choice(event_arrived_phrases_start(_lang(world_state)))
                self._push_event(world_state, ev)
                node_name = get_graph(getattr(world_state, "theme", "aotai")).get_node(next_id).name
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content=sys_advance_km_arrived(_lang(world_state), step_km, node_name, ev),
                        timestamp_ms=now_ms,
                    )
                )
                if world_state.time_of_day == "night":
                    world_state.time_of_day = "evening"
                return f"MOVE_FORWARD:arrive:{next_id}"

            left = max(0.0, world_state.in_transit_total_km - world_state.in_transit_progress_km)
            to_name = (
                get_graph(getattr(world_state, "theme", "aotai"))
                .get_node(next_edge.to_node_id)
                .name
            )
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_depart_for_advance(
                        _lang(world_state),
                        to_name,
                        step_km,
                        world_state.in_transit_progress_km,
                        world_state.in_transit_total_km,
                        left,
                    ),
                    timestamp_ms=now_ms,
                )
            )
            return "MOVE_FORWARD:start"

        if req.action == ActionType.REST:
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=10, mood_delta=4, exp_delta=0)
            ev = self._rng.choice(event_rest_phrases(_lang(world_state)))
            self._push_event(world_state, ev)
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_you_choose_rest(_lang(world_state), ev),
                    timestamp_ms=now_ms,
                )
            )
            return "REST"

        if req.action == ActionType.CAMP:
            # Only leader can decide to camp
            if not active or active.role_id != world_state.leader_role_id:
                messages.append(
                    Message(
                        message_id=f"sys-{uuid.uuid4().hex[:8]}",
                        kind="system",
                        content=sys_only_leader_camp(_lang(world_state)),
                        timestamp_ms=now_ms,
                    )
                )
                node_after = get_graph(getattr(world_state, "theme", "aotai")).get_node(
                    world_state.current_node_id
                )
                bg = self._safe_get_background(node_after.scene_id)
                self._append_chat_history(world_state, messages)
                return ActResponse(world_state=world_state, messages=messages, background=bg)

            world_state.time_of_day = "night"
            ev = self._rng.choice(event_camp_phrases(_lang(world_state)))
            self._push_event(world_state, event_camp_label(_lang(world_state), ev))
            # Camping: restore stamina and mood, but consume more supplies
            self._tweak_party(
                world_state, stamina_delta=18, mood_delta=6, exp_delta=0, supplies_delta=-25
            )
            messages.append(
                Message(
                    message_id=f"sys-{uuid.uuid4().hex[:8]}",
                    kind="system",
                    content=sys_decide_camp(_lang(world_state), active.name, ev),
                    timestamp_ms=now_ms,
                )
            )
            world_state.day += 1
            world_state.time_of_day = "morning"
            world_state.time_step_counter = 0
            self._maybe_change_weather(world_state)
            # After camping, return to FREE phase
            if world_state.phase == Phase.AWAIT_CAMP_DECISION:
                world_state.phase = Phase.FREE
            return "CAMP"

        if req.action == ActionType.OBSERVE:
            self._advance_time(world_state)
            self._tweak_party(world_state, stamina_delta=-3, mood_delta=2, exp_delta=1)
            obs = self._rng.choice(event_observe_phrases(_lang(world_state)))
            self._push_event(world_state, event_observe_label(_lang(world_state), obs))
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
                content=sys_unimplemented_action(_lang(world_state), str(req.action)),
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
        self,
        world_state: WorldState,
        *,
        stamina_delta: int = 0,
        mood_delta: int = 0,
        exp_delta: int = 0,
        supplies_delta: int = 0,
    ) -> None:
        for r in world_state.roles:
            r.attrs.stamina = max(0, min(100, r.attrs.stamina + stamina_delta))
            r.attrs.mood = max(0, min(100, r.attrs.mood + mood_delta))
            r.attrs.experience = max(0, min(100, r.attrs.experience + exp_delta))
            # Ensure supplies are consumed correctly - update the value directly
            if supplies_delta != 0:
                r.attrs.supplies = max(0, min(100, r.attrs.supplies + supplies_delta))

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
        time_map = {
            "morning": "早晨",
            "noon": "中午",
            "afternoon": "下午",
            "evening": "傍晚",
            "night": "夜晚",
        }
        weather_map = {
            "sunny": "晴",
            "cloudy": "多云",
            "windy": "有风",
            "rainy": "雨",
            "snowy": "雪",
            "foggy": "雾",
        }

        action_name = getattr(req.action, "name", str(req.action))
        action_cn_map = {
            "SAY": "发言",
            "MOVE_FORWARD": "前进",
            "REST": "休息",
            "CAMP": "扎营",
            "OBSERVE": "观察",
            "DECIDE": "决策",
        }
        action_cn = action_cn_map.get(action_name, action_name)

        day = world_state.day
        tod_cn = time_map.get(world_state.time_of_day, str(world_state.time_of_day))
        weather_cn = weather_map.get(world_state.weather, str(world_state.weather))
        node_name = getattr(node, "name", "")

        recent_events = world_state.recent_events[-3:] if world_state.recent_events else []
        recent_events_txt = "；".join(recent_events)

        dialogue_msgs = [m for m in messages if m.kind != "system"]
        dialogue_parts: list[str] = []
        for m in dialogue_msgs[:3]:
            speaker = m.role_name or m.role_id or "队员"
            dialogue_parts.append(f"{speaker}：{m.content[:40]}")
        dialogue_txt = "；".join(dialogue_parts)

        pieces: list[str] = []
        pieces.append(f"第{day}天，{tod_cn}，天气{weather_cn}，位置：{node_name}。")
        pieces.append(f"动作：{action_cn}")
        if recent_events_txt:
            pieces.append(f"最近事件：{recent_events_txt}。")
        if dialogue_txt:
            pieces.append(f"关键对话：{dialogue_txt}。")

        return " ".join(pieces)

    def _build_memory_query(
        self, world_state: WorldState, req: ActRequest, node, user_action_desc: str
    ) -> str:
        active = self._get_active_role(world_state)
        persona = (active.persona if active else "")[:80]
        ev = "；".join(world_state.recent_events[-3:])
        tag = prompt_memory_tag_by_theme(_theme(world_state))
        return f"{tag} {node.name} {world_state.weather} {world_state.time_of_day} 动作:{req.action} {user_action_desc} 事件:{ev} 人设:{persona}"

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
