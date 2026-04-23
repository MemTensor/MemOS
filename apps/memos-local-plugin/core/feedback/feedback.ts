/**
 * V7 §2.4.6 — Decision Repair orchestrator.
 *
 * Entry points:
 *
 *   - `runRepair(input, deps)` — imperative API. Called by the subscriber
 *     whenever a failure burst is detected or a user message is classified
 *     as `negative` / `preference`.
 *
 *   - `attachRepairToPolicies(draft, deps)` — append the draft's
 *     preference / anti-pattern onto the `decisionGuidance` field of each
 *     referenced policy. Only runs when `config.attachToPolicy === true`.
 *
 * The orchestrator never mutates state on its own unless it decides to
 * persist: every write is a single atomic insert into `decision_repairs`
 * plus, optionally, per-policy `update`s. Failures are always scoped:
 * logged, emitted as `repair.skipped`, and the orchestrator returns a
 * skip result.
 */

import type { Embedder } from "../embedding/types.js";
import type { LlmClient } from "../llm/types.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import { ids } from "../id.js";
import { now as nowMs } from "../time.js";
import type {
  DecisionRepairRow,
  EpochMs,
  PolicyId,
  PolicyRow,
  SessionId,
  TraceRow,
} from "../types.js";
import { classifyFeedback } from "./classifier.js";
import { gatherRepairEvidence } from "./evidence.js";
import { synthesizeDraft } from "./synthesize.js";
import type {
  ClassifiedFeedback,
  DecisionRepairDraft,
  FeedbackConfig,
  FeedbackEventBus,
  RepairInput,
  RepairResult,
  RepairTrigger,
} from "./types.js";

export interface RepairDeps {
  repos: Repos;
  llm: LlmClient | null;
  embedder: Embedder | null;
  bus: FeedbackEventBus;
  log: Logger;
  config: FeedbackConfig;
}

// ─── Main orchestrator ─────────────────────────────────────────────────────

