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
import { policyContentHash } from "./rebuild-level.js";
import type { SkillOutputLanguage } from "./language.js";

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
  /** User query lines from top evidence traces — boosts embedding recall. */
  evidenceUserTexts?: string[];
  worldModelIds?: WorldModelId[];
  /** When rebuilding, we keep the existing skill id + accumulated trials. */
  existing?: SkillRow | null;
  outputLanguage?: SkillOutputLanguage;
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

  const outputLanguage = input.outputLanguage ?? "en";
  const existingProcedure = readExistingProcedure(existing);
  const procedure = buildProcedure(draft, policy, outputLanguage, existingProcedure);
  const invocationGuide = renderInvocationGuide(draft, outputLanguage);

  const trialsAttempted = existing?.trialsAttempted ?? 0;
  const trialsPassed = existing?.trialsPassed ?? 0;
  const initialEta = deriveInitialEta(policy, existing ?? null, deps.config);

  const vecSource = buildVecSource(draft, outputLanguage, input.evidenceUserTexts);
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
    // `repairOrigin` is intentionally dropped on rebuild — once a candidate
    // is rebuilt from real evidence we promote on the normal η threshold.
    // `strictTrial`, in contrast, governs *how* trials are judged (verifier
    // full-pass vs loose rTask>=0.5) and reflects the verifier-origin of the
    // source policy. New evidence does not change that, so we preserve it.
    strictTrial: existing?.strictTrial ?? false,
  };

  return { row, vecSource, freshMint };
}

function buildProcedure(
  draft: SkillCrystallizationDraft,
  policy: PolicyRow,
  outputLanguage: SkillOutputLanguage,
  existing: SkillProcedure | null,
): SkillProcedure {
  const proc: SkillProcedure = {
    summary: draft.summary,
    retrievalBlurb: draft.retrievalBlurb,
    triggerContext: draft.triggerContext ?? "",
    policyContentHash: policyContentHash(policy),
    outputLanguage,
    parameters: draft.parameters,
    preconditions: draft.preconditions,
    steps: draft.steps,
    examples: draft.examples,
    decisionGuidance: draft.decisionGuidance ?? { preference: [], antiPattern: [] },
    tags: draft.tags,
    tools: draft.tools ?? [],
  };
  // §12 A — once a repair-origin skill graduates to its canonical name we
  // must keep the flag so subsequent rebuilds (which no longer carry
  // `repairOrigin`) still recognise the single-use rename has been spent.
  if (existing?.graduatedFromRepairName) proc.graduatedFromRepairName = true;
  return proc;
}

function readExistingProcedure(
  existing: SkillRow | null | undefined,
): SkillProcedure | null {
  if (!existing) return null;
  const proc = existing.procedureJson;
  if (!proc || typeof proc !== "object") return null;
  return proc as SkillProcedure;
}

function renderInvocationGuide(
  draft: SkillCrystallizationDraft,
  outputLanguage: SkillOutputLanguage,
): string {
  const i18n = sectionI18n(outputLanguage);
  const lines: string[] = [];
  lines.push(`# ${draft.name}`);
  lines.push("");
  if (draft.retrievalBlurb) {
    lines.push(`**${i18n.retrieval}**`);
    lines.push(draft.retrievalBlurb);
    lines.push("");
  }
  if (draft.summary) {
    lines.push(`**${i18n.summary}**`);
    lines.push(draft.summary);
    lines.push("");
  }
  if (draft.triggerContext?.trim()) {
    lines.push(`**${i18n.context}**`);
    lines.push(draft.triggerContext.trim());
    lines.push("");
  }
  if (draft.preconditions.length) {
    lines.push(`**${i18n.preconditions}**`);
    for (const p of draft.preconditions) lines.push(`- ${p}`);
    lines.push("");
  }
  if (draft.parameters.length) {
    lines.push(`**${i18n.parameters}**`);
    for (const p of draft.parameters) {
      const req = p.required ? " _(required)_" : "";
      lines.push(`- \`${p.name}\`: ${p.type}${req} — ${p.description || ""}`);
    }
    lines.push("");
  }
  if (draft.steps.length) {
    lines.push(`**${i18n.procedure}**`);
    draft.steps.forEach((s, i) => {
      lines.push(`${i + 1}. **${s.title}** — ${s.body}`);
    });
    lines.push("");
  }
  if (draft.examples.length) {
    lines.push(`**${i18n.examples}**`);
    for (const e of draft.examples) {
      lines.push(`- ${i18n.input}: \`${e.input}\``);
      lines.push(`  ${i18n.expected}: ${e.expected}`);
    }
    lines.push("");
  }
  if (draft.tools && draft.tools.length > 0) {
    lines.push(`**${i18n.tools}**`);
    for (const t of draft.tools) lines.push(`- \`${t}\``);
    lines.push("");
  }
  const dg = draft.decisionGuidance;
  if (dg && (dg.preference.length > 0 || dg.antiPattern.length > 0)) {
    lines.push(`**${i18n.guidance}**`);
    if (dg.preference.length > 0) {
      lines.push(i18n.prefer);
      for (const p of dg.preference) lines.push(`- ${p}`);
    }
    if (dg.antiPattern.length > 0) {
      lines.push(i18n.avoid);
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
  _outputLanguage: SkillOutputLanguage,
  evidenceUserTexts?: string[],
): string {
  const blurb = draft.retrievalBlurb?.trim() ?? "";
  const steps = draft.steps
    .slice(0, 5)
    .map((s) => `${s.title}: ${s.body}`)
    .join("\n");
  const trigger = draft.triggerContext?.trim() ?? "";
  const querySnippets = (evidenceUserTexts ?? [])
    .map((q) => q.trim())
    .filter((q) => q.length > 0 && q !== "[REDACTED]")
    .slice(0, 2)
    .join("\n");
  return [blurb, trigger, draft.summary, steps, querySnippets].filter(Boolean).join("\n");
}

function sectionI18n(lang: SkillOutputLanguage): {
  retrieval: string;
  summary: string;
  context: string;
  preconditions: string;
  parameters: string;
  procedure: string;
  examples: string;
  tools: string;
  guidance: string;
  prefer: string;
  avoid: string;
  input: string;
  expected: string;
} {
  if (lang === "zh") {
    return {
      retrieval: "检索与适用场景",
      summary: "概要",
      context: "触发上下文",
      preconditions: "前置条件",
      parameters: "参数",
      procedure: "执行步骤",
      examples: "示例",
      tools: "涉及工具",
      guidance: "决策指引",
      prefer: "优先：",
      avoid: "避免：",
      input: "输入",
      expected: "预期",
    };
  }
  return {
    retrieval: "Retrieval & when to use",
    summary: "Summary",
    context: "Context",
    preconditions: "Preconditions",
    parameters: "Parameters",
    procedure: "Procedure",
    examples: "Examples",
    tools: "Tools used",
    guidance: "Decision guidance",
    prefer: "Prefer:",
    avoid: "Avoid:",
    input: "Input",
    expected: "Expected",
  };
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
