/**
 * Step 2 of the L3 pipeline — **call the LLM abstractor** on a cluster
 * of compatible L2 policies and return a ready-to-persist draft.
 *
 * Pure abstraction logic: no DB writes, no events. The caller decides
 * whether to insert a new WM or merge into an existing one.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import {
  detectDominantLanguage,
  languageSteeringLine,
} from "../../llm/prompts/index.js";
import { L3_ABSTRACTION_PROMPT } from "../../llm/prompts/l3-abstraction.js";
import type { LlmClient } from "../../llm/index.js";
import type { Logger } from "../../logger/types.js";
import { sanitizeDerivedMarkdown, sanitizeDerivedText } from "../../safety/content.js";
import type {
  EmbeddingVector,
  EpisodeId,
  PolicyId,
  PolicyRow,
  TraceRow,
  WorldModelId,
  WorldModelRow,
} from "../../types.js";
import { ids } from "../../id.js";
import type {
  L3AbstractionDraft,
  L3AbstractionDraftEntry,
  L3AbstractionDraftResult,
  L3Config,
  PolicyCluster,
} from "./types.js";

export interface AbstractInput {
  cluster: PolicyCluster;
  /** Evidence traces per policy id (caller resolves these via traces repo). */
  evidenceByPolicy: Map<PolicyId, readonly TraceRow[]>;
  /**
   * Episode that triggered this L3 run, when known. Forwarded to the
   * LLM call so the resulting `system_model_status` audit row can be
   * grouped with the rest of that episode's pipeline activity in the
   * Logs viewer.
   */
  episodeId?: EpisodeId;
}

