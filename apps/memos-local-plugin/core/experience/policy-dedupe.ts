import type { Repos } from "../storage/repos/index.js";
import { extractPatternTerms, prepareFtsMatch } from "../storage/keyword.js";
import type { PolicyRow } from "../types.js";

const POLICY_DEDUP_RECALL_K = 200;
const POLICY_NEAR_DUP_TITLE_MIN = 0.9;
const POLICY_NEAR_DUP_TRIGGER_MIN = 0.8;
const POLICY_NEAR_DUP_PROCEDURE_MIN = 0.7;
const POLICY_NEAR_DUP_OPTIONAL_MIN = 0.45;

const FAILURE_FAMILIES = new Set<NonNullable<PolicyRow["mergeFamily"]>>([
  "failure_avoidance",
  "failure_corrective",
]);

const FAILURE_DEFAULT_TEMPLATES = new Set([
  "Failure sink policy",
  "失败场景触发",
  "分析失败原因并执行最小修复步骤",
  "重跑关键步骤确认失败不再出现",
].map(normalizePolicyText));

export interface PolicyContentDedupOptions {
  statusIn?: readonly PolicyRow["status"][];
  profile: "l2-induction" | "failure-sink";
}

export interface PolicyNearDuplicateScore {
  match: boolean;
  title: number;
  trigger: number;
  procedure: number;
  weighted: number;
  boundary: number | null;
  verification: number | null;
}

export function findExistingPolicyContentDuplicate(
  policy: PolicyRow,
  repos: Pick<Repos, "policies">,
  options: PolicyContentDedupOptions,
): PolicyRow | null {
  if (options.profile === "failure-sink" && hasFailureDefaultKeyField(policy)) {
    return null;
  }

  const query = buildRecallQuery(policy, options.profile);
  if (!query) return null;

  const hits = new Map<string, true>();
  const searchOpts = {
    statusIn: [...(options.statusIn ?? ["active", "candidate"])] as PolicyRow["status"][],
    ownerAgentKind: policy.ownerAgentKind,
    ownerProfileId: policy.ownerProfileId,
    ownerWorkspaceId: policy.ownerWorkspaceId,
  };
  const ftsMatch = prepareFtsMatch(query);
  if (ftsMatch) {
    for (const hit of repos.policies.searchTitleTriggerByText(
      ftsMatch,
      POLICY_DEDUP_RECALL_K,
      searchOpts,
    )) {
      hits.set(hit.id, true);
    }
  }
  const patternTerms = extractPatternTerms(query);
  if (patternTerms.length > 0 && repos.policies.searchTitleTriggerByPattern) {
    for (const hit of repos.policies.searchTitleTriggerByPattern(
      patternTerms,
      POLICY_DEDUP_RECALL_K,
      searchOpts,
    )) {
      hits.set(hit.id, true);
    }
  }
  if (hits.size === 0) return null;

  let best: { row: PolicyRow; score: PolicyNearDuplicateScore } | null = null;
  for (const id of hits.keys()) {
    const existing = repos.policies.getById(id as PolicyRow["id"]);
    if (!existing) continue;
    if (!sameOwnerScope(existing, policy)) continue;
    if (options.statusIn && !options.statusIn.includes(existing.status)) continue;
    if (!familyCompatible(existing, policy, options.profile)) continue;
    if (options.profile === "failure-sink" && hasFailureDefaultKeyField(existing)) {
      continue;
    }

    if (
      policyContentKey(existing) === policyContentKey(policy)
      && policyOptionalFieldsCompatible(existing, policy, options.profile)
    ) {
      return existing;
    }

    const score = policyNearDuplicateScore(existing, policy, options.profile);
    if (!score.match) continue;
    if (!best || compareDuplicateCandidate(existing, score, best.row, best.score) < 0) {
      best = { row: existing, score };
    }
  }
  return best?.row ?? null;
}

export function policyNearDuplicateScore(
  a: Pick<PolicyRow, "title" | "trigger" | "procedure" | "boundary" | "verification">,
  b: Pick<PolicyRow, "title" | "trigger" | "procedure" | "boundary" | "verification">,
  profile: PolicyContentDedupOptions["profile"] = "l2-induction",
): PolicyNearDuplicateScore {
  const title = textSimilarity(a.title, b.title);
  const trigger = textSimilarity(a.trigger, b.trigger);
  const procedure = textSimilarity(a.procedure, b.procedure);
  const weighted = title * 0.45 + trigger * 0.25 + procedure * 0.3;
  const boundary = optionalFieldSimilarity(a.boundary, b.boundary, profile);
  const verification = optionalFieldSimilarity(a.verification, b.verification, profile);
  const optionalFieldsCompatible =
    !boundaryPolarityConflicts(a.boundary, b.boundary) &&
    (boundary == null || boundary >= POLICY_NEAR_DUP_OPTIONAL_MIN) &&
    (verification == null || verification >= POLICY_NEAR_DUP_OPTIONAL_MIN);
  return {
    match:
      title >= POLICY_NEAR_DUP_TITLE_MIN &&
      trigger >= POLICY_NEAR_DUP_TRIGGER_MIN &&
      procedure >= POLICY_NEAR_DUP_PROCEDURE_MIN &&
      optionalFieldsCompatible,
    title,
    trigger,
    procedure,
    weighted,
    boundary,
    verification,
  };
}

export function policyContentKey(policy: Pick<PolicyRow, "title" | "trigger" | "procedure">): string {
  return [
    normalizePolicyText(policy.title),
    normalizePolicyText(policy.trigger),
    normalizePolicyText(policy.procedure),
  ].join("\n");
}

