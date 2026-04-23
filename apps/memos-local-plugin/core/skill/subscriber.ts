/**
 * Wires the skill module to the upstream event buses.
 *
 * Upstream triggers (all debounced via `queueMicrotask` so they never block
 * the emitter):
 *
 *   - `l2.policy.induced`        → `runSkill({ trigger, policyId })`
 *   - `l2.policy.status_changed` → `runSkill({ trigger, policyId })` when
 *                                  the new status is `active`
 *   - `reward.updated`           → `runSkill({ trigger: "reward.updated" })`
 *                                  — evaluates every policy referenced by
 *                                  the updated episode. Also drives the η
 *                                  drift adjustment on existing skills.
 *
 * The handle returns `runOnce` for manual runs (used by the CLI / viewer
 * rebuild button) and `applyFeedback` for explicit skill feedback.
 */

import type { L2Event, L2EventBus } from "../memory/l2/types.js";
import type { Logger } from "../logger/types.js";
import type { RewardEvent, RewardEventBus } from "../reward/types.js";
import { rootLogger } from "../logger/index.js";
import {
  applySkillFeedback,
  runSkill,
  type RunSkillDeps,
} from "./skill.js";
import type {
  RunSkillInput,
  RunSkillResult,
  SkillEventBus,
  SkillFeedbackKind,
  SkillTrigger,
} from "./types.js";
import type { SkillId } from "../types.js";

export interface SkillSubscriberDeps
  extends Omit<RunSkillDeps, "log" | "bus"> {
  log?: Logger;
  bus: SkillEventBus;
  l2Bus: L2EventBus;
  rewardBus: RewardEventBus;
}

export interface SkillSubscriberHandle {
  dispose(): void;
  runOnce(input: Omit<RunSkillInput, "trigger"> & { trigger?: SkillTrigger }): Promise<RunSkillResult>;
  applyFeedback(skillId: SkillId, kind: SkillFeedbackKind, magnitude?: number): void;
  /**
   * Await any in-flight scheduled run. Primarily useful in tests where we
   * want to assert on the effects of an event-driven run after the bus has
   * fanned out the event.
   */
  flush(): Promise<void>;
}

export function attachSkillSubscriber(
  deps: SkillSubscriberDeps,
): SkillSubscriberHandle {
  const log = deps.log ?? rootLogger.child({ channel: "core.skill" });
  const runDeps: RunSkillDeps = {
    repos: deps.repos,
    embedder: deps.embedder,
    llm: deps.llm,
    log,
    bus: deps.bus,
    config: deps.config,
  };

  let inflight: Promise<void> | null = null;
  let queued: { trigger: SkillTrigger; hint?: { policyId?: string; skillId?: SkillId } } | null =
    null;

  async function drain(): Promise<void> {
    while (queued) {
      const next = queued;
      queued = null;
      try {
        await runSkill(
          { trigger: next.trigger, policyId: next.hint?.policyId, skillId: next.hint?.skillId },
          runDeps,
        );
      } catch (err) {
        log.error("skill.run.failed", {
          trigger: next.trigger,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function triggerRun(
    trigger: SkillTrigger,
    hint?: { policyId?: string; skillId?: SkillId },
  ): void {
    queued = { trigger, hint };
    if (inflight) {
      log.debug("skill.run.queued", { trigger });
      return;
    }
    const promise = drain().finally(() => {
      if (inflight === promise) inflight = null;
    });
    inflight = promise;
  }

  const offInduced = deps.l2Bus.on("l2.policy.induced", (evt: L2Event) => {
    if (evt.kind !== "l2.policy.induced") return;
    log.debug("trigger.l2.policy.induced", { policyId: evt.policyId });
    triggerRun("l2.policy.induced", { policyId: evt.policyId });
  });

  const offStatus = deps.l2Bus.on("l2.policy.updated", (evt: L2Event) => {
    if (evt.kind !== "l2.policy.updated") return;
    if (evt.status !== "active") return;
    log.debug("trigger.l2.policy.updated", { policyId: evt.policyId, status: evt.status });
    triggerRun("l2.policy.status_changed", { policyId: evt.policyId });
  });

  const offReward = deps.rewardBus.on("reward.updated", (evt: RewardEvent) => {
    if (evt.kind !== "reward.updated") return;
    log.debug("trigger.reward.updated", {
      episodeId: evt.result.episodeId,
    });
    triggerRun("reward.updated");
  });

  function dispose(): void {
    offInduced();
    offStatus();
    offReward();
    log.info("skill.subscriber.disposed");
  }

  async function runOnce(
    input: Omit<RunSkillInput, "trigger"> & { trigger?: SkillTrigger },
  ): Promise<RunSkillResult> {
    const trigger: SkillTrigger = input.trigger ?? "manual";
    return runSkill(
      {
        trigger,
        policyId: input.policyId,
        skillId: input.skillId,
      },
      runDeps,
    );
  }

  function applyFeedback(
    skillId: SkillId,
    kind: SkillFeedbackKind,
    magnitude?: number,
  ): void {
    applySkillFeedback(skillId, kind, runDeps, magnitude);
  }

  async function flush(): Promise<void> {
    // Loop in case additional events arrive while we're draining.
    while (inflight) {
      await inflight;
    }
  }

  return { dispose, runOnce, applyFeedback, flush };
}
