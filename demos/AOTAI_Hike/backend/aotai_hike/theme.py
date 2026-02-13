"""
Theme and prompt copy for zh (鳌太线) vs en (决胜乞力马扎罗 / Conquer Kilimanjaro).
All prompt and display strings that depend on the trek theme are centralized here.
"""

from __future__ import annotations

from typing import Literal


Lang = Literal["zh", "en"]


def _lang(ws: object) -> Lang:
    """Get lang from world_state-like object; default zh."""
    return getattr(ws, "lang", None) or "zh"


def _theme(ws: object) -> str:
    """Get theme (aotai | kili) from world_state-like object; default aotai."""
    return getattr(ws, "theme", None) or "aotai"


# ----- Theme names (for prompts and share card) -----


def theme_trek_name(lang: Lang) -> str:
    """Short trek name in the story language."""
    if lang == "en":
        return "Kilimanjaro"
    return "鳌太线"


def theme_trek_name_full(lang: Lang) -> str:
    """Full theme title for share card / UI."""
    if lang == "en":
        return "Conquer Kilimanjaro"  # 决胜乞力马扎罗
    return "鳌太线"


def share_title(lang: Lang) -> str:
    """Share image main title."""
    if lang == "en":
        return "Kilimanjaro Trek Record"
    return "鳌太线徒步记录"


def share_outcome_success_cross(lang: Lang, node_name: str) -> str:
    if lang == "en":
        return f"✓ Summit success - Reached {node_name}"
    return f"✓ 穿越成功 - 成功到达{node_name}"


def share_outcome_success_retreat(lang: Lang, node_name: str) -> str:
    if lang == "en":
        return f"✓ Retreat success - Evacuated to {node_name}"
    return f"✓ 下撤成功 - 成功下撤至{node_name}"


def share_outcome_fail(lang: Lang, reason: str | None) -> str:
    if lang == "en":
        return f"✗ {reason}" if reason else "✗ Challenge failed"
    return f"✗ {reason}" if reason else "✗ 挑战失败"


def share_status_running(lang: Lang) -> str:
    if lang == "en":
        return "In progress..."
    return "进行中..."


def share_result_finished_success(lang: Lang) -> str:
    if lang == "en":
        return "Summit success"
    return "穿越成功"


def share_result_finished_fail(lang: Lang) -> str:
    if lang == "en":
        return "Challenge failed"
    return "挑战失败"


def share_result_running(lang: Lang) -> str:
    if lang == "en":
        return "In progress..."
    return "进行中..."


def share_stat_distance(lang: Lang) -> str:
    if lang == "en":
        return "Total distance"
    return "总距离"


def share_stat_days(lang: Lang) -> str:
    if lang == "en":
        return "Days"
    return "用时"


def share_stat_location(lang: Lang) -> str:
    if lang == "en":
        return "Current location"
    return "当前位置"


def share_role_leader(lang: Lang) -> str:
    if lang == "en":
        return "Leader"
    return "队长"


def share_team_stat_stamina(lang: Lang) -> str:
    if lang == "en":
        return "Avg stamina"
    return "体力均值"


def share_team_stat_mood(lang: Lang) -> str:
    if lang == "en":
        return "Avg mood"
    return "士气均值"


def share_team_stat_risk(lang: Lang) -> str:
    if lang == "en":
        return "Avg risk"
    return "风险均值"


# ----- Prompt fragments (for companion system prompts) -----


def prompt_story_context_line(lang: Lang, day: int, time_of_day: str, weather: str) -> str:
    if lang == "en":
        return (
            f"You are a trekking team crossing the dangerous Kilimanjaro route. "
            f"Day {day}, current time: {time_of_day}, weather: {weather}.\n"
        )
    return f"你们是一支徒步队伍，正在穿越危险的鳌太线。今天是第{day}天，当前时间是{time_of_day}，天气：{weather}。\n"


def prompt_night_vote_intro(lang: Lang) -> str:
    """Night vote system prompt intro."""
    if lang == "en":
        return (
            "You are in a Kilimanjaro trek story game. It is night; the team must choose tonight's leader.\n"
            "You will play the current speaker. Based on each member's personality, recent state and dialogue, make a rational but subjective choice.\n\n"
        )
    return (
        "你正在参与鳌太线徒步剧情游戏，现在是夜晚，需要在队伍中选出一位今晚的队长。\n"
        "你将扮演当前说话的队员，根据每个人的性格、人设、最近状态和对话，做出理性但有主观色彩的选择。\n\n"
    )


