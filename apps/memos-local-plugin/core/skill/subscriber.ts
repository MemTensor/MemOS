/**
 * Wires the skill module to the upstream event buses.
 *
 * Upstream triggers are scheduled onto one process-local single-flight lane
 * so event-driven and explicit/manual runs can never crystallize the same
 * policy concurrently:
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
import { shouldPromoteCandidate } from "./lifecycle.js";
import type {
  RunSkillInput,
  RunSkillResult,
  SkillEventBus,
  SkillFeedbackKind,
  SkillTrigger,
} from "./types.js";
import type { SkillId } from "../types.js";
import { now as nowMs } from "../time.js";

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
  lifecycleTick(): Promise<void>;
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

  let schedulerTail: Promise<void> = Promise.resolve();
  let scheduledCount = 0;
  const scheduledByKey = new Map<string, Promise<RunSkillResult>>();

  function schedule(input: RunSkillInput): Promise<RunSkillResult> {
    const key = input.policyId
      ? `policy:${input.policyId}`
      : input.skillId
        ? `skill:${input.skillId}`
        : "global";
    const existing = scheduledByKey.get(key);
    if (existing) {
      log.debug("skill.run.coalesced", { trigger: input.trigger, key });
      return existing;
    }
    scheduledCount += 1;
    const result = schedulerTail.then(() => runSkill(input, runDeps));
    scheduledByKey.set(key, result);
    const clear = () => {
      if (scheduledByKey.get(key) === result) scheduledByKey.delete(key);
    };
    void result.then(clear, clear);
    schedulerTail = result.then(
      () => {
        scheduledCount -= 1;
      },
      () => {
        scheduledCount -= 1;
      },
    );
    return result;
  }

  function triggerRun(
    trigger: SkillTrigger,
    hint?: { policyId?: string; skillId?: SkillId },
  ): void {
    if (scheduledCount > 0) {
      log.debug("skill.run.queued", { trigger });
    }
    void schedule({
      trigger,
      policyId: hint?.policyId,
      skillId: hint?.skillId,
    }).catch((err) => {
      log.error("skill.run.failed", {
        trigger,
        err: err instanceof Error ? err.message : String(err),
      });
    });
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
    resolveTrialsForReward(evt);
    triggerRun("reward.updated");
  });

  function dispose(): void {
    offInduced();
    offStatus();
    offReward();
    log.info("skill.subscriber.disposed");
  }

  function runOnce(
    input: Omit<RunSkillInput, "trigger"> & { trigger?: SkillTrigger },
  ): Promise<RunSkillResult> {
    const trigger: SkillTrigger = input.trigger ?? "manual";
    return schedule({
      trigger,
      policyId: input.policyId,
      skillId: input.skillId,
    });
  }

  function applyFeedback(
    skillId: SkillId,
    kind: SkillFeedbackKind,
    magnitude?: number,
  ): void {
    applySkillFeedback(skillId, kind, runDeps, magnitude);
  }

  function resolveTrialsForReward(evt: Extract<RewardEvent, { kind: "reward.updated" }>): void {
    const rTask = evt.result.rHuman;
    const outcome =
      rTask >= 0.5 ? "pass" :
      rTask <= -0.5 ? "fail" :
      "unknown";
    const trials = deps.repos.skillTrials.listPendingForEpisode(evt.result.episodeId);
    if (trials.length === 0) return;
    for (const trial of trials) {
      const evidence = {
        source: "reward.updated",
        episodeId: evt.result.episodeId,
        rTask,
        threshold: { pass: 0.5, fail: -0.5 },
        reason:
          outcome === "pass"
            ? "rTask >= 0.5"
            : outcome === "fail"
              ? "rTask <= -0.5"
              : "-0.5 < rTask < 0.5",
      };
      const changed = deps.repos.skillTrials.resolve(
        trial.id,
        outcome,
        evt.result.completedAt,
        evidence,
      );
      if (!changed) continue;
      if (outcome === "pass" || outcome === "fail") {
        applySkillFeedback(
          trial.skillId,
          outcome === "pass" ? "trial.pass" : "trial.fail",
          runDeps,
        );
      }
      log.info("skill.trial.resolved", {
        trialId: trial.id,
        skillId: trial.skillId,
        episodeId: evt.result.episodeId,
        outcome,
        rTask,
      });
    }
  }

  async function flush(): Promise<void> {
    // Loop in case additional events arrive while the observed tail drains.
    let observed: Promise<void>;
    do {
      observed = schedulerTail;
      await observed;
    } while (observed !== schedulerTail);
  }

  /** Periodic lifecycle pass: promote eligible candidate skills to active. */
  async function lifecycleTick(): Promise<void> {
    const candidates = deps.repos.skills.list({ status: "candidate", limit: 500 });
    for (const s of candidates) {
      if (!shouldPromoteCandidate(s, deps.config)) continue;
      const at = nowMs();
      deps.repos.skills.setStatus(s.id, "active", at);
      log.info("skill.auto_promoted", { skillId: s.id, name: s.name, eta: s.eta });
      deps.bus.emit({
        kind: "skill.status.changed",
        at,
        skillId: s.id,
        previous: "candidate",
        next: "active",
        transition: "promoted",
      });
    }
  }

  return { dispose, runOnce, applyFeedback, flush, lifecycleTick };
}
