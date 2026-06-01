/**
 * Repair candidates — minting an unproven skill from a *constructive negative*.
 *
 * A failed episode whose feedback named a concrete fix produces a negative
 * policy that also carries the suggested fix as a `decisionGuidance.preference`
 * (see `feedback-builder.ts`). That policy is NOT skill-eligible through the
 * normal `hasSuccessAnchor` gate — and it should not be: the fix is unverified.
 *
 * Instead we mint it directly as a **candidate** skill with:
 *   - `eta = REPAIR_CANDIDATE_INITIAL_ETA` (just at the retrieval floor — visible
 *     enough to be tried, zero success credit), and
 *   - `repairOrigin = true` (uses the stricter promotion bar; surfaced as
 *     "unverified" in retrieval), and
 *   - `strictTrial` stamped from the source (verifier origin → full-pass-only
 *     trial judging; soft feedback → loose).
 *
 * It earns trust the same way every other candidate does — via `skill_trials`
 * resolved by the real re-run outcome — and is deduped against the normal
 * crystallization path through `sourcePolicyIds` (a later positive feedback
 * rebuilds *this* skill rather than minting a second one).
 *
 * No LLM call: the policy already carries refined guidance, so this works in
 * the no-LLM fallback path too (unlike `crystallizeDraft`).
 */

import { ids } from "../id.js";
import type { Embedder } from "../embedding/types.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import type { PolicyRow, SkillId, SkillRow, TraceId } from "../types.js";
import { deriveNameFromText, uniquifySkillName } from "./name.js";

/**
 * Q3: born at the retrieval floor — visible enough to be tried, no head start.
 * MUST stay ≥ `retrieval.minSkillEta` / `skill.minEtaForRetrieval` (both default
 * 0.1): tier-1 hides skills with `eta < minSkillEta`, so a candidate born below
 * the floor would never surface, never get a trial, and never validate. Keep
 * this aligned if that floor is raised.
 */
export const REPAIR_CANDIDATE_INITIAL_ETA = 0.1;

export interface MintRepairCandidateDeps {
  repos: Pick<Repos, "skills" | "embeddingRetryQueue">;
  embedder: Embedder | null;
  now?: () => number;
  log?: Logger;
}

/**
 * A constructive negative: a failure (negative polarity, not skill-eligible)
 * whose feedback named a concrete fix (a non-empty `preference`). That fix is
 * the repair we mint as a candidate.
 */
export function isRepairCandidatePolicy(policy: PolicyRow): boolean {
  if ((policy.evidencePolarity ?? "positive") !== "negative") return false;
  if (policy.skillEligible !== false) return false;
  return (policy.decisionGuidance?.preference ?? []).some((s) => s.trim().length > 0);
}

/**
 * Strict when the source carried an objective all-or-nothing verifier signal —
 * those trials must judge by full credit only (Q2). Soft-feedback origin → loose.
 */
export function deriveStrictTrial(policy: PolicyRow): boolean {
  const m = policy.verifierMeta as Record<string, unknown> | null | undefined;
  if (!m) return false;
  return m.passed != null || m.total != null || m.reward != null || m.score != null;
}

/**
 * Mint a candidate repair skill from a constructive-negative policy. Returns the
 * new skill id, or null when the policy is not a repair candidate or a skill
 * already cites it (the normal rebuild path owns updates from then on).
 */
export function mintRepairCandidate(
  policy: PolicyRow,
  deps: MintRepairCandidateDeps,
): SkillId | null {
  if (!isRepairCandidatePolicy(policy)) return null;
  const now = deps.now?.() ?? Date.now();

  // Dedup (Q4): if any non-archived skill already cites this policy, let the
  // normal crystallization/rebuild path own it — don't mint a second skill.
  const already = deps.repos.skills
    .list({ limit: 500 })
    .some((s) => s.status !== "archived" && s.sourcePolicyIds.includes(policy.id));
  if (already) return null;

  const fix = (policy.decisionGuidance?.preference ?? []).find((s) => s.trim().length > 0) ?? "";
  const baseName = deriveNameFromText(stripPrefix(policy.title), fix);
  const existingNames = new Set(
    deps.repos.skills.list({ limit: 500 }).map((s) => s.name),
  );
  const name = uniquifySkillName(baseName, existingNames);
  const id = ids.skill() as SkillId;
  const invocationGuide = renderRepairGuide(policy, fix);

  const row: SkillRow = {
    id,
    ownerAgentKind: policy.ownerAgentKind,
    ownerProfileId: policy.ownerProfileId,
    ownerWorkspaceId: policy.ownerWorkspaceId,
    name,
    status: "candidate",
    invocationGuide,
    procedureJson: null,
    eta: REPAIR_CANDIDATE_INITIAL_ETA,
    support: 1,
    gain: policy.gain,
    trialsAttempted: 0,
    trialsPassed: 0,
    sourcePolicyIds: [policy.id],
    sourceWorldModelIds: [],
    evidenceAnchors: (policy.sourceTraceIds ?? []) as TraceId[],
    vec: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    repairOrigin: true,
    strictTrial: deriveStrictTrial(policy),
  };

  try {
    deps.repos.skills.insert(row);
  } catch (err) {
    // e.g. a unique-name collision — non-fatal, just skip the mint.
    deps.log?.warn("skill.repair_candidate.insert_failed", {
      policyId: policy.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (deps.embedder) {
    deps.repos.embeddingRetryQueue.enqueue({
      id: `er_${ids.span()}`,
      targetKind: "skill",
      targetId: id,
      vectorField: "vec",
      sourceText: invocationGuide || name,
      embedRole: "document",
      now,
    });
  }

  return id;
}

function stripPrefix(title: string): string {
  return title.replace(/^(avoid|repair|prefer|success)\s*:\s*/i, "").trim();
}

function renderRepairGuide(policy: PolicyRow, fix: string): string {
  const lines: string[] = [];
  // Invitational framing, kept in the SAME paragraph as the title (no blank
  // line) so it surfaces in the Tier-1 teaser too. Natural relevance recall is
  // the only thing that gets this candidate validated, so the wording must
  // encourage trying it — frame applying it as double-value (solve + confirm),
  // not as a "low-confidence, avoid" warning that would starve it of trials.
  lines.push(`# ${stripPrefix(policy.title) || "Repair candidate"}`);
  lines.push(
    "Candidate fix distilled from a past failure on a similar task — applying it here both solves the task and confirms the fix.",
  );
  lines.push("");
  if (policy.trigger?.trim()) {
    lines.push("**When to use**");
    lines.push(policy.trigger.trim());
    lines.push("");
  }
  if (fix.trim()) {
    lines.push("**Suggested fix**");
    lines.push(fix.trim());
    lines.push("");
  }
  const antiPattern = policy.decisionGuidance?.antiPattern ?? [];
  if (antiPattern.length) {
    lines.push("**Avoid**");
    for (const a of antiPattern) lines.push(`- ${a}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