export interface AbstractDeps {
  llm: LlmClient | null;
  log: Logger;
  config: Pick<L3Config, "policyCharCap" | "traceCharCap" | "traceEvidencePerPolicy" | "useLlm">;
  /** Optional extra validation executed after the base validator. */
  validate?: (d: L3AbstractionDraft) => void;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function abstractDraft(
  input: AbstractInput,
  deps: AbstractDeps,
): Promise<L3AbstractionDraftResult> {
  const { llm, log, config } = deps;
  if (!config.useLlm || !llm) {
    const reason = !config.useLlm
      ? "useLlm disabled in config"
      : "llm client is null (provider not attached?)";
    log.warn("l3.abstract.llm_unavailable", {
      clusterPolicies: input.cluster.policies.length,
      reason,
      fallback: "skipped",
    });
    return { ok: false, reason: "llm_disabled" };
  }

  const userPayload = packPrompt(input, config);

  // Pick the world-model's rendering language from the underlying
  // policies + trace evidence. A Chinese user generating "docker alpine
  // 依赖" policies should see the environment/inference/constraint bullets
  // written in Chinese; an English user should see them in English.
  const langSamples: Array<string | null | undefined> = [];
  for (const p of input.cluster.policies) {
    langSamples.push(p.title, p.trigger, p.procedure, p.boundary, p.verification);
  }
  for (const traces of input.evidenceByPolicy.values()) {
    for (const t of traces) langSamples.push(t.userText, t.agentText, t.reflection);
  }
  const evidenceLang = detectDominantLanguage(langSamples);

  try {
    // We deliberately do *not* pass an inline `validate` to `completeJson`
    // here. The LLM commonly returns *partially* structured drafts on
    // smaller / non-strict providers (e.g. empty `title`, `inference` /
    // `constraints` returned as strings or `{body}` shapes, comma-joined
    // `domain_tags`). Our `normaliseDraft` below salvages those shapes
    // into a `L3AbstractionDraft`. After normalization we run a *soft*
    // floor check: only if even the salvaged draft is empty (no triple
    // facets, no body, no domain tags) do we treat the response as
    // unusable. Downstream validators still get the final say on whether
    // the salvaged draft is good enough to persist.
    const rsp = await llm.completeJson<Record<string, unknown>>(
      [
        { role: "system", content: L3_ABSTRACTION_PROMPT.system },
        { role: "system", content: languageSteeringLine(evidenceLang) },
        { role: "user", content: userPayload },
      ],
      {
        op: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
        phase: "l3",
        episodeId: input.episodeId,
        temperature: 0.15,
        malformedRetries: 1,
        schemaHint: `{"title":"...","domain_tags":["..."],"environment":[{"label":"...","description":"...","evidenceIds":["..."]}],"inference":[...],"constraints":[...],"body":"markdown","confidence":0..1,"supersedes_world_ids":[]}`,
      },
    );

    const draft = normaliseDraft(rsp.value);
    assertDraftMinimallyUsable(draft, rsp.value);
    if (draftWasSalvaged(draft, rsp.value)) {
      log.info("l3.abstract.draft_salvaged", {
        clusterKey: input.cluster.key,
        rawTitleType: typeof (rsp.value as Record<string, unknown>).title,
        rawTitleEmpty:
          typeof (rsp.value as Record<string, unknown>).title !== "string" ||
          !((rsp.value as Record<string, unknown>).title as string).trim(),
        rawTagsType: Array.isArray((rsp.value as Record<string, unknown>).domain_tags)
          ? "array"
          : typeof (rsp.value as Record<string, unknown>).domain_tags,
        environmentRawType: Array.isArray((rsp.value as Record<string, unknown>).environment)
          ? "array"
          : typeof (rsp.value as Record<string, unknown>).environment,
        inferenceRawType: Array.isArray((rsp.value as Record<string, unknown>).inference)
          ? "array"
          : typeof (rsp.value as Record<string, unknown>).inference,
        constraintsRawType: Array.isArray((rsp.value as Record<string, unknown>).constraints)
          ? "array"
          : typeof (rsp.value as Record<string, unknown>).constraints,
      });
    }
    if (deps.validate) deps.validate(draft);
    return { ok: true, draft };
  } catch (err) {
    log.warn("abstract.llm_failed", {
      clusterKey: input.cluster.key,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: "llm_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Convert a draft → WorldModelRow ────────────────────────────────────────

export function buildWorldModelRow(args: {
  draft: L3AbstractionDraft;
  cluster: PolicyCluster;
  episodeIds: readonly EpisodeId[];
  inducedBy: string;
  now?: number;
  id?: WorldModelId;
}): WorldModelRow {
  const now = args.now ?? Date.now();
  const domainTags = dedupeStrings(
    args.draft.domainTags.length > 0 ? args.draft.domainTags : args.cluster.domainTags,
  ).slice(0, 6);

  // Cohesion-aware confidence shaping. The LLM proposes a `draft.confidence`
  // based on how well its three facets (ℰ / ℐ / 𝒞) cover the evidence; we
  // additionally dampen `loose` clusters proportionally to how spread out
  // their members are in embedding space. Two policies that ended up in the
  // same domain bucket but pull in opposite directions (cohesion ≈ 0.2)
  // shouldn't claim the same retrieval-time confidence as a tight cluster
  // (cohesion ≈ 0.9). The shrinkage is intentionally gentle (down to 0.6×
  // for cohesion=0) so we still surface loose-but-real clusters in
  // Tier-3, just below tighter ones.
  const baseConfidence = clamp01(args.draft.confidence ?? 0.5);
  const cohesionFactor =
    args.cluster.admission === "loose"
      ? 0.6 + 0.4 * clamp01(args.cluster.cohesion)
      : 1.0;
  const confidence = clamp01(baseConfidence * cohesionFactor);

  return {
    id: (args.id ?? (ids.world() as WorldModelId)),
    title: args.draft.title.slice(0, 160),
    body: buildBody(args.draft),
    structure: {
      environment: args.draft.environment,
      inference: args.draft.inference,
      constraints: args.draft.constraints,
    },
    domainTags,
    confidence,
    policyIds: args.cluster.policies.map((p) => p.id),
    sourceEpisodeIds: Array.from(new Set(args.episodeIds)),
    inducedBy: args.inducedBy,
    vec: (args.cluster.centroidVec ?? null) as EmbeddingVector | null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    status: "active",
  };
}

// ─── Prompt packing ─────────────────────────────────────────────────────────

function packPrompt(
  input: AbstractInput,
  cfg: AbstractDeps["config"],
): string {
  const { cluster, evidenceByPolicy } = input;
  // ADMISSION:
  //   strict = every member is within `clusterMinSimilarity` of the centroid.
  //            The world model can confidently describe a single coherent
  //            sub-problem family.
  //   loose  = members share a domain key but their titles/triggers spread
  //            wider in embedding space. The world model should describe the
  //            shared *project / environment*, not a single sub-problem;
  //            facets (ℰ/ℐ/𝒞) should be broader and less prescriptive.
  const cohesionStr = cluster.cohesion.toFixed(2);
  const header = [
    `CLUSTER_KEY: ${cluster.key}`,
    `ADMISSION: ${cluster.admission} (cohesion=${cohesionStr})`,
    `DOMAIN_TAGS: ${cluster.domainTags.join(", ") || "-"}`,
    `POLICIES (${cluster.policies.length}):`,
  ].join("\n");

  const policyBlocks = cluster.policies.map((p) => packPolicy(p, evidenceByPolicy.get(p.id) ?? [], cfg));
  return `${header}\n\n${policyBlocks.join("\n\n")}`;
}

function packPolicy(
  policy: PolicyRow,
  traces: readonly TraceRow[],
  cfg: AbstractDeps["config"],
): string {
  const body = truncate(
    [
      `id: ${policy.id}`,
      `title: ${policy.title}`,
      `trigger: ${policy.trigger}`,
      `procedure: ${policy.procedure}`,
      `verification: ${policy.verification}`,
      `boundary: ${policy.boundary}`,
      `support: ${policy.support}  gain: ${policy.gain.toFixed(2)}  status: ${policy.status}`,
    ].join("\n"),
    cfg.policyCharCap,
  );

  if (cfg.traceEvidencePerPolicy <= 0 || traces.length === 0) return body;
  const sample = traces.slice(0, cfg.traceEvidencePerPolicy);
  const traceBlocks = sample.map((t) =>
    truncate(
      [
        `  trace ${t.id} (V=${t.value.toFixed(2)}):`,
        `  tags: ${(t.tags ?? []).join(",") || "-"}`,
        `  user: ${truncate(t.userText, 160)}`,
        `  agent: ${truncate(t.agentText, 240)}`,
        `  reflection: ${truncate(t.reflection ?? "-", 200)}`,
      ].join("\n"),
      cfg.traceCharCap,
    ),
  );
  return `${body}\n\nEVIDENCE_TRACES:\n${traceBlocks.join("\n\n")}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normaliseDraft(value: Record<string, unknown>): L3AbstractionDraft {
  const triple = pickTriple(value);
  const body = typeof value.body === "string" ? sanitizeDerivedMarkdown(value.body) : "";
  const domainTags = normaliseTags(value.domain_tags);
  const title = deriveTitle(value.title, {
    environment: triple.environment,
    inference: triple.inference,
    constraints: triple.constraints,
    body,
    domainTags,
  });
  return {
    title,
    domainTags,
    environment: triple.environment,
    inference: triple.inference,
    constraints: triple.constraints,
    body,
    confidence: clamp01(typeof value.confidence === "number" ? value.confidence : 0.5),
    supersedesWorldIds: Array.isArray(value.supersedes_world_ids)
      ? (value.supersedes_world_ids as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s as WorldModelId)
      : [],
  };
}

/**
 * Derive a usable title when the LLM returned an empty / non-string one.
 * Order of preference:
 *   1. The cleaned LLM-provided title.
 *   2. The first inference / environment / constraints entry's label or
 *      description (whichever is non-empty), trimmed to ~80 chars.
 *   3. The first non-empty markdown line of `body`, with leading
 *      heading/list prefixes (`#`, `-`, `*`, `+`, `1.`) stripped, trimmed.
 *   4. A domain-tag joined fallback like `"docker, alpine, pip"`.
 *   5. Empty string — caller (`assertDraftMinimallyUsable`) will reject if
 *      the rest of the draft is also empty.
 */
function deriveTitle(
  raw: unknown,
  ctx: {
    environment: L3AbstractionDraftEntry[];
    inference: L3AbstractionDraftEntry[];
    constraints: L3AbstractionDraftEntry[];
    body: string;
    domainTags: string[];
  },
): string {
  const cleaned = sanitizeDerivedText(raw);
  if (cleaned) return cleaned;

  const firstEntryText = (entries: L3AbstractionDraftEntry[]): string => {
    for (const e of entries) {
      const candidate = e.label || stripMarkdownToText(e.description);
      if (candidate) return candidate;
    }
    return "";
  };
  const fromInference = firstEntryText(ctx.inference);
  if (fromInference) return shortenForTitle(fromInference);
  const fromEnvironment = firstEntryText(ctx.environment);
  if (fromEnvironment) return shortenForTitle(fromEnvironment);
  const fromConstraints = firstEntryText(ctx.constraints);
  if (fromConstraints) return shortenForTitle(fromConstraints);

  if (ctx.body) {
    for (const line of ctx.body.split(/\r?\n/)) {
      const stripped = line.replace(/^\s*(?:#+\s+|[-*+]\s+|\d+\.\s+)/, "").trim();
      if (stripped) return shortenForTitle(stripMarkdownToText(stripped));
    }
  }
  if (ctx.domainTags.length > 0) {
    return shortenForTitle(ctx.domainTags.join(", "));
  }
  return "";
}

function stripMarkdownToText(s: string): string {
  return s
    .replace(/[`*_~]+/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function shortenForTitle(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= 80) return flat;
  return flat.slice(0, 79) + "…";
}

/**
 * Ensure the salvaged draft has *something* worth persisting. We accept a
 * draft as long as it has at least one of:
 *   - a non-empty title (post-derivation),
 *   - any triple facet entry,
 *   - a non-empty body,
 *   - at least one domain tag.
 *
 * This keeps the parser permissive while preventing fully empty drafts
 * (which downstream code would happily index as garbage) from sneaking
 * through. Downstream validators still apply stricter checks.
 */
function assertDraftMinimallyUsable(
  draft: L3AbstractionDraft,
  raw: Record<string, unknown>,
): void {
  const hasTitle = draft.title.trim().length > 0;
  const hasTripleEntry =
    draft.environment.length > 0 ||
    draft.inference.length > 0 ||
    draft.constraints.length > 0;
  const hasBody = draft.body.trim().length > 0;
  const hasTags = draft.domainTags.length > 0;
  if (hasTitle || hasTripleEntry || hasBody || hasTags) return;
  throw new MemosError(
    ERROR_CODES.LLM_OUTPUT_MALFORMED,
    "l3.abstraction: draft is empty after normalization",
    {
      rawKeys: Object.keys(raw),
      title: raw.title,
      environment: Array.isArray(raw.environment) ? raw.environment.length : typeof raw.environment,
      inference: Array.isArray(raw.inference) ? raw.inference.length : typeof raw.inference,
      constraints: Array.isArray(raw.constraints)
        ? raw.constraints.length
        : typeof raw.constraints,
    },
  );
}

/**
 * True iff `normaliseDraft` had to coerce the raw payload — useful for
 * an `info` log so operators can see when the parser is salvaging vs.
 * accepting clean drafts.
 */
function draftWasSalvaged(
  draft: L3AbstractionDraft,
  raw: Record<string, unknown>,
): boolean {
  const rawTitleEmpty =
    typeof raw.title !== "string" || !raw.title.trim();
  if (rawTitleEmpty && draft.title) return true;
  const tripleKeys = ["environment", "inference", "constraints"] as const;
  for (const k of tripleKeys) {
    if (!Array.isArray(raw[k])) {
      // Anything non-array on the wire that we still produced entries for
      // (or even legitimately empty arrays for) counts as salvaged.
      return true;
    }
    for (const entry of raw[k] as unknown[]) {
      if (typeof entry === "string") return true;
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        // Drafts that only used `body` instead of `description`, or that
        // omitted `label` entirely, were salvaged into the canonical
        // `{label, description}` shape.
        const hasCanonicalLabel = typeof o.label === "string";
        const hasCanonicalDescription = typeof o.description === "string";
        if (!hasCanonicalLabel || !hasCanonicalDescription) return true;
      }
    }
  }
  // String / non-array `domain_tags` that we still produced tags for.
  if (!Array.isArray(raw.domain_tags) && draft.domainTags.length > 0) return true;
  return false;
}

function pickTriple(value: Record<string, unknown>): {
  environment: L3AbstractionDraftEntry[];
  inference: L3AbstractionDraftEntry[];
  constraints: L3AbstractionDraftEntry[];
} {
  return {
    environment: toEntries(value.environment),
    inference: toEntries(value.inference),
    constraints: toEntries(value.constraints),
  };
}

function toEntries(raw: unknown): L3AbstractionDraftEntry[] {
  // Accept the canonical array shape, but also salvage common LLM mistakes:
  //   - whole field returned as a single string -> treat as one entry's body
  //   - whole field returned as a single object -> wrap in an array
  //   - per-entry strings -> treat as the entry's `description`
  //   - per-entry objects using `body` / `text` / `content` instead of
  //     `description`, or `name` / `title` instead of `label`
  let arr: unknown[];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    const cleaned = raw.trim();
    arr = cleaned ? [cleaned] : [];
  } else if (raw && typeof raw === "object") {
    arr = [raw];
  } else {
    return [];
  }

  return arr
    .map((r): L3AbstractionDraftEntry | null => coerceEntry(r))
    .filter((e): e is L3AbstractionDraftEntry => e !== null)
    .slice(0, 16);
}

function coerceEntry(r: unknown): L3AbstractionDraftEntry | null {
  if (typeof r === "string") {
    const description = sanitizeDerivedMarkdown(r);
    if (!description) return null;
    return { label: "", description };
  }
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;

  const labelRaw = firstString(o.label, o.name, o.title, o.heading, o.key);
  const descriptionRaw = firstString(
    o.description,
    o.body,
    o.text,
    o.content,
    o.detail,
    o.summary,
    o.value,
  );

  const label = labelRaw ? sanitizeDerivedText(labelRaw) : "";
  const description = descriptionRaw ? sanitizeDerivedMarkdown(descriptionRaw) : "";
  if (!label && !description) return null;

  const evidenceIds = collectEvidenceIds(o);
  return evidenceIds ? { label, description, evidenceIds } : { label, description };
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c;
  }
  return undefined;
}

function collectEvidenceIds(o: Record<string, unknown>): string[] | undefined {
  const raw = o.evidenceIds ?? o.evidence_ids ?? o.evidence;
  if (Array.isArray(raw)) {
    const ids = (raw as unknown[])
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    // Allow `"po_1, po_2"` style strings for forgiving providers.
    const ids = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  return undefined;
}

function buildBody(draft: L3AbstractionDraft): string {
  if (draft.body && draft.body.length > 0) return draft.body;
  const lines: string[] = [`# ${draft.title}`, ""];
  const renderEntry = (e: L3AbstractionDraftEntry): string =>
    e.label ? `- **${e.label}** — ${e.description}` : `- ${e.description}`;
  if (draft.environment.length > 0) {
    lines.push("## Environment (ℰ)");
    for (const e of draft.environment) lines.push(renderEntry(e));
    lines.push("");
  }
  if (draft.inference.length > 0) {
    lines.push("## Inference rules (ℐ)");
    for (const e of draft.inference) lines.push(renderEntry(e));
    lines.push("");
  }
  if (draft.constraints.length > 0) {
    lines.push("## Constraints (C)");
    for (const e of draft.constraints) lines.push(renderEntry(e));
    lines.push("");
  }
  return lines.join("\n").trim();
}

function normaliseTags(raw: unknown): string[] {
  // Canonical shape: array of strings. Also accept comma/semicolon/newline-
  // separated strings (`"docker, alpine, pip"`; whitespace within a tag is
  // preserved so multi-word tags survive) and arrays that mix strings and
  // `{label}` / `{name}` / `{tag}` objects, since some providers return
  // that shape under structured-output mode.
  let candidates: unknown[];
  if (Array.isArray(raw)) {
    candidates = raw as unknown[];
  } else if (typeof raw === "string") {
    candidates = raw.split(/[,;\n]+/);
  } else {
    return [];
  }
  const flat: string[] = [];
  for (const c of candidates) {
    if (typeof c === "string") {
      flat.push(c);
    } else if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const fromObj = firstString(o.label, o.name, o.tag, o.value, o.key);
      if (fromObj) flat.push(fromObj);
    }
  }
  return dedupeStrings(
    flat
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && s.length < 24),
  ).slice(0, 6);
}

function dedupeStrings(arr: readonly string[]): string[] {
  return Array.from(new Set(arr));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
