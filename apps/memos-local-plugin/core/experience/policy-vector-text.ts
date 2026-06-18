import type { PolicyRow } from "../types.js";

export function buildPolicyVectorText(
  policy: Pick<PolicyRow, "title" | "trigger">,
): string {
  return [policy.title, policy.trigger].map((s) => s.trim()).filter(Boolean).join("\n") || "(empty)";
}
