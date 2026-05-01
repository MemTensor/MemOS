import { describe, expect, it } from "vitest";

import { REWARD_R_HUMAN_PROMPT } from "../../../core/llm/prompts/reward.js";
import { buildTaskSummary } from "../../../core/reward/task-summary.js";
import type { EpisodeSnapshot } from "../../../core/session/types.js";
import type { EpochMs, TraceRow } from "../../../core/types.js";

function makeEpisode(partial?: Partial<EpisodeSnapshot>): EpisodeSnapshot {
  return {
    id: ("ep_summary" as unknown) as EpisodeSnapshot["id"],
    sessionId: ("s_summary" as unknown) as EpisodeSnapshot["sessionId"],
    startedAt: (1_700_000_000_000 as unknown) as EpochMs,
    endedAt: (1_700_000_010_000 as unknown) as EpochMs,
    status: "closed",
    rTask: null,
    turnCount: 2,
    turns: [
      { id: "t0", ts: (1_700_000_000_000 as unknown) as EpochMs, role: "user", content: "build me a web scraper" },
      { id: "t1", ts: (1_700_000_005_000 as unknown) as EpochMs, role: "assistant", content: "done, saved to /tmp/out.json" },
    ],
    traceIds: ["tr1"],
    meta: {},
    intent: { label: "task" } as unknown as EpisodeSnapshot["intent"],
    ...partial,
  };
}

function makeTrace(i: number, opts: Partial<TraceRow> & { tool?: string; text?: string } = {}): TraceRow {
  const toolCalls = opts.tool
    ? [
        {
          name: opts.tool,
          input: {},
          startedAt: (0 as unknown) as EpochMs,
          endedAt: (0 as unknown) as EpochMs,
        },
      ]
    : [];
  return {
    id: (`tr${i}` as unknown) as TraceRow["id"],
    episodeId: ("ep_summary" as unknown) as TraceRow["episodeId"],
    sessionId: ("s_summary" as unknown) as TraceRow["sessionId"],
    ts: ((1_700_000_000_000 + i * 100) as unknown) as EpochMs,
    userText: "",
    agentText: opts.text ?? `step ${i}`,
    toolCalls: toolCalls as TraceRow["toolCalls"],
    reflection: null,
    value: 0,
    alpha: 0 as TraceRow["alpha"],
    rHuman: null,
    priority: 0,
    tags: [],
    vecSummary: null,
    vecAction: null,
    turnId: 0 as never,
    schemaVersion: 1,
  };
}

