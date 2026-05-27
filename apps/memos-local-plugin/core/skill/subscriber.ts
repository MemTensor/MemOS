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
import { objectiveOutcome } from "../experience/feedback-builder.js";
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
import type { EpisodeId, SkillId } from "../types.js";

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
    resolveTrialsForReward(evt);
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

  function resolveTrialsForReward(evt: Extract<RewardEvent, { kind: "reward.updated" }>): void {
    const rTask = evt.result.rHuman;
    const looseOutcome =
      rTask >= 0.5 ? "pass" :
      rTask <= -0.5 ? "fail" :
      "unknown";
    const trials = deps.repos.skillTrials.listPendingForEpisode(evt.result.episodeId);
    if (trials.length === 0) return;

    // Strict (verifier-origin repair) trials judge by full credit only — never
    // the loose rTask threshold. Computed lazily (and once) since most trials
    // are loose.
    let strictMemo: "pass" | "fail" | "unknown" | undefined;
    const strictOutcome = (): "pass" | "fail" | "unknown" => {
      if (strictMemo === undefined) {
        strictMemo = computeStrictOutcome(evt.result.episodeId);
      }
      return strictMemo;
    };

    for (const trial of trials) {
      const skill = deps.repos.skills.getById(trial.skillId);
      const strict = skill?.strictTrial === true;
      const outcome = strict ? strictOutcome() : looseOutcome;
      const evidence = {
        source: "reward.updated",
        episodeId: evt.result.episodeId,
        rTask,
        mode: strict ? "strict-full-pass" : "loose-threshold",
        threshold: strict ? { fullPassOnly: true } : { pass: 0.5, fail: -0.5 },
        reason: strict
          ? outcome === "pass"
            ? "verifier full pass"
            : outcome === "fail"
              ? "verifier not a full pass"
              : "no verifier signal on this episode"
          : outcome === "pass"
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
        mode: strict ? "strict" : "loose",
        rTask,
      });
    }
  }

  /**
   * Verifier-only verdict for a strict repair trial: scan the episode's
   * feedback for an objective verifier signal and require a full pass. Returns
   * "unknown" when no verifier payload exists — strict trials never pass on a
   * loose reward.
   */
  function computeStrictOutcome(episodeId: EpisodeId): "pass" | "fail" | "unknown" {
    const rows = deps.repos.feedback.list({ episodeId });
    for (const fb of rows) {
      const o = objectiveOutcome(fb.raw, null);
      if (o !== "unknown") return o;
    }
    return "unknown";
  }

  async function flush(): Promise<void> {
    // Loop in case additional events arrive while we're draining.
    while (inflight) {
      await inflight;
    }
  }

  return { dispose, runOnce, applyFeedback, flush };
}
