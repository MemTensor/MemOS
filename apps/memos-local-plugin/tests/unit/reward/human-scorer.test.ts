import { describe, expect, it } from "vitest";

import { heuristicScore, scoreHuman } from "../../../core/reward/human-scorer.js";
import type { HumanScoreInput, UserFeedback } from "../../../core/reward/types.js";
import { fakeLlm, throwingLlm } from "../../helpers/fake-llm.js";

function makeSummary(): HumanScoreInput["episodeSummary"] {
  return {
    episodeId: "ep_1" as unknown as HumanScoreInput["episodeSummary"]["episodeId"],
    sessionId: "s_1" as unknown as HumanScoreInput["episodeSummary"]["sessionId"],
    userQuery: "deploy my docker image",
    agentActions: "1. docker build\n2. docker push",
    outcome: "pushed registry.example.com/app:v1",
    text: "USER_QUERY: deploy my docker image\n\nAGENT_STEPS: …",
    truncated: false,
  };
}

function makeFeedback(partial: Partial<UserFeedback> = {}): UserFeedback {
  return {
    id: "fb_1" as unknown as UserFeedback["id"],
    episodeId: "ep_1" as unknown as UserFeedback["episodeId"],
    sessionId: "s_1" as unknown as UserFeedback["sessionId"],
    traceId: null,
    ts: 1_700_000_000_000 as UserFeedback["ts"],
    channel: "explicit",
    polarity: "positive",
    magnitude: 0.9,
    text: "perfect, thanks",
    rationale: null,
    ...partial,
  };
}

describe("reward/human-scorer", () => {
  it("heuristic: no feedback → rHuman=0", () => {
    const h = heuristicScore([]);
    expect(h.rHuman).toBe(0);
    expect(h.source).toBe("heuristic");
  });

  it("heuristic: explicit positive → positive rHuman", () => {
    const h = heuristicScore([makeFeedback()]);
    expect(h.rHuman).toBeGreaterThan(0);
    expect(h.source).toBe("explicit");
    expect(h.axes.userSatisfaction).toBeGreaterThan(0);
  });

  it("heuristic: explicit negative → negative rHuman", () => {
    const h = heuristicScore([makeFeedback({ polarity: "negative", text: "wrong" })]);
    expect(h.rHuman).toBeLessThan(0);
  });

  it("heuristic: aggregates multiple explicit corrections by magnitude", () => {
    const h = heuristicScore([
      makeFeedback({ id: "fb_pos" as never, polarity: "positive", magnitude: 1 }),
      makeFeedback({ id: "fb_neg" as never, polarity: "negative", magnitude: 0.5 }),
    ]);
    expect(h.source).toBe("explicit");
    expect(h.rHuman).toBeCloseTo(1 / 3);
    expect(h.axes.userSatisfaction).toBeCloseTo(1 / 3);
  });

  it("LLM mode: happy path, uses the LLM and reports llm source", async () => {
    const llm = fakeLlm({
      completeJson: {
        "reward.reward.r_human.v4": {
          goal_achievement: 0.9,
          process_quality: 0.5,
          user_satisfaction: 0.8,
          label: "success",
          reason: "image pushed to requested registry",
        },
      },
    });
    const out = await scoreHuman(
      { episodeSummary: makeSummary(), feedback: [makeFeedback()] },
      { llm, cfg: { llmScoring: true } },
    );
    expect(out.source).toBe("llm");
    expect(out.rHuman).toBeGreaterThan(0.5);
    expect(out.axes.goalAchievement).toBeCloseTo(0.9);
    expect(out.axes.processQuality).toBeCloseTo(0.5);
    expect(out.axes.userSatisfaction).toBeCloseTo(0.8);
    expect(out.reason).toMatch(/registry/);
    expect(out.model).toBe("openai_compatible");
  });

  it("LLM mode: clamps axes to [-1, 1]", async () => {
    const llm = fakeLlm({
      completeJson: {
        "reward.reward.r_human.v4": {
          goal_achievement: 5,
          process_quality: -3,
          user_satisfaction: 2,
          label: "success",
          reason: "ok",
        },
      },
    });
    const out = await scoreHuman(
      { episodeSummary: makeSummary(), feedback: [] },
      { llm, cfg: { llmScoring: true } },
    );
    expect(out.axes.goalAchievement).toBeCloseTo(1);
    expect(out.axes.processQuality).toBeCloseTo(-1);
    expect(out.axes.userSatisfaction).toBeCloseTo(1);
    expect(out.rHuman).toBeGreaterThan(-1);
    expect(out.rHuman).toBeLessThan(1);
  });

  it("LLM mode: rejects non-numeric axes (via validate) → falls back to heuristic", async () => {
    const llm = fakeLlm({
      completeJson: {
        "reward.reward.r_human.v4": { goal_achievement: "yes", process_quality: 0, user_satisfaction: 0 },
      },
    });
    const out = await scoreHuman(
      { episodeSummary: makeSummary(), feedback: [makeFeedback()] },
      { llm, cfg: { llmScoring: true } },
    );
    expect(out.source).toBe("heuristic");
  });

  it("LLM error → heuristic fallback", async () => {
    const out = await scoreHuman(
      { episodeSummary: makeSummary(), feedback: [makeFeedback({ polarity: "negative" })] },
      { llm: throwingLlm(new Error("boom")), cfg: { llmScoring: true } },
    );
    expect(out.source).toBe("heuristic");
    expect(out.rHuman).toBeLessThan(0);
  });

  it("cfg.llmScoring=false skips LLM even if one is wired", async () => {
    const llm = fakeLlm({});
    const out = await scoreHuman(
      { episodeSummary: makeSummary(), feedback: [makeFeedback()] },
      { llm, cfg: { llmScoring: false } },
    );
    expect(out.source).toBe("explicit");
    expect(out.model).toBeNull();
  });

  it("missing LLM binding → heuristic, regardless of cfg", async () => {
    const out = await scoreHuman(
      { episodeSummary: makeSummary(), feedback: [makeFeedback()] },
      { llm: null, cfg: { llmScoring: true } },
    );
    expect(out.source).toBe("explicit");
  });

  it("LLM mode: feedback formatted with USER/INFERRED labels and ISO timestamp", async () => {
    let capturedUserContent = "";
    const llm = fakeLlm({
      completeJson: {
        "reward.reward.r_human.v4": (input: unknown) => {
          const msgs = input as Array<{ role: string; content: string }>;
          capturedUserContent = msgs.find((m) => m.role === "user")?.content ?? "";
          return {
            goal_achievement: 0.8,
            process_quality: 0.5,
            user_satisfaction: 0.7,
            label: "success",
            reason: "ok",
          };
        },
      },
    });

    await scoreHuman(
      {
        episodeSummary: makeSummary(),
        feedback: [
          makeFeedback({ channel: "explicit", polarity: "positive", ts: 1_700_000_000_000 as UserFeedback["ts"] }),
          makeFeedback({ id: "fb_2" as never, channel: "implicit", polarity: "negative", ts: 1_700_000_001_000 as UserFeedback["ts"], text: "bad response" }),
        ],
      },
      { llm, cfg: { llmScoring: true } },
    );

    expect(capturedUserContent).toContain("[USER/positive @");
    expect(capturedUserContent).toContain("[INFERRED/negative @");
    expect(capturedUserContent).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