def prompt_night_vote_output_requirement(lang: Lang) -> str:
    if lang == "en":
        return (
            "【Output requirement】\n"
            "1. Choose exactly one leader from the candidate list by id.\n"
            "2. Output a JSON object in this exact format:\n"
            '{"vote_role_id": "<candidate_id>", "reason": "<reason in under 40 chars>"}\n'
            "3. No extra text, no comments, no prefix/suffix.\n"
        )
    return (
        "【输出要求】\n"
        "1. 只能从候选人列表中的 id 里选择一位作为队长。\n"
        "2. 请输出一个 JSON 对象，格式严格为：\n"
        '{"vote_role_id": "<候选人id>", "reason": "<不超过40字的中文理由>"}\n'
        "3. 不要输出任何多余文字，不要加注释，不要加前后缀。\n"
    )


def prompt_night_vote_query(lang: Lang, voter_name: str) -> str:
    if lang == "en":
        return f'You are team member "{voter_name}". Choose tonight\'s leader from the candidates and give a short reason.'
    return f"你是队员「{voter_name}」，请在候选人中选出今晚的队长，并给出一句理由。"


def prompt_section_candidates(lang: Lang) -> str:
    if lang == "en":
        return "【Candidates】"
    return "【候选人列表】"


def prompt_section_memories(lang: Lang) -> str:
    if lang == "en":
        return "【Your memory snippets】"
    return "【你的记忆片段】"


def prompt_section_dialogue(lang: Lang) -> str:
    if lang == "en":
        return "【Recent dialogue】"
    return "【最近对话】"


def prompt_memory_tag(lang: Lang) -> str:
    """Prefix for memory search / query (e.g. 鳌太线 or Kilimanjaro). Deprecated: use prompt_memory_tag_by_theme."""
    if lang == "en":
        return "Kilimanjaro"
    return "鳌太线"


def prompt_memory_tag_by_theme(theme: str | None) -> str:
    """Prefix for memory search by theme (aotai = 鳌太线, kili = Kilimanjaro)."""
    return "Kilimanjaro" if theme == "kili" else "鳌太线"


# ----- System messages (game_service) -----


def sys_today_leader(lang: Lang, name: str) -> str:
    if lang == "en":
        return f"Today's leader: {name}"
    return f"今日团长：{name}"


def sys_location_weather_time(lang: Lang, node_name: str, weather: str, day: int, tod: str) -> str:
    if lang == "en":
        return f"Location: {node_name} · Weather: {weather} · Time: Day{day}/{tod}"
    return f"位置：{node_name} · 天气：{weather} · 时间：Day{day}/{tod}"


def sys_night_fall_say_first(lang: Lang) -> str:
    if lang == "en":
        return "Night has fallen. Please say something first, then the leader vote will start."
    return "夜幕降临：请你先发言（发送一句话）后，才能开始票选团长。"


def sys_night_vote_ready(lang: Lang) -> str:
    if lang == "en":
        return "Night vote ready. Please choose a leader to continue."
    return "夜晚票选准备就绪：请选择一位队长继续。"


def sys_need_say_first(lang: Lang) -> str:
    if lang == "en":
        return "Please reply with a message first (say something) before continuing."
    return "需要你先用「发言」回应队伍（发送一句话）后才能继续。"


def sys_camp_or_forward(lang: Lang) -> str:
    if lang == "en":
        return "Choose: camp to restore stamina, or continue forward."
    return "请选择：扎营恢复体力，或继续前进。"


def sys_teammate_look_at_you(lang: Lang) -> str:
    if lang == "en":
        return "Your teammate looks at you: your turn to speak (say something to continue)."
    return "队友看向你：轮到你发言了（发一句话后才能继续）。"


def sys_unknown_decision(lang: Lang, kind: str) -> str:
    if lang == "en":
        return f"Unknown decision type: {kind}"
    return f"未知决策类型：{kind}"


def sys_vote_failed_empty(lang: Lang) -> str:
    if lang == "en":
        return "Vote failed: party is empty."
    return "票选失败：队伍为空。"