export function policyOptionalFieldsCompatible(
  a: Pick<PolicyRow, "boundary" | "verification">,
  b: Pick<PolicyRow, "boundary" | "verification">,
  profile: PolicyContentDedupOptions["profile"] = "l2-induction",
): boolean {
  const boundary = optionalFieldSimilarity(a.boundary, b.boundary, profile);
  const verification = optionalFieldSimilarity(a.verification, b.verification, profile);
  return (
    !boundaryPolarityConflicts(a.boundary, b.boundary) &&
    (boundary == null || boundary >= POLICY_NEAR_DUP_OPTIONAL_MIN) &&
    (verification == null || verification >= POLICY_NEAR_DUP_OPTIONAL_MIN)
  );
}

export function normalizePolicyText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[，,、;；:：。.!！?？"'“”‘’`()[\]{}（）【】]/g, "")
    .replace(/(?:^|\s)\d+[.)、]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function textSimilarity(a: string, b: string): number {
  const aa = normalizePolicyText(a);
  const bb = normalizePolicyText(b);
  if (!aa || !bb) return aa === bb ? 1 : 0;
  if (aa === bb) return 1;
  const gramsA = charGrams(aa);
  const gramsB = charGrams(bb);
  let overlap = 0;
  for (const [gram, countA] of gramsA) {
    const countB = gramsB.get(gram);
    if (countB) overlap += Math.min(countA, countB);
  }
  const totalA = Array.from(gramsA.values()).reduce((sum, n) => sum + n, 0);
  const totalB = Array.from(gramsB.values()).reduce((sum, n) => sum + n, 0);
  return totalA + totalB === 0 ? 0 : (2 * overlap) / (totalA + totalB);
}

export function optionalFieldSimilarity(
  a: string,
  b: string,
  profile: PolicyContentDedupOptions["profile"] = "l2-induction",
): number | null {
  const aa = normalizePolicyText(a);
  const bb = normalizePolicyText(b);
  if (!aa || !bb) return null;
  if (profile === "failure-sink" && (isFailureDefaultText(aa) || isFailureDefaultText(bb))) {
    return null;
  }
  return textSimilarity(aa, bb);
}

export function boundaryPolarityConflicts(a: string, b: string): boolean {
  const aa = splitBoundaryPolarity(a);
  const bb = splitBoundaryPolarity(b);
  if (!aa || !bb) return false;
  return (
    (Boolean(aa.positive) && Boolean(bb.negative) && textSimilarity(aa.positive, bb.negative) >= 0.45) ||
    (Boolean(bb.positive) && Boolean(aa.negative) && textSimilarity(bb.positive, aa.negative) >= 0.45)
  );
}

function buildRecallQuery(
  policy: Pick<PolicyRow, "title" | "trigger">,
  profile: PolicyContentDedupOptions["profile"],
): string {
  const parts = [policy.title, policy.trigger].filter((value) => {
    const text = normalizePolicyText(value);
    if (!text) return false;
    return profile !== "failure-sink" || !isFailureDefaultText(text);
  });
  return parts.join(" ").trim();
}

function compareDuplicateCandidate(
  a: PolicyRow,
  scoreA: PolicyNearDuplicateScore,
  b: PolicyRow,
  scoreB: PolicyNearDuplicateScore,
): number {
  if (scoreA.weighted !== scoreB.weighted) return scoreB.weighted - scoreA.weighted;
  if (a.status !== b.status) {
    if (a.status === "active") return -1;
    if (b.status === "active") return 1;
  }
  return Number(b.updatedAt) - Number(a.updatedAt);
}

function familyCompatible(
  existing: PolicyRow,
  incoming: PolicyRow,
  profile: PolicyContentDedupOptions["profile"],
): boolean {
  if (profile === "l2-induction") {
    return !existing.mergeFamily || !incoming.mergeFamily || existing.mergeFamily === incoming.mergeFamily;
  }
  if (!existing.mergeFamily || !incoming.mergeFamily) return false;
  if (!FAILURE_FAMILIES.has(existing.mergeFamily) || !FAILURE_FAMILIES.has(incoming.mergeFamily)) {
    return false;
  }
  return existing.evidencePolarity !== "positive";
}

function hasFailureDefaultKeyField(policy: Pick<PolicyRow, "title" | "trigger" | "procedure">): boolean {
  return [policy.title, policy.trigger, policy.procedure].some((value) => {
    const text = normalizePolicyText(value);
    return !text || isFailureDefaultText(text);
  });
}

function isFailureDefaultText(normalizedText: string): boolean {
  return FAILURE_DEFAULT_TEMPLATES.has(normalizedText);
}

function sameOwnerScope(a: PolicyRow, b: PolicyRow): boolean {
  return (
    (a.ownerAgentKind ?? "unknown") === (b.ownerAgentKind ?? "unknown") &&
    (a.ownerProfileId ?? "default") === (b.ownerProfileId ?? "default") &&
    (a.ownerWorkspaceId ?? null) === (b.ownerWorkspaceId ?? null)
  );
}

function splitBoundaryPolarity(value: string): { positive: string; negative: string } | null {
  const text = value.trim();
  if (!text || !text.includes("不适用")) return null;
  const [positiveRaw, ...negativeParts] = text.split(/不适用于|不适用/);
  const negative = negativeParts.join(" ");
  return {
    positive: positiveRaw.replace(/仅适用于|只适用于|适用于/g, "").trim(),
    negative: negative.replace(/仅适用于|只适用于|适用于/g, "").trim(),
  };
}

function charGrams(value: string): Map<string, number> {
  const chars = Array.from(value.replace(/\s+/g, ""));
  const grams = new Map<string, number>();
  if (chars.length <= 2) {
    const key = chars.join("");
    grams.set(key, 1);
    return grams;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const gram = `${chars[i]}${chars[i + 1]}`;
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}