describe("reward/task-summary", () => {
  it("tells the scorer not to project its own identity onto the host agent", () => {
    expect(REWARD_R_HUMAN_PROMPT.system).toContain("grading the HOST AGENT");
    expect(REWARD_R_HUMAN_PROMPT.system).toContain("Do NOT use your own model identity");
    expect(REWARD_R_HUMAN_PROMPT.system).toContain("hostModel/hostProvider");
  });

  it("builds a multi-turn exchange summary with user asks, steps, and final exchange", () => {
    const ep = makeEpisode();
    const traces = [makeTrace(1, { tool: "fetch" }), makeTrace(2, { text: "parsed JSON" })];
    const sum = buildTaskSummary({ episode: ep, traces, cfg: { summaryMaxChars: 1000 } });

    expect(sum.truncated).toBe(false);
    // The summary is now a chronological USER↔AGENT exchange block so
    // multi-topic episodes don't get pinned to just the first user turn.
    expect(sum.text).toMatch(/USER_ASKS_AND_AGENT_REPLIES \(/);
    expect(sum.text).toMatch(/MOST_RECENT_AGENT_REPLY:/);
    expect(sum.text).toMatch(/AGENT_STEPS \(2\)/);
    expect(sum.text).toMatch(/fetch/);
    expect(sum.text).toMatch(/parsed JSON/);
    expect(sum.outcome).toMatch(/saved to/);
  });

  it("pairs every user turn with its corresponding agent reply (multi-topic regression)", () => {
    // Regression guard for bug 2: a 上海天气 → 北京天气 style episode
    // must present BOTH asks to the scorer, not pin to the first one.
    const ep = makeEpisode({
      turns: [
        { id: "u1", ts: 1 as EpochMs, role: "user", content: "帮我查下上海明天的天气" },
        { id: "a1", ts: 2 as EpochMs, role: "assistant", content: "上海明天小雨" },
        { id: "u2", ts: 3 as EpochMs, role: "user", content: "能再查下北京天气吗" },
        { id: "a2", ts: 4 as EpochMs, role: "assistant", content: "北京明天晴天" },
      ],
    });
    const sum = buildTaskSummary({ episode: ep, traces: [], cfg: { summaryMaxChars: 1000 } });
    expect(sum.text).toContain("上海");
    expect(sum.text).toContain("北京");
    // MOST_RECENT_USER_ASK must be the second turn, not the first.
    expect(sum.text).toMatch(/MOST_RECENT_USER_ASK:\s*\n\s*能再查下北京天气吗/);
    expect(sum.text).toMatch(/MOST_RECENT_AGENT_REPLY:\s*\n\s*北京明天晴天/);
  });

  it("truncates overly long summaries with head+tail markers", () => {
    const ep = makeEpisode({
      turns: [
        { id: "t0", ts: 0 as EpochMs, role: "user", content: "goal".repeat(500) },
        { id: "t1", ts: 1 as EpochMs, role: "assistant", content: "OUTCOME_MARKER_END" },
      ],
    });
    const traces: TraceRow[] = [];
    const sum = buildTaskSummary({ episode: ep, traces, cfg: { summaryMaxChars: 200 } });
    expect(sum.truncated).toBe(true);
    expect(sum.text).toMatch(/truncated/);
    expect(sum.text).toContain("OUTCOME_MARKER_END");
  });

  it("falls back to descriptive placeholders when episode has no user/agent text", () => {
    const ep = makeEpisode({ turns: [] });
    const sum = buildTaskSummary({ episode: ep, traces: [], cfg: { summaryMaxChars: 500 } });
    expect(sum.userQuery).toBe("(no user text)");
    expect(sum.outcome).toBe("(no agent text)");
    expect(sum.agentActions).toBe("");
    expect(sum.text).toMatch(/\(no recorded steps\)/);
  });

  it("prefers tool call names over agent text for step one-liners", () => {
    const ep = makeEpisode();
    const traces = [makeTrace(1, { tool: "web.search", text: "this text should NOT appear" })];
    const sum = buildTaskSummary({ episode: ep, traces, cfg: { summaryMaxChars: 1000 } });
    expect(sum.agentActions).toMatch(/web\.search/);
    expect(sum.agentActions).not.toMatch(/this text should NOT appear/);
  });

  it("includes host and evaluator model context for identity-sensitive scoring", () => {
    const ep = makeEpisode({
      meta: {
        agent: "hermes",
        contextHints: {
          agentIdentity: "hermes",
          hostProvider: "custom",
          hostModel: "deepseek-v4-flash",
        },
      },
      turns: [
        { id: "u1", ts: 1 as EpochMs, role: "user", content: "现在是什么模型" },
        {
          id: "a1",
          ts: 2 as EpochMs,
          role: "assistant",
          content: "当前模型是 deepseek-v4-flash",
        },
      ],
    });

    const sum = buildTaskSummary({
      episode: ep,
      traces: [],
      cfg: { summaryMaxChars: 1000 },
      evaluator: {
        reflectionProvider: "openai_compatible",
        reflectionModel: "claude-sonnet-4-6-20260218",
        scorerProvider: "openai_compatible",
        scorerModel: "claude-sonnet-4-6-20260218",
      },
    });

    expect(sum.text).toMatch(/HOST_AGENT_CONTEXT:/);
    expect(sum.text).toContain("agent: hermes");
    expect(sum.text).toContain("hostProvider: custom");
    expect(sum.text).toContain("hostModel: deepseek-v4-flash");
    expect(sum.text).toContain("reflectionModel: claude-sonnet-4-6-20260218");
    expect(sum.text).toContain("scorerModel: claude-sonnet-4-6-20260218");
    expect(sum.text).toContain("do not project the evaluator model's own identity");
  });
});