def sys_start_leader_vote(lang: Lang) -> str:
    if lang == "en":
        return "Leader vote: everyone casts one vote."
    return "开始票选团长：每人投一票。"


def sys_vote_action(lang: Lang, voter_name: str, choice_name: str, reason: str) -> str:
    if lang == "en":
        return f"{voter_name} voted: {choice_name} (reason: {reason})"
    return f"{voter_name} 投票：{choice_name}（理由：{reason}）"


def sys_vote_action_short(lang: Lang, voter_name: str, choice_name: str) -> str:
    if lang == "en":
        return f"{voter_name} voted: {choice_name}"
    return f"{voter_name} 投票：{choice_name}"


def sys_vote_result_change(lang: Lang, old_name: str, new_name: str) -> str:
    if lang == "en":
        return f"Vote result: leader changed {old_name} → {new_name}"
    return f"票选结果：更换团长 {old_name} → {new_name}"


def sys_vote_result_keep(lang: Lang, new_name: str) -> str:
    if lang == "en":
        return f"Vote result: {new_name} remains leader."
    return f"票选结果：团长继续由 {new_name} 担任。"


def sys_camp_meeting(lang: Lang) -> str:
    if lang == "en":
        return "Camp meeting: choose consensus route, lock strength, and tomorrow's leader, then submit to enter next morning."
    return "营地会议：请选择「共识路线/锁强度/明日团长」，提交后进入第二天早晨。"


def sys_night_camp_meeting(lang: Lang) -> str:
    if lang == "en":
        return "Night: camp meeting starts (automatic)."
    return "夜晚到来：营地会议开始（自动）。"


def sys_camp_proposal_dest(lang: Lang, dest: str) -> str:
    if lang == "en":
        return f"I suggest we go to {dest} tomorrow."
    return f"明天我建议：去 {dest}。"


def sys_camp_proposal_rest(lang: Lang) -> str:
    if lang == "en":
        return "I suggest we rest here and decide tomorrow."
    return "明天我建议：先原地休整再决定。"


def sys_camp_meeting_result_vote(lang: Lang, old_name: str, new_name: str, changed: bool) -> str:
    if lang == "en":
        return (
            f"Camp meeting (vote): leader changed {old_name} → {new_name}"
            if changed
            else f"Camp meeting (vote): {new_name} remains leader."
        )
    return (
        f"营地会议结果（票选）：更换团长 {old_name} → {new_name}"
        if changed
        else f"营地会议结果（票选）：团长继续由 {new_name} 担任。"
    )


def sys_received_say_choose_leader(lang: Lang) -> str:
    if lang == "en":
        return "Message received. Now choose a leader to start the vote."
    return "收到你的发言：现在请选择一位队长开始票选。"


def sys_received_say_leader_camp_or_forward(lang: Lang) -> str:
    if lang == "en":
        return "Message received. As leader, you can camp to restore stamina or continue forward."
    return "收到你的回应。作为队长，你可以选择扎营恢复体力，或继续前进。"


def sys_received_say_party_forward(lang: Lang) -> str:
    if lang == "en":
        return "Message received. The party continues forward."
    return "收到你的回应，队伍继续前进。"


def sys_retreat_rain(lang: Lang) -> str:
    if lang == "en":
        return "Retreat in rain failed; returning to junction to continue."
    return "下撤途中遇雨，撤退失败，返回岔路继续前进。"


def sys_advance_km_arrived(lang: Lang, step_km: float, node_name: str, ev: str) -> str:
    if lang == "en":
        return f"Advanced {step_km:.0f}km, arrived at: {node_name}. {ev}"
    return f"前进 {step_km:.0f}km，已抵达：{node_name}。{ev}"


def sys_advance_km_en_route(
    lang: Lang, step_km: float, progress: float, total: float, left: float
) -> str:
    if lang == "en":
        return (
            f"Advanced {step_km:.0f}km, en route… ({progress:.0f}/{total:.0f}km, {left:.0f}km left)"
        )
    return f"前进 {step_km:.0f}km，路上…（{progress:.0f}/{total:.0f}km，剩余 {left:.0f}km）"


