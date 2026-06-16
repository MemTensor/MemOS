/**
 * `attachL2Subscriber` — bridge between the reward pipeline and the L2
 * orchestrator.
 *
 * On every `reward.updated` event:
 *   1. Reload the episode's traces (reward.updated only tells us the ids;
 *      we need full rows with fresh V values).
 *   2. Call `runL2` with the pre-wired deps.
 *   3. Surface errors as `l2.failed` on the L2 bus; never throw upstream.
 *
 * Keeping this as an explicit subscriber (rather than shoving it inside the
 * reward runner) means L2 failures never roll back reward writes and we can
 * unit-test the whole pipeline by emitting a fake `reward.updated` event.
 */

import type { LlmClient } from "../../llm/index.js";
import type { Logger } from "../../logger/types.js";
import type { EpisodeId, FeedbackRow, PolicyId, ToolCallDTO, TraceRow } from "../../types.js";
import type { Repos } from "../../storage/repos/index.js";
import type { RewardEventBus, RewardResult } from "../../reward/index.js";
import type { StorageDb } from "../../storage/types.js";
import { runL2Failure } from "../../experience/failure-builder.js";
import { runL2 } from "./l2.js";
import type { L2Config, L2EventBus } from "./types.js";

export interface L2SubscriberDeps {
  db: StorageDb;
  repos: Pick<
    Repos,
    | "candidatePool"
    | "embeddingRetryQueue"
    | "episodePolicyInjections"
    | "episodes"
    | "feedback"
    | "policies"
    | "tracePolicyLinks"
    | "traces"
  >;
  rewardBus: RewardEventBus;
  l2Bus: L2EventBus;
  llm: LlmClient | null;
  log: Logger;
  config: L2Config;
  now?: () => number;
  thresholds: { minSupport: number; minGain: number; archiveGain: number };
}

export interface L2SubscriberHandle {
  detach(): void;
  /** Force-run L2 for a given episode id (used by tests and the viewer). */
  runOnce(episodeId: EpisodeId, opts?: { trigger?: "manual" | "rebuild" }): Promise<void>;
  /**
   * Wait for every in-flight L2 run to complete. Called from the
   * pipeline's `flush()` so that adapters whose process exits right
   * after `episode.close` (e.g. Hermes' single-shot `chat -q`) don't
   * lose the induction step. Without this, `runL2` (which may take
   * 5–10s for the LLM `l2.induction` call) gets reaped mid-flight,
   * leaving the candidate pool full but no policies ever induced.
   */
  drain(): Promise<void>;
}

const INFRA_ERROR_RE = /ETIMEDOUT|ECONNRESET|EPIPE|ECONNREFUSED|wrapper.*(exit|killed)|sandbox.*unavailable|container.*(killed|oom)/i;
type GateVerdict = "E" | "Q" | "L";

