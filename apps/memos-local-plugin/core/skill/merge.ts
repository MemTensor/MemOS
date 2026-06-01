/**
 * Field-level merge for rebuild drafts so L0/L1 do not blindly overwrite SOP steps.
 */

import type { SkillCrystallizationDraft, SkillProcedure } from "./types.js";
import type { RebuildLevel } from "./rebuild-level.js";

export type RebuildSection =
  | "retrieval_blurb"
  | "summary"
  | "steps"
  | "parameters"
  | "preconditions"
  | "examples"
  | "decision_guidance"
  | "tools"
  | "tags";

const ALL_SECTIONS: RebuildSection[] = [
  "retrieval_blurb",
  "summary",
  "steps",
  "parameters",
  "preconditions",
  "examples",
  "decision_guidance",
  "tools",
  "tags",
];

export function procedureFromSkillRow(
  procedureJson: unknown,
): SkillProcedure | null {
  if (!procedureJson || typeof procedureJson !== "object") return null;
  return procedureJson as SkillProcedure;
}

export function existingSkillSnapshot(
  proc: SkillProcedure | null,
  lockName: string,
): {
  name: string;
  summary: string;
  retrieval_blurb: string;
  step_titles: string[];
  decision_guidance: { preference: string[]; anti_pattern: string[] };
} | null {
  if (!proc) return null;
  return {
    name: lockName,
    summary: proc.summary ?? "",
    retrieval_blurb: proc.retrievalBlurb ?? "",
    step_titles: (proc.steps ?? []).map((s) => s.title).slice(0, 8),
    decision_guidance: {
      preference: proc.decisionGuidance?.preference ?? [],
      anti_pattern: proc.decisionGuidance?.antiPattern ?? [],
    },
  };
}

export function mergeRebuildDraft(
  draft: SkillCrystallizationDraft,
  existing: SkillProcedure | null,
  opts: {
    level: RebuildLevel;
    lockName?: string;
    changedSections?: string[];
  },
): SkillCrystallizationDraft {
  const lockedName = opts.lockName ?? draft.name;
  if (!existing) {
    return { ...draft, name: lockedName || draft.name };
  }

  const allowed = sectionsForLevel(opts.level, opts.changedSections);
  const keep = (section: RebuildSection): boolean => !allowed.has(section);

  return {
    name: lockedName,
    summary: keep("summary") ? existing.summary : draft.summary,
    retrievalBlurb: keep("retrieval_blurb")
      ? (existing.retrievalBlurb ?? "")
      : draft.retrievalBlurb,
    parameters: keep("parameters") ? existing.parameters : draft.parameters,
    preconditions: keep("preconditions") ? existing.preconditions : draft.preconditions,
    steps: keep("steps") ? existing.steps : draft.steps,
    examples: keep("examples") ? existing.examples : draft.examples,
    tags: keep("tags") ? existing.tags : draft.tags,
    tools: keep("tools") ? existing.tools : draft.tools,
    decisionGuidance: keep("decision_guidance")
      ? (existing.decisionGuidance ?? { preference: [], antiPattern: [] })
      : draft.decisionGuidance,
  };
}

function sectionsForLevel(
  level: RebuildLevel,
  changedSections?: string[],
): Set<RebuildSection> {
  if (level === "L0") {
    return new Set<RebuildSection>(["retrieval_blurb", "summary"]);
  }
  if (level === "L2") {
    return new Set(ALL_SECTIONS);
  }
  const fromLlm = normalizeChangedSections(changedSections);
  if (fromLlm.size > 0) return fromLlm;
  return new Set<RebuildSection>([
    "retrieval_blurb",
    "summary",
    "decision_guidance",
    "steps",
  ]);
}

function normalizeChangedSections(raw?: string[]): Set<RebuildSection> {
  const out = new Set<RebuildSection>();
  if (!raw) return out;
  for (const s of raw) {
    const key = s.trim().toLowerCase();
    if (key === "retrieval_blurb" || key === "retrievalblurb") out.add("retrieval_blurb");
    else if (key === "summary") out.add("summary");
    else if (key === "steps") out.add("steps");
    else if (key === "parameters") out.add("parameters");
    else if (key === "preconditions") out.add("preconditions");
    else if (key === "examples") out.add("examples");
    else if (key === "decision_guidance" || key === "decisionguidance") {
      out.add("decision_guidance");
    } else if (key === "tools") out.add("tools");
    else if (key === "tags") out.add("tags");
  }
  return out;
}
