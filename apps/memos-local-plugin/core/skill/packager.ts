/**
 * Converts a verified crystallization draft into a `SkillRow` ready for
 * insertion via `repos.skills`.
 *
 * Structured fields live in `procedureJson` so the viewer can render every
 * facet without parsing `invocationGuide`. The invocation guide itself is a
 * deterministic markdown render of the draft — it's what the retrieval
 * injector hands to the agent's prompt.
 *
 * We also compute the skill embedding here (summary + steps + policy
 * `trigger`) so Tier-1 retrieval is vector-ready.
 */

import { now as nowMs } from "../time.js";
import type { Embedder } from "../embedding/types.js";
import type { Logger } from "../logger/types.js";
import { ids } from "../id.js";
import type {
  EmbeddingVector,
  EpisodeId,
  PolicyId,
  PolicyRow,
  SkillId,
  SkillRow,
  TraceId,
  WorldModelId,
} from "../types.js";
import type {
  SkillConfig,
  SkillCrystallizationDraft,
  SkillProcedure,
} from "./types.js";

export interface PackagerInput {
  draft: SkillCrystallizationDraft;
  policy: PolicyRow;
  evidenceEpisodeIds: EpisodeId[];
  /**
   * V7 §2.1 `evidence_anchors` — the L1 trace ids that justified this
   * skill at crystallisation time. Persisted onto the skill so the
   * viewer can render click-through chips back to MemoriesView and
   * future audits don't have to re-run `gatherEvidence()`.
   *
   * Best-first ordering (matches `gatherEvidence` output). Capped to
   * `EVIDENCE_ANCHORS_CAP` ids in the packager — keeps the column
   * small and the JSON roundtrip cheap.
   */
  evidenceTraceIds?: TraceId[];
  worldModelIds?: WorldModelId[];
  /** When rebuilding, we keep the existing skill id + accumulated trials. */
  existing?: SkillRow | null;
}

/** Hard cap on `SkillRow.evidenceAnchors` so the JSON column stays small. */
const EVIDENCE_ANCHORS_CAP = 10;

export interface PackagerDeps {
  embedder: Embedder | null;
  log: Logger;
  config: SkillConfig;
}

export interface PackagerResult {
  row: SkillRow;
  vecSource: string;
  freshMint: boolean;
}

/**
 * Shape the draft + policy into a `SkillRow`. Does not persist.
 */
export async function buildSkillRow(
  input: PackagerInput,
  deps: PackagerDeps,
): Promise<PackagerResult> {
  const { draft, policy, existing } = input;
  const now = nowMs();
  const freshMint = !existing;
  const id: SkillId = (existing?.id ?? ids.skill()) as SkillId;

  const procedure = buildProcedure(draft);
  const invocationGuide = renderInvocationGuide(draft, policy);

  const trialsAttempted = existing?.trialsAttempted ?? 0;
  const trialsPassed = existing?.trialsPassed ?? 0;
  const initialEta = deriveInitialEta(policy, existing ?? null, deps.config);

  const vecSource = buildVecSource(draft, policy);
  const vec = await tryEmbed(deps, vecSource);

  // Merge new evidence with whatever the previous skill version had,
  // keeping new (fresher / better-scoring) ids first and dropping
  // duplicates. Capped at EVIDENCE_ANCHORS_CAP so a long-lived skill
  // doesn't grow an unbounded list across many rebuilds.
  const evidenceAnchors = dedupe<TraceId>([
    ...(input.evidenceTraceIds ?? []),
    ...(existing?.evidenceAnchors ?? []),
  ]).slice(0, EVIDENCE_ANCHORS_CAP);

  const row: SkillRow = {
    id,
    ownerAgentKind: existing?.ownerAgentKind ?? policy.ownerAgentKind,
    ownerProfileId: existing?.ownerProfileId ?? policy.ownerProfileId,
    ownerWorkspaceId: existing?.ownerWorkspaceId ?? policy.ownerWorkspaceId,
    name: draft.name,
    status: "candidate",
    invocationGuide,
    procedureJson: procedure,
    eta: initialEta,
    support: policy.support,
    gain: policy.gain,
    trialsAttempted,
    trialsPassed,
    sourcePolicyIds: dedupe<PolicyId>([policy.id, ...(existing?.sourcePolicyIds ?? [])]),
    sourceWorldModelIds: dedupe<WorldModelId>([
      ...(existing?.sourceWorldModelIds ?? []),
      ...(input.worldModelIds ?? []),
    ]),
    evidenceAnchors,
    vec,
    createdAt: (existing?.createdAt ?? (now as SkillRow["createdAt"])),
    updatedAt: now as SkillRow["updatedAt"],
    // Fresh skill starts at v1; every rebuild bumps the counter by one
    // so the viewer can show "this skill has evolved N times" next to
    // the timeline sourced from api_logs (skill_generate / skill_evolve).
    version: existing ? (existing.version ?? 1) + 1 : 1,
    usageCount: existing?.usageCount ?? 0,
    lastUsedAt: existing?.lastUsedAt ?? null,
  };

  return { row, vecSource, freshMint };
}

