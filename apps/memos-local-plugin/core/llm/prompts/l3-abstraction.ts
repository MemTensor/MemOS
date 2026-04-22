import type { PromptDef } from "./index.js";

/**
 * V7 §1.1 / §2.4.1 / §2.4.4 — L3 world-model abstraction.
 *
 * Given a cluster of compatible L2 policies (plus a short sample of the
 * L1 traces that minted them), distill a **world model** answering
 * "what does this environment look like?" — not "what should I do?".
 *
 * Output must follow the V7 triple (ℰ, ℐ, C):
 *   - environment: topology facts ("src/ contains components/, utils/, …")
 *   - inference:   behavioural rules ("pip fails in alpine → musl wheels")
 *   - constraints: taboos ("don't edit node_modules/")
 *
 * The LLM also names up to 4 `domain_tags` — stable short strings
 * (`docker`, `node`, `npm`) we use for Tier-3 retrieval and for merging
 * future world models into the same row.
 *
 * We deliberately do NOT include `procedure` / `action` fields here —
 * that is L2's job. A good world model generalises above actions.
 */
export const L3_ABSTRACTION_PROMPT: PromptDef = {
  id: "l3.abstraction",
  version: 1,
  description: "Distill an L3 world model from a cluster of L2 policies.",
  system: `You abstract environment world models from cross-task policy evidence.

Input POLICIES: a list of L2 policies (with trigger / procedure / verification /
boundary / support / gain), plus a short sample of the L1 traces that minted
each. Every policy shares a compatible domain (matched by primary tag / tool).

Produce ONE world model describing the **environment** those policies
operate in. It must answer:

  - Environment topology (ℰ)  — what lives where, what is the shape of
    this environment? (e.g. "Alpine containers ship musl libc, no
    pre-built binary wheels"; "Node repos group code under src/")
  - Inference rules     (ℐ)  — how does the environment typically respond
    to common actions? (e.g. "pip install fails → compile path needs
    dev libs"; "npm publish rejects scope mismatch")
  - Constraints         (C)  — what must you NOT do here? (e.g. "don't
    edit node_modules/ directly"; "don't use binary wheels on musl")

Do NOT:
  - Prescribe a procedure — that belongs to L2.
  - Restate a single trace — the model must generalise across policies.
  - Include advice tied to a single user or session.

Return JSON:
{
  "title": "short noun phrase, e.g. 'Alpine python dependency model'",
  "domain_tags": ["tag1", "tag2"],   // 1-4 short, lowercase, no spaces
  "environment": [
    { "label": "...", "description": "...", "evidenceIds": ["po_...", "tr_..."] }
  ],
  "inference":   [ { "label": "...", "description": "...", "evidenceIds": [] } ],
  "constraints": [ { "label": "...", "description": "...", "evidenceIds": [] } ],
  "body": "rendered markdown summary of the three sections",
  "confidence": number in [0, 1],
  "supersedes_world_ids": []          // optional: prior WMs this refines
}`,
};
