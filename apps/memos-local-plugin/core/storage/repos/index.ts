/**
 * One place to grab a full repo bundle for a given DB handle. This is what
 * `core/pipeline/memory-core.ts` will depend on: it takes a `StorageDb` and
 * asks for everything at once.
 */

import type { StorageDb } from "../types.js";
import {
  embeddingMaintenanceCounts,
  inferStoredEmbeddingByteLen,
  FLOAT32_BYTES,
  type EmbeddingCounts,
  type EmbeddingCountsBucket,
} from "./embedding_maintenance.js";
import { makeApiLogsRepo } from "./api_logs.js";
import { makeAuditRepo } from "./audit.js";
import { makeCandidatePoolRepo } from "./candidate_pool.js";
import { makeDecisionRepairsRepo } from "./decision_repairs.js";
import { makeEmbeddingRetryQueueRepo } from "./embedding_retry_queue.js";
import { makeEpisodesRepo } from "./episodes.js";
import { makeFeedbackRepo } from "./feedback.js";
import { makeHubRepo } from "./hub.js";
import { makeKvRepo } from "./kv.js";
import { makeMigrationsRepo } from "./migrations.js";
import { makePoliciesRepo } from "./policies.js";
import { makeSessionsRepo } from "./sessions.js";
import { makeSkillTrialsRepo } from "./skill_trials.js";
import { makeSkillsRepo } from "./skills.js";
import { makeTracePolicyLinksRepo } from "./trace-policy-links.js";
import { makeTracesRepo } from "./traces.js";
import { makeWorldModelRepo } from "./world_model.js";

export interface Repos {
  apiLogs: ReturnType<typeof makeApiLogsRepo>;
  audit: ReturnType<typeof makeAuditRepo>;
  candidatePool: ReturnType<typeof makeCandidatePoolRepo>;
  decisionRepairs: ReturnType<typeof makeDecisionRepairsRepo>;
  embeddingRetryQueue: ReturnType<typeof makeEmbeddingRetryQueueRepo>;
  episodes: ReturnType<typeof makeEpisodesRepo>;
  feedback: ReturnType<typeof makeFeedbackRepo>;
  hub: ReturnType<typeof makeHubRepo>;
  kv: ReturnType<typeof makeKvRepo>;
  migrations: ReturnType<typeof makeMigrationsRepo>;
  policies: ReturnType<typeof makePoliciesRepo>;
  sessions: ReturnType<typeof makeSessionsRepo>;
  skillTrials: ReturnType<typeof makeSkillTrialsRepo>;
  skills: ReturnType<typeof makeSkillsRepo>;
  tracePolicyLinks: ReturnType<typeof makeTracePolicyLinksRepo>;
  traces: ReturnType<typeof makeTracesRepo>;
  worldModel: ReturnType<typeof makeWorldModelRepo>;
}

export function makeRepos(db: StorageDb): Repos {
  const kv = makeKvRepo(db);
  return {
    apiLogs: makeApiLogsRepo(db),
    audit: makeAuditRepo(db),
    candidatePool: makeCandidatePoolRepo(db),
    decisionRepairs: makeDecisionRepairsRepo(db),
    embeddingRetryQueue: makeEmbeddingRetryQueueRepo(db),
    episodes: makeEpisodesRepo(db),
    feedback: makeFeedbackRepo(db),
    hub: makeHubRepo(db, kv),
    kv,
    migrations: makeMigrationsRepo(db),
    policies: makePoliciesRepo(db),
    sessions: makeSessionsRepo(db),
    skillTrials: makeSkillTrialsRepo(db),
    skills: makeSkillsRepo(db),
    tracePolicyLinks: makeTracePolicyLinksRepo(db),
    traces: makeTracesRepo(db),
    worldModel: makeWorldModelRepo(db),
  };
}

// Also re-export each factory in case callers want just one.
export { makeApiLogsRepo } from "./api_logs.js";
export { makeAuditRepo } from "./audit.js";
export { makeCandidatePoolRepo } from "./candidate_pool.js";
export { makeDecisionRepairsRepo } from "./decision_repairs.js";
export { makeEmbeddingRetryQueueRepo } from "./embedding_retry_queue.js";
export { makeEpisodesRepo } from "./episodes.js";
export { makeFeedbackRepo } from "./feedback.js";
export { makeHubRepo } from "./hub.js";
export { makeKvRepo } from "./kv.js";
export { makeMigrationsRepo } from "./migrations.js";
export { makePoliciesRepo } from "./policies.js";
export { makeSessionsRepo } from "./sessions.js";
export { makeSkillTrialsRepo } from "./skill_trials.js";
export { makeSkillsRepo } from "./skills.js";
export { makeTracePolicyLinksRepo } from "./trace-policy-links.js";
export { makeTracesRepo } from "./traces.js";
export { makeWorldModelRepo } from "./world_model.js";

/**
 * SQL-only embedding maintenance stats — see `./embedding_maintenance.ts`
 * for the design rationale. Regression pin for issue #1929: the old JS
 * path hydrated 270 MB of BLOBs per request; this SQL fast path uses
 * `LENGTH(vec)` alone and never touches the buffers.
 */
export {
  embeddingMaintenanceCounts,
  inferStoredEmbeddingByteLen,
  FLOAT32_BYTES,
};
export type { EmbeddingCounts, EmbeddingCountsBucket };