def sys_depart_for_advance(
    lang: Lang, node_name: str, step_km: float, progress: float, total: float, left: float
) -> str:
    if lang == "en":
        return f"Depart for {node_name}, advance {step_km:.0f}km… ({progress:.0f}/{total:.0f}km, {left:.0f}km left)"
    return f"出发去 {node_name}，前进 {step_km:.0f}km…（{progress:.0f}/{total:.0f}km，剩余 {left:.0f}km）"


def sys_end_no_route(lang: Lang) -> str:
    if lang == "en":
        return "Reached the end / no route forward."
    return "已到达终点/无可用前进路线。"


def sys_at_junction_choose_leader(lang: Lang) -> str:
    if lang == "en":
        return "At junction: please choose the route (as leader)."
    return "到达岔路：请团长选择路线。"


def sys_at_junction_leader_chose(lang: Lang, leader_name: str, node_name: str) -> str:
    if lang == "en":
        return f"At junction: {leader_name} chose → {node_name}."
    return f"到达岔路：{leader_name}做出选择 → {node_name}。"


def sys_rainy_no_retreat_main(lang: Lang) -> str:
    if lang == "en":
        return "Rain: retreat not suitable; taking main route instead."
    return "雨天不适合下撤，改走主线路线。"


def sys_rainy_no_retreat_back(lang: Lang) -> str:
    if lang == "en":
        return "Rain: cannot retreat; going back one step."
    return "雨天无法下撤，只能回撤上一步。"


def sys_only_leader_camp(lang: Lang) -> str:
    if lang == "en":
        return "Only the leader can decide to camp."
    return "只有队长可以决定扎营。"


def sys_you_choose_rest(lang: Lang, ev: str) -> str:
    if lang == "en":
        return f"You chose to rest. {ev}"
    return f"你选择休息。{ev}"


def sys_decide_camp(lang: Lang, name: str, ev: str) -> str:
    if lang == "en":
        return f"{name} decided to camp. {ev} Stamina restored, but used more supplies."
    return f"{name}决定扎营。{ev} 体力恢复，但消耗了较多物资。"


def sys_unimplemented_action(lang: Lang, action: str) -> str:
    if lang == "en":
        return f"Unimplemented action: {action}"
    return f"未实现动作：{action}"


def sys_silence(lang: Lang) -> str:
    if lang == "en":
        return "(silence)"
    return "（沉默）"


# Event phrases (for Message content / _push_event); lang-aware lists
def event_arrived_phrases(lang: Lang) -> list[str]:
    if lang == "en":
        return [
            "You see the landmark ahead.",
            "Steady steps, you've arrived.",
            "The wind fades as you reach the node.",
        ]
    return ["你终于看见前方地标。", "脚步放轻，稳稳抵达。", "风声渐远，你到达了节点。"]


def event_arrived_phrases_start(lang: Lang) -> list[str]:
    if lang == "en":
        return ["You reach a new landmark.", "The slope underfoot changes.", "The view opens up."]
    return ["你来到新的地标。", "脚下坡度变化明显。", "视野忽然开阔。"]


def event_rest_phrases(lang: Lang) -> list[str]:
    if lang == "en":
        return ["Rehydrate and rest.", "Adjust the pack.", "Slow your breath.", "Soak up the sun."]
    return ["补水休整。", "调整背负。", "放慢呼吸。", "晒晒太阳。"]


def event_camp_phrases(lang: Lang) -> list[str]:
    if lang == "en":
        return ["Light the stove.", "Pitch the tent.", "Assign watch.", "Check supplies."]
    return ["升起炉火。", "搭好帐篷。", "分配守夜。", "检查余粮。"]


def event_camp_label(lang: Lang, ev: str) -> str:
    if lang == "en":
        return f"Camp: {ev}"
    return f"扎营：{ev}"


def event_observe_phrases(lang: Lang) -> list[str]:
    if lang == "en":
        return [
            "You observe clouds rolling in the distance.",
            "You notice footprints and broken branches.",
            "You note a steadier foothold.",
            "You hear a faint echo in the wind.",
        ]
    return [
        "你观察到远处云层翻涌。",
        "你发现脚印与折断的灌木。",
        "你记录了一个更稳的落脚点。",
        "你听见风里隐约的回声。",
    ]


def event_observe_label(lang: Lang, obs: str) -> str:
    if lang == "en":
        return f"Observe: {obs}"
    return f"观察：{obs}"