export async function runRepair(
  input: RepairInput,
  deps: RepairDeps,
): Promise<RepairResult> {
  const startedAt = nowMs() as EpochMs;
  const log = deps.log;
  const { bus, repos, config } = deps;

  log.info("repair.run.start", {
    trigger: input.trigger,
    contextHash: input.contextHash,
    toolId: input.toolId,
  });

  // Cooldown guard — same context, quickly reissued triggers are squelched.
  if (isOnCooldown(repos, input.contextHash, config, startedAt)) {
    log.info("repair.cooldown", { contextHash: input.contextHash });
    bus.emit({
      kind: "repair.skipped",
      at: startedAt,
      contextHash: input.contextHash,
      trigger: input.trigger,
      reason: "cooldown",
    });
    return skip(input, startedAt, "cooldown");
  }

  // Classify the user text if the caller provided one.
  const classified = input.userText
    ? classifyFeedback(input.userText)
    : undefined;
  if (classified) {
    bus.emit({
      kind: "feedback.classified",
      at: startedAt,
      shape: classified.shape,
      confidence: classified.confidence,
    });
  }

  if (!sessionKnown(input)) {
    bus.emit({
      kind: "repair.skipped",
      at: startedAt,
      contextHash: input.contextHash,
      trigger: input.trigger,
      reason: "no-session",
    });
    return skip(input, startedAt, "no-session");
  }

  // Gather evidence from recent traces in the same session.
  const evidence = gatherRepairEvidence(
    {
      sessionId: input.sessionId as SessionId,
      keyword: input.toolId ?? classified?.prefer ?? classified?.avoid,
      limit: config.evidenceLimit,
    },
    { repos, config, log: log.child({ channel: "core.feedback.evidence" }) },
  );

  const valueDiff = computeValueDiff(evidence.highValue, evidence.lowValue);
  if (valueDiff < config.valueDelta && !classified) {
    // Without an explicit user signal, small deltas aren't worth persisting.
    log.info("repair.valueDiff.below_threshold", {
      contextHash: input.contextHash,
      valueDiff,
      threshold: config.valueDelta,
    });
    bus.emit({
      kind: "repair.skipped",
      at: startedAt,
      contextHash: input.contextHash,
      trigger: input.trigger,
      reason: "value-delta-low",
    });
    return skip(input, startedAt, "value-delta-low");
  }

  // Look up any policies that both high- and low-value evidence point to
  // so we can attach the draft to them.
  const candidatePolicies = collectCandidatePolicies(
    [...evidence.highValue, ...evidence.lowValue],
    repos,
  );

  bus.emit({
    kind: "repair.triggered",
    at: startedAt,
    contextHash: input.contextHash,
    trigger: input.trigger,
    failureCount: input.failures?.length,
  });

  const synth = await synthesizeDraft(
    {
      trigger: input.trigger,
      contextHash: input.contextHash,
      highValue: evidence.highValue,
      lowValue: evidence.lowValue,
      classifiedFeedback: classified,
      toolId: input.toolId,
      candidatePolicies,
    },
    {
      llm: deps.llm,
      log: log.child({ channel: "core.feedback.synthesize" }),
      config,
    },
  );

  if (!synth.ok) {
    log.info("repair.skipped", {
      contextHash: input.contextHash,
      reason: synth.reason,
      highValue: evidence.highValue.length,
      lowValue: evidence.lowValue.length,
    });
    bus.emit({
      kind: "repair.skipped",
      at: startedAt,
      contextHash: input.contextHash,
      trigger: input.trigger,
      reason: synth.reason,
    });
    return skip(input, startedAt, synth.reason);
  }

  const row = persistRepair(repos, synth.draft, startedAt);
  log.info("repair.persisted", {
    id: row.id,
    contextHash: row.contextHash,
    confidence: synth.draft.confidence,
    severity: synth.draft.severity,
  });
  bus.emit({
    kind: "repair.persisted",
    at: nowMs() as EpochMs,
    contextHash: row.contextHash,
    repairId: row.id,
    confidence: synth.draft.confidence,
    severity: synth.draft.severity,
  });

  if (config.attachToPolicy && synth.draft.attachToPolicyIds.length > 0) {
    const attached = attachRepairToPolicies(synth.draft, deps);
    if (attached.length > 0) {
      bus.emit({
        kind: "repair.attached",
        at: nowMs() as EpochMs,
        repairId: row.id,
        policyIds: attached,
      });
    }
  }

  return {
    trigger: input.trigger,
    contextHash: input.contextHash,
    repairId: row.id,
    draft: synth.draft,
    skipped: false,
    startedAt,
    completedAt: nowMs() as EpochMs,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sessionKnown(input: RepairInput): boolean {
  if (!input.sessionId) return false;
  return Boolean(input.sessionId);
}

function computeValueDiff(high: TraceRow[], low: TraceRow[]): number {
  if (high.length === 0 || low.length === 0) {
    // Any single-side signal is already noteworthy — return a neutral
    // value that still allows the user-triggered branch to fire.
    return Infinity;
  }
  const meanHigh = mean(high.map((t) => t.value));
  const meanLow = mean(low.map((t) => t.value));
  return Math.abs(meanHigh - meanLow);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function collectCandidatePolicies(traces: TraceRow[], repos: Repos): PolicyRow[] {
  // Policies whose sourceEpisodeIds intersect the evidence trace episodes
  // are the policies we want to tag. Fetch the small window of active
  // policies and filter.
  const episodeIds = new Set<string>();
  for (const t of traces) episodeIds.add(t.episodeId as string);
  if (episodeIds.size === 0) return [];
  const policies = repos.policies.list({ status: "active", limit: 200 });
  return policies.filter((p) =>
    p.sourceEpisodeIds.some((eid) => episodeIds.has(eid as string)),
  );
}

function isOnCooldown(
  repos: Repos,
  contextHash: string,
  cfg: FeedbackConfig,
  now: EpochMs,
): boolean {
  if (cfg.cooldownMs <= 0) return false;
  const recent = repos.decisionRepairs.recentForContext(contextHash);
  if (recent.length === 0) return false;
  const last = recent[0]!;
  return now - last.ts < cfg.cooldownMs;
}

function persistRepair(
  repos: Repos,
  draft: DecisionRepairDraft,
  ts: EpochMs,
): DecisionRepairRow {
  const row: DecisionRepairRow = {
    id: ids.decisionRepair(),
    ts,
    contextHash: draft.contextHash,
    preference: draft.preference,
    antiPattern: draft.antiPattern,
    highValueTraceIds: [...draft.highValueTraceIds],
    lowValueTraceIds: [...draft.lowValueTraceIds],
    validated: false,
  };
  repos.decisionRepairs.insert(row);
  return row;
}

function skip(
  input: RepairInput,
  startedAt: EpochMs,
  reason: string,
): RepairResult {
  return {
    trigger: input.trigger,
    contextHash: input.contextHash,
    repairId: null,
    draft: null,
    skipped: true,
    skippedReason: reason,
    startedAt,
    completedAt: nowMs() as EpochMs,
  };
}

// ─── Policy attachment ────────────────────────────────────────────────────

export interface AttachDeps {
  repos: Repos;
  log: Logger;
}

/**
 * Append the repair draft's preference / anti-pattern onto the candidate
 * policies' decision_guidance metadata. Returns the list of policy IDs
 * that were actually updated.
 */
export function attachRepairToPolicies(
  draft: DecisionRepairDraft,
  deps: AttachDeps,
): PolicyId[] {
  const updated: PolicyId[] = [];
  for (const policyId of draft.attachToPolicyIds) {
    const policy = deps.repos.policies.getById(policyId);
    if (!policy) continue;
    const next = mergePolicyGuidance(policy, draft);
    if (!next) continue;
    deps.repos.policies.upsert(next);
    updated.push(policyId);
    deps.log.debug("repair.attached.policy", { policyId });
  }
  return updated;
}

/**
 * Policies don't currently carry a structured `decisionGuidance` column —
 * we stash the pair as a JSON blob under the kv-like `raw` meta field on
 * the policy's `boundary` string, prefixed so the skill crystallizer can
 * pick it up. Skills also carry the same guidance via `procedureJson`,
 * which the packager fills in automatically on the next crystallize run.
 */
function mergePolicyGuidance(
  policy: PolicyRow,
  draft: DecisionRepairDraft,
): PolicyRow | null {
  const tag = "@repair";
  const existing = policy.boundary ?? "";
  const current = parseGuidanceBlock(existing);
  const nextPref = dedupeKeep(current.preference.concat(draft.preference));
  const nextAvoid = dedupeKeep(current.antiPattern.concat(draft.antiPattern));
  if (
    arraysEqual(nextPref, current.preference) &&
    arraysEqual(nextAvoid, current.antiPattern)
  ) {
    return null;
  }
  const without = stripGuidanceBlock(existing, tag);
  const nextBoundary = [without.trim(), renderGuidanceBlock(tag, nextPref, nextAvoid)]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...policy,
    boundary: nextBoundary,
    updatedAt: nowMs() as PolicyRow["updatedAt"],
  };
}

interface GuidanceBlock {
  preference: string[];
  antiPattern: string[];
}

function parseGuidanceBlock(raw: string): GuidanceBlock {
  const match = raw.match(/^@repair\s*(\{[\s\S]*?\})/m);
  if (!match) return { preference: [], antiPattern: [] };
  try {
    const parsed = JSON.parse(match[1]!) as Partial<GuidanceBlock>;
    return {
      preference: Array.isArray(parsed.preference)
        ? parsed.preference.map(String)
        : [],
      antiPattern: Array.isArray(parsed.antiPattern)
        ? parsed.antiPattern.map(String)
        : [],
    };
  } catch {
    return { preference: [], antiPattern: [] };
  }
}

function stripGuidanceBlock(raw: string, tag: string): string {
  const re = new RegExp(`^${tag}\\s*\\{[\\s\\S]*?\\}`, "m");
  return raw.replace(re, "");
}

function renderGuidanceBlock(
  tag: string,
  preference: readonly string[],
  antiPattern: readonly string[],
): string {
  const payload = JSON.stringify({ preference, antiPattern });
  return `${tag} ${payload}`;
}

function dedupeKeep(xs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of xs) {
    const key = x.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