export function attachL2Subscriber(deps: L2SubscriberDeps): L2SubscriberHandle {
  const { rewardBus, log } = deps;
  const subLog = log.child({ channel: "core.memory.l2" });

  let active = 0;
  let closed = false;
  const inflight = new Set<Promise<unknown>>();
  const inflightByEpisode = new Map<EpisodeId, Promise<unknown>>();
  const pendingByEpisode = new Map<EpisodeId, RewardResult>();

  async function processReward(result: RewardResult): Promise<void> {
    if (closed) return;
    active++;
    try {
      const traces = result.traceIds
        .map((id) => deps.repos.traces.getById(id))
        .filter((t): t is TraceRow => !!t);
      if (traces.length === 0) {
        subLog.debug("skip.no_traces", { episodeId: result.episodeId });
        return;
      }
      const episode = deps.repos.episodes.getById(result.episodeId);
      const outcome = episode?.outcome ?? null;
      settleInjectedPolicies({
        episode,
        traces,
        repos: deps.repos,
        now: deps.now ?? Date.now,
        log: subLog,
      });
      if (outcome === "failure") {
        const feedbacks = deps.repos.feedback.getForEpisode(result.episodeId);
        const gate = decideFailureGate({
          traces,
          verifierPassed: episode?.verifierPassed ?? null,
          feedbacks,
        });
        deps.repos.episodes.updateMeta(result.episodeId, {
          gateVerdict: gate.verdict,
          gateReason: gate.reason,
          gateAt: Date.now(),
        });
        if (gate.verdict !== "L") {
          subLog.info("failure.gated", {
            episodeId: result.episodeId,
            verdict: gate.verdict,
            reason: gate.reason,
          });
          return;
        }
        const sink = await runL2Failure(
          {
            episodeId: result.episodeId,
            sessionId: result.sessionId,
            traces,
            feedbacks,
          },
          {
            repos: deps.repos,
            llm: deps.llm,
            log: subLog,
            now: deps.now,
          },
        );
        if (sink.created) {
          subLog.info("failure.route.sink.created", {
            episodeId: result.episodeId,
            policyId: sink.policyId,
          });
        } else {
          subLog.info("failure.route.sink.skipped", {
            episodeId: result.episodeId,
            reason: sink.skippedReason,
          });
        }
        return;
      }
      await runL2(
        {
          episodeId: result.episodeId,
          sessionId: result.sessionId,
          traces,
          trigger: "reward.updated",
          outcome,
        },
        {
          db: deps.db,
          repos: deps.repos,
          llm: deps.llm,
          log: subLog,
          bus: deps.l2Bus,
          config: deps.config,
          thresholds: deps.thresholds,
        },
      );
    } catch (err) {
      subLog.error("run.failed", {
        episodeId: result.episodeId,
        err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
      });
      deps.l2Bus.emit({
        kind: "l2.failed",
        episodeId: result.episodeId,
        stage: "run",
        error: {
          code: "L2_RUN_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      active--;
    }
  }

  async function processEpisodeQueue(initial: RewardResult): Promise<void> {
    let next: RewardResult | undefined = initial;
    while (next && !closed) {
      pendingByEpisode.delete(next.episodeId);
      await processReward(next);
      next = pendingByEpisode.get(next.episodeId);
    }
  }

  function scheduleReward(result: RewardResult): void {
    if (closed) return;
    const existing = inflightByEpisode.get(result.episodeId);
    if (existing) {
      // Keep only the latest reward snapshot for this episode. OpenClaw
      // can emit several reward.updated events while reflect/lite passes
      // are still settling; serialising them prevents parallel induction
      // over the same candidate buckets while still preserving the newest
      // trace set for a follow-up pass.
      pendingByEpisode.set(result.episodeId, result);
      return;
    }
    const p: Promise<unknown> = processEpisodeQueue(result).finally(() => {
      inflightByEpisode.delete(result.episodeId);
      inflight.delete(p);
    });
    inflightByEpisode.set(result.episodeId, p);
    inflight.add(p);
  }

  const off = rewardBus.on("reward.updated", (evt) => {
    if (evt.kind !== "reward.updated") return;
    // Fire-and-forget for the producer (reward subscriber must not
    // block on us), but track/coalesce the promise so `drain()` can wait
    // for the L2 induction to actually finish before the process
    // shuts down.
    scheduleReward(evt.result);
  });

  return {
    detach(): void {
      closed = true;
      off();
      pendingByEpisode.clear();
    },
    async drain(): Promise<void> {
      while (inflight.size > 0) {
        await Promise.all(Array.from(inflight));
      }
    },
    async runOnce(episodeId, opts): Promise<void> {
      const ep = deps.repos.traces; // just to silence TS unused check
      const traces: TraceRow[] = [];
      const rows = deps.db
        .prepare<{ episode_id: string }, { id: string }>(
          `SELECT id FROM traces WHERE episode_id = @episode_id ORDER BY ts ASC`,
        )
        .all({ episode_id: episodeId });
      for (const r of rows) {
        const t = ep.getById(r.id as unknown as Parameters<typeof ep.getById>[0]);
        if (t) traces.push(t);
      }
      if (traces.length === 0) return;
      await processReward({
        episodeId,
        sessionId: traces[0].sessionId,
        traceIds: traces.map((trace) => trace.id),
      } as RewardResult);
    },
  };
}

function settleInjectedPolicies(input: {
  episode: ReturnType<L2SubscriberDeps["repos"]["episodes"]["getById"]> | null;
  traces: readonly TraceRow[];
  repos: L2SubscriberDeps["repos"];
  now: () => number;
  log: Logger;
}): void {
  const episode = input.episode;
  if (!episode) return;
  const injectedIds = readInjectedPolicyIds(episode.id, input.repos);
  if (injectedIds.length === 0) return;
  const viewedIds = extractViewedPolicyIds(input.traces);
  const viewedSet = new Set(viewedIds);
  if (viewedSet.size === 0) return;
  if (episode.outcome === "success") {
    const viewedRows: Array<ReturnType<L2SubscriberDeps["repos"]["policies"]["getById"]>> = [];
    for (const policyId of injectedIds) {
      if (!viewedSet.has(policyId)) continue;
      const row = input.repos.policies.getById(policyId as PolicyId);
      if (!row) continue;
      viewedRows.push(row);
      const streakMeta = withDegradeMeta(row.verifierMeta, 0);
      if (row.status === "candidate") {
        input.repos.policies.upsert({
          ...row,
          support: Math.max(1, row.support + 1),
          status: "active",
          verifierMeta: streakMeta,
          updatedAt: input.now(),
        });
      } else {
        input.repos.policies.upsert({
          ...row,
          verifierMeta: streakMeta,
          updatedAt: input.now(),
        });
      }
      input.log.info("policy.validated.by_view", {
        episodeId: episode.id,
        policyId: row.id,
      });
    }
    refreshPolicyGainOnSuccess({
      repos: input.repos,
      viewedRows,
      now: input.now,
    });
    return;
  }
  if (episode.outcome === "failure") {
    for (const policyId of injectedIds) {
      if (!viewedSet.has(policyId)) continue;
      const row = input.repos.policies.getById(policyId as PolicyId);
      if (!row) continue;
      const current = degradeFailStreakOf(row.verifierMeta);
      const next = current + 1;
      let nextStatus = row.status;
      if (row.status === "active" && next >= 2) nextStatus = "candidate";
      else if (row.status === "candidate" && next >= 3) nextStatus = "archived";
      input.repos.policies.upsert({
        ...row,
        status: nextStatus,
        verifierMeta: withDegradeMeta(row.verifierMeta, next),
        updatedAt: input.now(),
      });
      input.log.info("policy.degraded.by_failure", {
        episodeId: episode.id,
        policyId: row.id,
        degradeFailStreak: next,
        status: nextStatus,
      });
    }
  }
}

function readInjectedPolicyIds(
  episodeId: EpisodeId,
  repos: L2SubscriberDeps["repos"],
): string[] {
  const rows = repos.episodePolicyInjections.listPolicyIdsForEpisode(episodeId);
  return rows.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function extractViewedPolicyIds(traces: readonly TraceRow[]): string[] {
  const out = new Set<string>();
  for (const trace of traces) {
    for (const toolCall of trace.toolCalls ?? []) {
      if ((toolCall.name ?? "").toLowerCase() !== "memos_get") continue;
      if (toolCall.errorCode && toolCall.errorCode.trim().length > 0) continue;
      const input = toolCall.input;
      if (!input || typeof input !== "object") continue;
      const record = input as Record<string, unknown>;
      const kind = record.kind;
      const id = record.id;
      if (kind === "policy" && typeof id === "string" && id.trim().length > 0) {
        out.add(id);
      }
    }
  }
  return Array.from(out);
}

function degradeFailStreakOf(meta: Record<string, unknown> | null | undefined): number {
  const n = meta?.degradeFailStreak;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function withDegradeMeta(
  meta: Record<string, unknown> | null | undefined,
  streak: number,
): Record<string, unknown> {
  return {
    ...(meta ?? {}),
    degradeFailStreak: streak,
  };
}

function refreshPolicyGainOnSuccess(input: {
  repos: L2SubscriberDeps["repos"];
  viewedRows: Array<ReturnType<L2SubscriberDeps["repos"]["policies"]["getById"]>>;
  now: () => number;
}): void {
  const mergeFamilies = new Set<string>();
  for (const row of input.viewedRows) {
    if (row?.mergeFamily) mergeFamilies.add(row.mergeFamily);
  }
  if (mergeFamilies.size === 0) return;
  const candidates = input.repos.policies
    .list({ status: "candidate", limit: 5_000 })
    .filter((row) => (
      row.mergeFamily
      && mergeFamilies.has(row.mergeFamily)
      && (row.evidencePolarity === "negative" || row.evidencePolarity === "mixed")
    ))
    .slice(0, 50);
  for (const row of candidates) {
    input.repos.policies.upsert({
      ...row,
      gain: Math.min(1, row.gain + 0.02),
      verifierMeta: {
        ...(row.verifierMeta ?? {}),
        lastGainRefreshSupportBase: row.support,
      },
      updatedAt: input.now(),
    });
  }
}

function decideFailureGate(input: {
  traces: readonly TraceRow[];
  verifierPassed: boolean | null;
  feedbacks: readonly FeedbackRow[];
}): { verdict: GateVerdict; reason: string } {
  const infra = isInfraFailure(input.traces);
  if (infra.hit) {
    return { verdict: "E", reason: infra.reason };
  }
  if (input.verifierPassed == null && input.feedbacks.length === 0) {
    return {
      verdict: "Q",
      reason: "verifier_passed_null_and_no_feedback",
    };
  }
  return { verdict: "L", reason: "learnable_failure" };
}

function isInfraFailure(
  traces: readonly TraceRow[],
): { hit: boolean; reason: string } {
  const ordered = [...traces].sort((a, b) => b.ts - a.ts);
  const toolCalls = ordered
    .flatMap((trace) => trace.toolCalls ?? [])
    .filter((tool) => Boolean((tool.name ?? "").trim()))
    .slice(0, 5);
  if (toolCalls.length === 0) {
    return { hit: false, reason: "no_tool_calls" };
  }
  const infraHits = toolCalls.filter(isInfraToolCall).length;
  if (infraHits / toolCalls.length >= 0.6) {
    return { hit: true, reason: "infra_ratio_ge_60pct" };
  }
  const byTool = new Map<string, ToolCallDTO[]>();
  for (const call of toolCalls) {
    const key = call.name.trim().toLowerCase();
    const list = byTool.get(key) ?? [];
    list.push(call);
    byTool.set(key, list);
  }
  for (const [tool, list] of byTool) {
    if (list.length >= 3 && list.every(isInfraToolCall)) {
      return {
        hit: true,
        reason: `infra_retry_ge_3:${tool}`,
      };
    }
  }
  return { hit: false, reason: "no_infra_pattern" };
}

function isInfraToolCall(call: ToolCallDTO): boolean {
  const text = [
    call.errorCode ?? "",
    safeStringify(call.output),
  ].join("\n");
  return INFRA_ERROR_RE.test(text);
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
