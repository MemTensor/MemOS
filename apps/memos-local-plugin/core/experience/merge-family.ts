import type { PolicyRow } from "../types.js";

export type MergeFamily = NonNullable<PolicyRow["mergeFamily"]>;

export function deriveMergeFamily(input: Pick<PolicyRow, "experienceType" | "evidencePolarity" | "inducedBy">): MergeFamily {
  if (input.inducedBy.startsWith("l2.induction")) return "success_induction";
  if (input.experienceType === "failure_avoidance" || input.evidencePolarity === "negative") {
    return "failure_avoidance";
  }
  return "failure_corrective";
}
