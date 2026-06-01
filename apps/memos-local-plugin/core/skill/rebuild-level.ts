/**
 * Automatic rebuild intensity (L0 / L1 / L2) from policy drift + incremental evidence.
 */

import { createHash } from "node:crypto";

import type { PolicyRow, SkillRow, TraceRow } from "../types.js";
import type { SkillProcedure } from "./types.js";

export type RebuildLevel = "L0" | "L1" | "L2";

export function policyContentHash(
  policy: Pick<PolicyRow, "trigger" | "procedure" | "boundary" | "verification">,
): string {
  const text = [policy.trigger, policy.procedure, policy.boundary, policy.verification]
    .map((s) => (s ?? "").trim())
    .join("\n---\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function readStoredPolicyContentHash(skill: SkillRow): string | null {
  const proc = skill.procedureJson;
  if (!proc || typeof proc !== "object") return null;
  const hash = (proc as SkillProcedure).policyContentHash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

export interface RebuildLevelInput {
  policy: PolicyRow;
  existingSkill: SkillRow;
  /** Signature-deduped traces not in `existingSkill.evidenceAnchors`. */
  incrementalEvidence: TraceRow[];
}

export interface RebuildLevelResult {
  level: RebuildLevel;
  policyHash: string;
  previousPolicyHash: string | null;
  incrementalCount: number;
}

/**
 * L0 — policy body unchanged, no new canonical evidence: refresh retrieval text only.
 * L1 — policy unchanged, some incremental evidence: surgical edits.
 * L2 — policy body changed or ≥2 incremental traces: allow full step rewrite.
 */
export function computeRebuildLevel(input: RebuildLevelInput): RebuildLevelResult {
  const policyHash = policyContentHash(input.policy);
  const previousPolicyHash = readStoredPolicyContentHash(input.existingSkill);
  const policyUnchanged =
    previousPolicyHash !== null && previousPolicyHash === policyHash;
  const incrementalCount = input.incrementalEvidence.length;

  let level: RebuildLevel;
  if (!policyUnchanged) {
    level = "L2";
  } else if (incrementalCount === 0) {
    level = "L0";
  } else if (incrementalCount >= 2) {
    level = "L2";
  } else {
    level = "L1";
  }

  return { level, policyHash, previousPolicyHash, incrementalCount };
}
