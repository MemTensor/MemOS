import type { RewardResult } from "../reward/types.js";
import type { EpisodeId, FeedbackId, PolicyId } from "../types.js";
import type { DeepWindowKv } from "./deep-window.js";

export const FEEDBACK_EVOLUTION_QUEUE_KEY = "pipeline.feedback_evolution_queue.v1";

/** Separate from capture obligations: scoring feedback does not finish reflection. */
export interface FeedbackEvolutionJob {
  feedbackId: FeedbackId;
  queuedAt: number;
  episodeId?: EpisodeId;
  prepared: boolean;
  policyId?: PolicyId;
  reward?: RewardResult;
  failedAttempts?: number;
  lastFailureAt?: number;
}

export interface FeedbackEvolutionQueue {
  list(): FeedbackEvolutionJob[];
  put(job: FeedbackEvolutionJob): void;
  acknowledge(feedbackId: FeedbackId): void;
}

/**
 * Durable work, retained until the downstream chain completes. Unlike the
 * bounded capture queue, entries here cannot be dropped: a scored episode
 * may no longer match the dirty-reward predicate, or may still be open.
 */
export function createFeedbackEvolutionQueue(kv: DeepWindowKv): FeedbackEvolutionQueue {
  function list(): FeedbackEvolutionJob[] {
    return kv.get<FeedbackEvolutionJob[]>(FEEDBACK_EVOLUTION_QUEUE_KEY, []);
  }

  return {
    list,
    put(job: FeedbackEvolutionJob): void {
      const jobs = list();
      const index = jobs.findIndex((entry) => entry.feedbackId === job.feedbackId);
      if (index === -1) jobs.push(job);
      else jobs[index] = job;
      kv.set(FEEDBACK_EVOLUTION_QUEUE_KEY, jobs);
    },
    acknowledge(feedbackId: FeedbackId): void {
      kv.set(FEEDBACK_EVOLUTION_QUEUE_KEY, list().filter((job) => job.feedbackId !== feedbackId));
    },
  };
}
