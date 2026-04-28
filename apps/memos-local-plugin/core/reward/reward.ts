/**
 * `reward.ts` — pipeline orchestrator for Phase 7.
 *
 * Lifecycle:
 *   1. Caller invokes `runner.run({episodeId, feedback, trigger})`.
 *   2. We load the episode + its traces from storage.
 *   3. Build the task summary (`task-summary.ts`).
 *   4. Score R_human (`human-scorer.ts` — LLM or heuristic).
 *   5. Backprop V_t + priority (`backprop.ts`).
 *   6. Persist: tracesRepo.updateScore(...) and episodesRepo.setRTask(...).
 *   7. Emit `reward.updated` so downstream (L2 incremental induction, skill
 *      crystallizer, viewer) can react.
 *
 * The runner never throws on recoverable failures — LLM errors fall back
 * to heuristic scoring, persist errors are reported in `warnings` but
 * don't crash the agent.  A total DB failure does throw; the caller
 * (subscriber) logs and moves on.
 */

import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import type { EpisodeId, EpochMs, TraceRow } from "../types.js";
import type { makeEpisodesRepo } from "../storage/repos/episodes.js";
import type { makeFeedbackRepo } from "../storage/repos/feedback.js";
import type { makeTracesRepo } from "../storage/repos/traces.js";
import { backprop } from "./backprop.js";
import { scoreHuman } from "./human-scorer.js";
import { buildTaskSummary } from "./task-summary.js";
import type {
  RewardConfig,
  RewardEventBus,
  RewardInput,
  RewardResult,
  UserFeedback,
} from "./types.js";

type TracesRepo = ReturnType<typeof makeTracesRepo>;
type EpisodesRepo = ReturnType<typeof makeEpisodesRepo>;
type FeedbackRepo = ReturnType<typeof makeFeedbackRepo>;

export interface RewardDeps {
  tracesRepo: TracesRepo;
  episodesRepo: EpisodesRepo;
  feedbackRepo: FeedbackRepo;
  llm: LlmClient | null;
  bus: RewardEventBus;
  cfg: RewardConfig;
  now?: () => number;
  /**
   * Optional accessor for the episode snapshot (turns + meta). If omitted,
   * we fall back to the episodes repo's `getById`, which returns a header
   * row without turns — fine for summary building since we also have the
   * trace list. When the orchestrator (Phase 15) has a fresher snapshot in
   * memory, it can inject one here.
   */
  getEpisodeSnapshot?: (id: EpisodeId) => import("../session/types.js").EpisodeSnapshot | null;
}

export interface RewardRunner {
  run(input: RewardInput): Promise<RewardResult>;
}

