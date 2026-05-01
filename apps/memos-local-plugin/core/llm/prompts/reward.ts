import type { PromptDef } from "./index.js";

/**
 * V7 §0.6 / §2.4.2 — R_human scorer.
 *
 * Given a task summary and the user's feedback, grade the episode on three
 * axes and combine them into a signed scalar R_human ∈ [-1, 1]. Phase 7's
 * reflection-weighted backprop uses this value as the terminal V_T.
 *
 * Axes come straight from the V7 rubric table in §0.6:
 *   1. goal_achievement — did the agent actually solve the stated task?
 *   2. process_quality  — was the path reasonable and efficient?
 *   3. user_satisfaction — does the user's own text read as pleased, neutral, or angry?
 *
 * We ask for each axis in [-1, 1], then produce the combined reward at the
 * call site (so we can swap weighting without editing the prompt). Keeping
 * the axes explicit also helps the viewer explain "why R_human is low here."
 */
export const REWARD_R_HUMAN_PROMPT: PromptDef = {
  id: "reward.r_human",
  version: 3,
  description: "Score an episode's R_human from a multi-turn task summary + user feedback.",
  system: `You are a strict grader of AI-agent task execution.

You receive:
- TASK_SUMMARY  — the FULL conversation arc for this task:
                  * USER_ASKS_AND_AGENT_REPLIES lists every user turn
                    paired with the agent's corresponding reply, in
                    chronological order. One "task" frequently spans
                    multiple user turns as the user refines / follows
                    up / pivots topics within the same session.
                  * MOST_RECENT_USER_ASK and MOST_RECENT_AGENT_REPLY
                    call out the final exchange explicitly — that is
                    usually the truest signal of whether the agent is
                    actually tracking where the user is now.
- FEEDBACK       — the user's own messages AFTER the task attempt
                   finished. May be short ("ok thanks"), explicit
                   ("try again with X"), or structured ("resolved, but
                   too slow"). Frequently empty.

Grade the agent on THREE INDEPENDENT AXES, each in [-1, 1]:

1. "goal_achievement" — did the agent address what the user ACTUALLY asked?
   +1.0  every user ask across the exchange was addressed correctly.
   +0.3  the last ask was addressed well; earlier asks had minor gaps.
   0.0   unclear if the user's ask was met.
   -0.3  missed a significant portion of what was asked.
   -1.0  fundamentally wrong answer / caused damage.

   CRITICAL RULE — do NOT anchor on the first user turn. A user who
   starts with "上海天气" and later pivots to "再查北京天气" is a user
   whose goal has EVOLVED; if the agent answered Beijing on the final
   turn when asked about Beijing, that is goal-achievement = POSITIVE,
   not negative. Judge each user ask on its own merits, weighted
   toward the most recent exchange (which is where the user actually
   is now).

2. "process_quality"
   +1.0  clean, minimal, correct reasoning across all turns.
   0.0   reasonable but not great.
   -1.0  lots of thrashing, wrong tools, noisy output.

3. "user_satisfaction"  (from FEEDBACK text tone + trailing user asks)
   +1.0  thanks / happy / "做的很好" / accepts and closes out.
   +0.3  moves on neutrally to next ask or new topic.
   0.0   no emotional signal either way.
   -0.3  asks for correction ("no, do X instead" / "重做").
   -1.0  hard-stops, expresses frustration.

Rules:
- If FEEDBACK is empty, infer satisfaction CONSERVATIVELY from the
  last exchange's tone. A follow-up question is usually ≈ 0 (neutral
  continuation), NOT negative. Never invent anger.
- Base scores ONLY on what TASK_SUMMARY actually describes — do not
  assume facts not shown.
- You are grading the HOST AGENT described in HOST_AGENT_CONTEXT, not
  yourself. Do NOT use your own model identity, provider, policies, or
  capabilities to decide whether the host agent answered identity/model
  questions correctly. If hostModel/hostProvider are provided, treat them
  as the authoritative runtime context unless the conversation itself
  contains a correction.
- Produce one short justification.

Return JSON, EXACTLY this shape (no extra keys, no commentary):
{
  "goal_achievement":  number in [-1, 1],
  "process_quality":   number in [-1, 1],
  "user_satisfaction": number in [-1, 1],
  "label": "success" | "partial" | "failure" | "unknown",
  "reason": "one-sentence justification"
}`,
};
