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
import type { EpisodeId, TraceRow } from "../../types.js";
import type { Repos } from "../../storage/repos/index.js";
import type { RewardEventBus, RewardResult } from "../../reward/index.js";
import type { StorageDb } from "../../storage/types.js";
import { runL2 } from "./l2.js";
import type { L2Config, L2EventBus } from "./types.js";

export interface L2SubscriberDeps {
  db: StorageDb;
  repos: Pick<Repos, "candidatePool" | "policies" | "traces">;
  rewardBus: RewardEventBus;
  l2Bus: L2EventBus;
  llm: LlmClient | null;
  log: Logger;
  config: L2Config;
  thresholds: { minSupport: number; minGain: number; archiveGain: number };
}

export interface L2SubscriberHandle {
  detach(): void;
  /** Force-run L2 for a given episode id (used by tests and the viewer). */
  runOnce(episodeId: EpisodeId, opts?: { trigger?: "manual" | "rebuild" }): Promise<void>;
}

export function attachL2Subscriber(deps: L2SubscriberDeps): L2SubscriberHandle {
  const { rewardBus, log } = deps;
  const subLog = log.child({ channel: "core.memory.l2" });

  let active = 0;
  let closed = false;

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
      await runL2(
        {
          episodeId: result.episodeId,
          sessionId: result.sessionId,
          traces,
          trigger: "reward.updated",
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

  const off = rewardBus.on("reward.updated", (evt) => {
    if (evt.kind !== "reward.updated") return;
    // Fire-and-forget; reward subscriber's completion doesn't block on us.
    void processReward(evt.result);
  });

  return {
    detach(): void {
      closed = true;
      off();
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
      await runL2(
        {
          episodeId,
          sessionId: traces[0].sessionId,
          traces,
          trigger: opts?.trigger ?? "manual",
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
    },
  };
}