export function createRewardRunner(deps: RewardDeps): RewardRunner {
  const log = rootLogger.child({ channel: "core.reward" });
  const now = deps.now ?? Date.now;

  if (!deps.llm) {
    log.warn("reward.llm_unavailable", {
      impact: "R_human will use heuristic fallback (always 0 without explicit feedback); L2/Skill/L3 pipelines will be skipped",
      fix: "configure a working LLM provider in config.yaml or ensure the host bridge is attached",
    });
  }

  async function run(input: RewardInput): Promise<RewardResult> {
    const startedAt = now() as EpochMs;
    const warnings: RewardResult["warnings"] = [];

    // Step 0: look up episode + traces.
    const episode = deps.episodesRepo.getById(input.episodeId);
    if (!episode) {
      throw new MemosError(ERROR_CODES.EPISODE_NOT_FOUND, "episode not found", {
        episodeId: input.episodeId,
      });
    }
    const snapshot =
      deps.getEpisodeSnapshot?.(input.episodeId) ?? fallbackSnapshotFromRow(episode);

    const tMetrics = { summary: 0, score: 0, backprop: 0, persist: 0 } as Record<string, number>;

    // Step 1: summary.
    const tSumStart = now();
    const traceIds = episode.traceIds ?? [];
    const traces: TraceRow[] =
      traceIds.length > 0
        ? deps.tracesRepo
            .getManyByIds(traceIds as TraceRow["id"][])
            .sort((a, b) => a.ts - b.ts)
        : [];

    // Step 0.5: triviality gate. Mirrors the legacy memos-local-openclaw
    // `shouldSkipSummary` rule so single-message / trivial-content
    // episodes don't pollute the Tasks view with fake "completed"
    // badges and — more importantly — don't leak into L2 induction as
    // if they were real proof of a pattern.
    const skipReason = decideSkipReason(snapshot, traces, deps.cfg);
    if (skipReason) {
      log.info("reward.skipped", {
        episodeId: input.episodeId,
        sessionId: episode.sessionId,
        reason: skipReason,
      });
      try {
        deps.episodesRepo.updateMeta(input.episodeId, {
          closeReason: "abandoned",
          abandonReason: skipReason,
          reward: {
            source: "heuristic",
            reason: skipReason,
            scoredAt: startedAt,
            trigger: input.trigger,
            skipped: true,
          },
        });
      } catch (err) {
        warnings.push({
          stage: "persist.episode.meta",
          message: "failed to stamp skip reason",
          detail: errDetail(err),
        });
      }
      const completedAt = now() as EpochMs;
      const skipped: RewardResult = {
        episodeId: input.episodeId,
        sessionId: episode.sessionId,
        rHuman: 0,
        humanScore: {
          rHuman: 0,
          axes: {
            goalAchievement: 0,
            processQuality: 0,
            userSatisfaction: 0,
          },
          reason: skipReason,
          source: "heuristic",
          model: null,
        },
        feedbackCount: 0,
        backprop: {
          updates: [],
          meanAbsValue: 0,
          maxPriority: 0,
          echoParams: {
            gamma: deps.cfg.gamma,
            decayHalfLifeDays: deps.cfg.decayHalfLifeDays,
            now: startedAt,
          },
        },
        traceIds: [],
        timings: { summary: 0, score: 0, backprop: 0, persist: 0, total: completedAt - startedAt },
        warnings,
        startedAt,
        completedAt,
      };
      // We deliberately do NOT emit `reward.updated` — the L2/L3/skill
      // subscribers must not see skipped episodes. Emit a dedicated
      // `reward.scored` with a null source so the api_logs row still
      // records something.
      deps.bus.emit({
        kind: "reward.scored",
        episodeId: input.episodeId,
        sessionId: episode.sessionId,
        rHuman: 0,
        source: "heuristic",
      });
      return skipped;
    }
    const summary = buildTaskSummary({
      episode: snapshot,
      traces,
      cfg: { summaryMaxChars: deps.cfg.summaryMaxChars },
    });
    tMetrics.summary = now() - tSumStart;

    deps.bus.emit({
      kind: "reward.scheduled",
      episodeId: input.episodeId,
      sessionId: episode.sessionId,
    });

    // Step 2: score.
    const tScoreStart = now();
    const mergedFeedback = mergeFeedback(
      input.feedback,
      deps.feedbackRepo.getForEpisode(input.episodeId) as unknown as UserFeedback[],
    );
    const humanScore = await scoreHuman(
      { episodeSummary: summary, feedback: mergedFeedback },
      { llm: deps.llm, cfg: { llmScoring: deps.cfg.llmScoring } },
    );
    tMetrics.score = now() - tScoreStart;

    deps.bus.emit({
      kind: "reward.scored",
      episodeId: input.episodeId,
      sessionId: episode.sessionId,
      rHuman: humanScore.rHuman,
      source: humanScore.source,
    });

    // Step 3: backprop.
    const tBackStart = now();
    const bp = backprop({
      traces,
      rHuman: humanScore.rHuman,
      gamma: deps.cfg.gamma,
      decayHalfLifeDays: deps.cfg.decayHalfLifeDays,
      now: startedAt,
    });
    tMetrics.backprop = now() - tBackStart;

    // Step 4: persist.
    const tPersistStart = now();
    try {
      for (const u of bp.updates) {
        deps.tracesRepo.updateScore(u.traceId, {
          value: u.value,
          alpha: u.alpha,
          priority: u.priority,
        });
      }
    } catch (err) {
      warnings.push({
        stage: "persist.traces",
        message: "failed to update trace scores",
        detail: errDetail(err),
      });
    }

    try {
      deps.episodesRepo.setRTask(input.episodeId, humanScore.rHuman);
    } catch (err) {
      warnings.push({
        stage: "persist.episode",
        message: "failed to update episode r_task",
        detail: errDetail(err),
      });
    }

    try {
      deps.episodesRepo.updateMeta(input.episodeId, {
        reward: {
          rHuman: humanScore.rHuman,
          source: humanScore.source,
          axes: humanScore.axes,
          reason: humanScore.reason,
          scoredAt: startedAt,
          trigger: input.trigger,
        },
      });
    } catch (err) {
      warnings.push({
        stage: "persist.episode.meta",
        message: "failed to update episode meta",
        detail: errDetail(err),
      });
    }
    tMetrics.persist = now() - tPersistStart;

    const completedAt = now() as EpochMs;
    const result: RewardResult = {
      episodeId: input.episodeId,
      sessionId: episode.sessionId,
      rHuman: humanScore.rHuman,
      humanScore,
      feedbackCount: mergedFeedback.length,
      backprop: bp,
      traceIds: bp.updates.map((u) => u.traceId),
      timings: {
        summary: tMetrics.summary!,
        score: tMetrics.score!,
        backprop: tMetrics.backprop!,
        persist: tMetrics.persist!,
        total: completedAt - startedAt,
      },
      warnings,
      startedAt,
      completedAt,
    };

    log.info("reward.done", {
      episodeId: input.episodeId,
      sessionId: episode.sessionId,
      rHuman: humanScore.rHuman,
      source: humanScore.source,
      feedbackCount: mergedFeedback.length,
      traces: bp.updates.length,
      trigger: input.trigger,
      totalMs: result.timings.total,
      warnings: warnings.length,
    });

    deps.bus.emit({ kind: "reward.updated", result });
    return result;
  }

  return { run };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Mirror of the legacy `shouldSkipSummary` rule. Returns a
 * human-readable reason when the episode is too trivial to score,
 * else null. We deliberately keep the rule small and deterministic —
 * no LLM call — because we run it on every episode finalize.
 *
 * Ported from `memos-local-openclaw/src/ingest/task-processor.ts`
 * `shouldSkipSummary`. Skip conditions (any one triggers skip):
 *   1. Exchange count: `min(user_turns, assistant_turns) < min`.
 *   2. Content length: total user+assistant chars.
 *   3. No user messages.
 *   4. Trivial/test user content (hello, test, ok, etc.).
 *   5. Tool-result dominated with minimal user interaction.
 *   6. High content repetition.
 */

const TRIVIAL_PATTERNS = [
  /^(test|testing|hello|hi|hey|ok|okay|yes|no|yeah|nope|sure|thanks|thank you|thx|ping|pong|哈哈|好的|嗯|是的|不是|谢谢|你好|测试)\s*[.!?。！？]*$/i,
  /^(aaa+|bbb+|xxx+|zzz+|123+|asdf+|qwer+|haha+|lol+|hmm+)\s*$/i,
  /^[\s\p{P}\p{S}]*$/u,
];

/**
 * Decide whether `text` is dominated by trivial filler ("ok", "thx",
 * "test"…). The earlier implementation walked lines and treated any
 * line shorter than 5 chars as trivial — which mis-fires on long
 * markdown / code outputs whose 70 %+ of "lines" are structural
 * (`#`, `-`, `}`, blank-after-trim) rather than filler. That made
 * the reward gate skip every Hermes turn that included a code block
 * or a bulleted answer, so the entire L2 / Skill chain starved.
 *
 * New rule: weight by *characters*, and only count a line as trivial
 * when it actually matches `TRIVIAL_PATTERNS`. Short structural lines
 * are simply ignored. The total non-trivial text must be at least
 * `MIN_NON_TRIVIAL_CHARS` for the input to pass.
 */
const MIN_NON_TRIVIAL_CHARS = 30;

function looksLikeTrivialContent(text: string): boolean {
  const lines = text
    .toLowerCase()
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;

  let trivialChars = 0;
  let nonTrivialChars = 0;
  for (const line of lines) {
    if (TRIVIAL_PATTERNS.some((p) => p.test(line))) {
      trivialChars += line.length;
    } else {
      nonTrivialChars += line.length;
    }
  }

  // Two-stage check:
  //   - If there's enough genuinely non-trivial text, pass regardless
  //     of how many short structural lines there are.
  //   - Otherwise fall back to the old "trivial-dominated" rule, but
  //     measured in characters (not lines) so a long answer with a
  //     few "ok"s sprinkled in doesn't get rejected.
  if (nonTrivialChars >= MIN_NON_TRIVIAL_CHARS) return false;
  const total = trivialChars + nonTrivialChars;
  if (total === 0) return true;
  return trivialChars / total > 0.7;
}

function decideSkipReason(
  snapshot: import("../session/types.js").EpisodeSnapshot,
  traces: readonly TraceRow[],
  cfg: Pick<RewardConfig, "minExchangesForCompletion" | "minContentCharsForCompletion" | "toolHeavyRatio" | "minAssistantCharsForToolHeavy">,
): string | null {
  // Prefer the live snapshot's turn list; fall back to traces when the
  // snapshot came from a SQLite row (no turns materialised).
  let userTurns = 0;
  let assistantTurns = 0;
  let toolTurns = 0;
  let contentChars = 0;
  const userContents: string[] = [];
  const assistantContents: string[] = [];

  if (snapshot.turns && snapshot.turns.length > 0) {
    for (const t of snapshot.turns) {
      const text = t.content ?? "";
      const len = text.length;
      contentChars += len;
      if (t.role === "user") {
        userTurns++;
        userContents.push(text);
      } else if (t.role === "assistant") {
        assistantTurns++;
        assistantContents.push(text);
      } else if (t.role === "tool") {
        toolTurns++;
      }
    }
  } else {
    for (const tr of traces) {
      const u = (tr.userText ?? "").length;
      const a = (tr.agentText ?? "").length;
      if (u > 0) {
        userTurns++;
        contentChars += u;
        userContents.push(tr.userText);
      }
      if (a > 0) {
        assistantTurns++;
        contentChars += a;
        assistantContents.push(tr.agentText);
      }
      if (tr.toolCalls && tr.toolCalls.length > 0) {
        toolTurns += tr.toolCalls.length;
      }
    }
  }

  const totalTurns = userTurns + assistantTurns + toolTurns;

  // 1. Not enough real conversation turns (need at least N user-assistant exchanges)
  const exchanges = Math.min(userTurns, assistantTurns);
  if (exchanges < cfg.minExchangesForCompletion) {
    return (
      `对话轮次不足（${exchanges} 轮），需要至少 ${cfg.minExchangesForCompletion} 轮完整的问答交互才能生成摘要。`
    );
  }

  // 2. No user messages at all
  if (userTurns === 0) {
    return "该任务没有用户消息，仅包含系统或工具自动生成的内容。";
  }

  // 3. Total content too short. CJK packs ~2× the info per char vs
  // ASCII, so we double the bar for ASCII-only conversations — but
  // capped at 2× the user-configured min, never an absolute 200
  // (that hardcoded floor used to make `minContentCharsForCompletion`
  // settings below 100 silently ineffective).
  const allText = (userContents.join("") + assistantContents.join(""))
    .slice(0, 4_000);
  const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(allText);
  const minContentLen = hasCJK
    ? cfg.minContentCharsForCompletion
    : cfg.minContentCharsForCompletion * 2;
  if (contentChars < minContentLen) {
    return (
      `对话内容过短（${contentChars} 字符），信息量不足以生成有意义的摘要。`
    );
  }

  // 4. Trivial/test user content
  const allUserText = userContents.join("\n");
  if (looksLikeTrivialContent(allUserText)) {
    return "对话内容为简单问候或测试数据（如 hello、test、ok），无需生成摘要。";
  }

  // 5. Both sides trivial
  const allAssistantText = assistantContents.join("\n");
  if (
    looksLikeTrivialContent(allUserText + "\n" + allAssistantText)
  ) {
    return "对话内容（用户和助手双方）为简单问候或测试数据，无需生成摘要。";
  }

  // 6. Almost all messages are tool results with minimal user
  // interaction AND no real assistant explanation. Single-shot
  // agent runs (`hermes chat -q "do X"` → write_file + terminal +
  // brief confirmation) are a legitimate work pattern, not
  // "missing user interaction". Only skip when the assistant
  // response is itself trivially short, indicating the turn is
  // almost pure tool noise.
  const assistantContentChars = assistantContents.reduce(
    (sum, c) => sum + c.length,
    0,
  );
  const toolHeavyRatio = cfg.toolHeavyRatio ?? 0.7;
  const minAssistantChars = cfg.minAssistantCharsForToolHeavy ?? 80;
  if (
    toolTurns > 0 &&
    totalTurns > 0 &&
    toolTurns >= totalTurns * toolHeavyRatio &&
    userTurns <= 1 &&
    assistantContentChars < minAssistantChars
  ) {
    return `该任务主要由工具执行结果组成（${toolTurns}/${totalTurns} 条），缺少足够的用户交互内容。`;
  }

  // 7. High repetition — user keeps saying the same thing
  if (userContents.length >= 3) {
    const uniqueUserMsgs = new Set(
      userContents.map((c) => c.trim().toLowerCase()),
    );
    const uniqueRatio = uniqueUserMsgs.size / userContents.length;
    if (uniqueRatio < 0.4) {
      return `对话中存在大量重复内容（${uniqueUserMsgs.size} 条独立消息 / ${userContents.length} 条用户消息），无法提取有效信息。`;
    }
  }

  return null;
}

function mergeFeedback(
  a: readonly UserFeedback[],
  b: readonly UserFeedback[],
): UserFeedback[] {
  const byId = new Map<string, UserFeedback>();
  for (const f of a) byId.set(f.id, f);
  for (const f of b) if (!byId.has(f.id)) byId.set(f.id, f);
  return [...byId.values()].sort((x, y) => x.ts - y.ts);
}

function fallbackSnapshotFromRow(
  ep: NonNullable<ReturnType<EpisodesRepo["getById"]>>,
): import("../session/types.js").EpisodeSnapshot {
  // Minimal snapshot for summary building when we don't have live turns.
  return {
    id: ep.id,
    sessionId: ep.sessionId,
    startedAt: ep.startedAt as EpochMs,
    endedAt: (ep.endedAt ?? null) as EpochMs | null,
    status: ep.status,
    rTask: ep.rTask ?? null,
    turnCount: 0,
    turns: [],
    traceIds: (ep.traceIds ?? []) as import("../types.js").TraceId[],
    meta: (ep as unknown as { meta?: Record<string, unknown> }).meta ?? {},
    intent: undefined as unknown as import("../session/types.js").IntentDecision,
  };
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message, ...(err.details ?? {}) };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}
