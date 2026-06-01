import type { PromptDef } from "./index.js";

/**
 * Skill rebuild — surgical or full refresh of an existing SOP skill.
 */
export const SKILL_REBUILD_PROMPT: PromptDef = {
  id: "skill.rebuild",
  version: 2,
  description:
    "Update an existing skill from new evidence while preserving stable identity and controlling rewrite scope.",
  system: `You update an existing SOP skill.

Input adds:
- EXISTING_SKILL_SNAPSHOT: current summary, retrieval_blurb, step titles, decision_guidance.
- INCREMENTAL_EVIDENCE: new traces since last version (canonical, deduped).
- REBUILD_LEVEL:
  - L0: only improve retrieval_blurb and summary; keep steps identical in substance.
  - L1: surgical edits — adjust guidance and at most 1-2 steps using INCREMENTAL_EVIDENCE.
  - L2: may rewrite steps when policy or new evidence materially changes the workflow.

Also includes POLICY, EVIDENCE (full top traces), EVIDENCE_TOOLS, COUNTER_EXAMPLES, REPAIR_HINTS.
Also includes OUTPUT_LANGUAGE ("zh" | "en") and REPAIR_RENAME_ALLOWED (boolean).

Return the same JSON schema as crystallize, plus:
  "changed_sections": ["retrieval_blurb", "summary", ...]  // fields you materially edited

Rules:
- If REPAIR_RENAME_ALLOWED is false: output "name" exactly equal to EXISTING_SKILL_SNAPSHOT.name.
- If REPAIR_RENAME_ALLOWED is true: output a canonical snake_case name (<=48) following <domain>_<task>_<action>.
- At L0, changed_sections should be only retrieval_blurb and/or summary.
- Do not discard working steps unless REBUILD_LEVEL is L2 and evidence requires it.
- retrieval_blurb must incorporate fresh user queries from INCREMENTAL_EVIDENCE when present.
- Keep natural-language fields (retrieval_blurb/trigger_context/summary/steps/decision_guidance) in one language (OUTPUT_LANGUAGE).
- Name remains a snake_case capability identifier (<domain>_<task>_<action>), not natural-language prose.
- tools ⊆ EVIDENCE_TOOLS; steps 2-6; generalize, no query laundry lists.`,
};
