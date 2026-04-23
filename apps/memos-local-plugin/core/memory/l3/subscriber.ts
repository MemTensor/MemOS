/**
 * `attachL3Subscriber` — bridge between the L2 pipeline and the L3
 * orchestrator.
 *
 * L3 abstraction is expensive (a single LLM call per cluster) and
 * strictly cross-task, so we deliberately *do not* run it on every
 * `reward.updated` or `l2.policy.updated`. We only react to:
 *
 *   - **`l2.policy.induced`** — a brand-new L2 policy just landed.
 *     That's the signal that the set of compatible policies changed,
 *     so a new or updated WM might be in order. We debounce by
 *     domain tag via the `algorithm.l3Abstraction.cooldownDays` key
 *     (handled inside `runL3`).
 *
 * Additional entry points:
 *   - **`runOnce({ trigger: 'manual' | 'rebuild' })`** — used by the
 *     viewer ("rebuild world models") and tests.
 *   - **`adjustFeedback({ worldModelId, polarity })`** — bumps a WM's
 *     confidence up or down based on human feedback. Not wired to any
 *     event bus here; callers invoke it directly from the feedback API.
 */

import type { LlmClient } from "../../llm/index.js";
import type { Logger } from "../../logger/types.js";
import type { Repos } from "../../storage/repos/index.js";
import type { WorldModelId } from "../../types.js";
import type { L2EventBus } from "../l2/types.js";
import { adjustConfidence, runL3 } from "./l3.js";
import type { L3Config, L3EventBus, L3ProcessInput, L3ProcessResult } from "./types.js";

export interface L3SubscriberDeps {
  repos: Pick<Repos, "policies" | "traces" | "worldModel" | "kv">;
  l2Bus: L2EventBus;
  l3Bus: L3EventBus;
  llm: LlmClient | null;
  log: Logger;
  config: L3Config;
}

export interface L3SubscriberHandle {
  detach(): void;
  runOnce(
    opts?: Partial<Pick<L3ProcessInput, "trigger" | "domainTagsFilter" | "sessionId" | "episodeId">>,
  ): Promise<L3ProcessResult>;
  adjustFeedback(
    worldModelId: WorldModelId,
    polarity: "positive" | "negative",
  ): Promise<{ previous: number; next: number } | null>;
}

export function attachL3Subscriber(deps: L3SubscriberDeps): L3SubscriberHandle {
  const { l2Bus, log } = deps;
  const subLog = log.child({ channel: "core.memory.l3" });

  let closed = false;
  let inflight: Promise<unknown> | null = null;

  async function triggerRun(
    trigger: L3ProcessInput["trigger"],
    extra: Partial<L3ProcessInput> = {},
  ): Promise<L3ProcessResult | null> {
    if (closed) return null;
    if (inflight) {
      subLog.debug("skip.inflight", { trigger });
      return null;
    }
    const p = runL3(
      {
        trigger,
        ...extra,
      },
      {
        repos: deps.repos,
        llm: deps.llm,
        log: subLog,
        bus: deps.l3Bus,
        config: deps.config,
      },
    );
    inflight = p;
    try {
      return await p;
    } catch (err) {
      subLog.error("run.failed", {
        trigger,
        err: err instanceof Error ? { name: err.name, message: err.message } : { value: String(err) },
      });
      deps.l3Bus.emit({
        kind: "l3.failed",
        stage: "run",
        error: {
          code: "L3_RUN_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return null;
    } finally {
      inflight = null;
    }
  }

  const offInduced = l2Bus.on("l2.policy.induced", (evt) => {
    if (evt.kind !== "l2.policy.induced") return;
    subLog.debug("trigger.l2.policy.induced", {
      policyId: evt.policyId,
      episodeId: evt.episodeId,
    });
    void triggerRun("l2.policy.induced", {
      sessionId: undefined,
      episodeId: evt.episodeId,
    });
  });

  /**
   * Also react when a candidate policy transitions to active — at
   * induction time the policy is status=candidate and ineligible for
   * L3 clustering. The first round of `associateTraces` in a later
   * episode promotes it to active but would not have fired another
   * `l2.policy.induced` event, so without this hook L3 would never
   * notice the newly-qualified policy. We only fire when the
   * *previous* status was `candidate` — re-scoring an already-active
   * policy is redundant (L3 already saw it) and would thrash the
   * abstraction LLM. We guard on `bus-local` bookkeeping rather than
   * a DB round-trip because the L2 orchestrator emits the full
   * transition.
   */
  const offUpdated = l2Bus.on("l2.policy.updated", (evt) => {
    if (evt.kind !== "l2.policy.updated") return;
    if (evt.status !== "active") return;
    subLog.debug("trigger.l2.policy.activated", {
      policyId: evt.policyId,
      episodeId: evt.episodeId,
    });
    void triggerRun("l2.policy.induced", {
      sessionId: undefined,
      episodeId: evt.episodeId,
    });
  });

  const off = (): void => {
    offInduced();
    offUpdated();
  };

  return {
    detach(): void {
      closed = true;
      off();
    },
    async runOnce(opts): Promise<L3ProcessResult> {
      const result = await triggerRun(opts?.trigger ?? "manual", {
        sessionId: opts?.sessionId,
        episodeId: opts?.episodeId,
        domainTagsFilter: opts?.domainTagsFilter,
      });
      return (
        result ?? {
          trigger: opts?.trigger ?? "manual",
          abstractions: [],
          warnings: [
            {
              stage: "noop",
              message: "subscriber was closed or had an inflight run",
            },
          ],
          timings: { cluster: 0, abstract: 0, persist: 0, total: 0 },
          startedAt: Date.now(),
          completedAt: Date.now(),
        }
      );
    },
    async adjustFeedback(worldModelId, polarity) {
      return adjustConfidence(worldModelId, polarity, {
        repos: deps.repos,
        config: deps.config,
        log: subLog,
        bus: deps.l3Bus,
      });
    },
  };
}