function buildProcedure(draft: SkillCrystallizationDraft): SkillProcedure {
  return {
    summary: draft.summary,
    parameters: draft.parameters,
    preconditions: draft.preconditions,
    steps: draft.steps,
    examples: draft.examples,
    decisionGuidance: draft.decisionGuidance ?? { preference: [], antiPattern: [] },
    tags: draft.tags,
    tools: draft.tools ?? [],
  };
}

function renderInvocationGuide(
  draft: SkillCrystallizationDraft,
  policy: PolicyRow,
): string {
  const lines: string[] = [];
  lines.push(`# ${draft.displayTitle}`);
  lines.push("");
  if (draft.summary) {
    lines.push(draft.summary);
    lines.push("");
  }
  lines.push(`**When to use**`);
  lines.push(policy.trigger.trim() || "(derived from policy)");
  lines.push("");
  if (draft.preconditions.length) {
    lines.push(`**Preconditions**`);
    for (const p of draft.preconditions) lines.push(`- ${p}`);
    lines.push("");
  }
  if (draft.parameters.length) {
    lines.push(`**Parameters**`);
    for (const p of draft.parameters) {
      const req = p.required ? " _(required)_" : "";
      lines.push(`- \`${p.name}\`: ${p.type}${req} — ${p.description || ""}`);
    }
    lines.push("");
  }
  if (draft.steps.length) {
    lines.push(`**Procedure**`);
    draft.steps.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title}** — ${s.body}`);
    });
    lines.push("");
  }
  if (draft.examples.length) {
    lines.push(`**Examples**`);
    for (const e of draft.examples) {
      lines.push(`- Input: \`${e.input}\``);
      lines.push(`  Expected: ${e.expected}`);
    }
    lines.push("");
  }
  if (draft.tools && draft.tools.length > 0) {
    lines.push(`**Tools used**`);
    for (const t of draft.tools) lines.push(`- \`${t}\``);
    lines.push("");
  }
  const dg = draft.decisionGuidance;
  if (dg && (dg.preference.length > 0 || dg.antiPattern.length > 0)) {
    lines.push(`**Decision guidance**`);
    if (dg.preference.length > 0) {
      lines.push("Prefer:");
      for (const p of dg.preference) lines.push(`- ${p}`);
    }
    if (dg.antiPattern.length > 0) {
      lines.push("Avoid:");
      for (const a of dg.antiPattern) lines.push(`- ${a}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function deriveInitialEta(
  policy: PolicyRow,
  existing: SkillRow | null,
  cfg: SkillConfig,
): number {
  if (existing && existing.trialsAttempted > 0) {
    return clamp01(existing.eta);
  }
  const base = Math.min(1, Math.max(0, policy.gain));
  const supportWeight = Math.min(1, policy.support / Math.max(1, cfg.minSupport));
  const seed = 0.5 * base + 0.5 * supportWeight;
  return clamp01(Math.max(cfg.minEtaForRetrieval, seed));
}

function buildVecSource(
  draft: SkillCrystallizationDraft,
  policy: PolicyRow,
): string {
  const head = draft.summary || draft.displayTitle || draft.name;
  const steps = draft.steps
    .slice(0, 5)
    .map((s) => `${s.title}: ${s.body}`)
    .join("\n");
  const trigger = policy.trigger;
  return [head, trigger, steps].filter(Boolean).join("\n");
}

async function tryEmbed(
  deps: PackagerDeps,
  text: string,
): Promise<EmbeddingVector | null> {
  if (!deps.embedder || !text) return null;
  try {
    return await deps.embedder.embedOne({ text, role: "document" });
  } catch (err) {
    deps.log.warn("skill.packager.embed_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function dedupe<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (x == null) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
