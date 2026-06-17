import type { EpisodeId, FeedbackId, PolicyRow, TraceId } from "../types.js";

export function mergeEvidencePolarity(
  a: PolicyRow["evidencePolarity"],
  b: PolicyRow["evidencePolarity"],
): NonNullable<PolicyRow["evidencePolarity"]> {
  const aa = a ?? "positive";
  const bb = b ?? "positive";
  if (aa === bb) return aa;
  if (aa === "mixed" || bb === "mixed") return "mixed";
  if (aa === "neutral") return bb;
  if (bb === "neutral") return aa;
  return "mixed";
}

export function mergeIds<T extends EpisodeId | FeedbackId | TraceId>(
  a: readonly T[] | undefined,
  b: readonly T[] | undefined,
): T[] {
  return Array.from(new Set([...(a ?? []), ...(b ?? [])]));
}

export function dedupeLines(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = trimmed.normalize("NFKC").toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export function mergeSkillEligible(
  existing: PolicyRow["skillEligible"],
  incoming: PolicyRow["skillEligible"],
): boolean {
  return existing !== false || incoming === true;
}
