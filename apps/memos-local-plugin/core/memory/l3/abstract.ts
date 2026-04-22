/**
 * Step 2 of the L3 pipeline — **call the LLM abstractor** on a cluster
 * of compatible L2 policies and return a ready-to-persist draft.
 *
 * Pure abstraction logic: no DB writes, no events. The caller decides
 * whether to insert a new WM or merge into an existing one.
 */

import { ERROR_CODES, MemosError } from "../../../agent-contract/errors.js";
import { L3_ABSTRACTION_PROMPT } from "../../llm/prompts/l3-abstraction.js";
import type { LlmClient } from "../../llm/index.js";
import type { Logger } from "../../logger/types.js";
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
    return { ok: false, reason: "llm_disabled" };
  }

  const userPayload = packPrompt(input, config);

  try {
    const rsp = await llm.completeJson<Record<string, unknown>>(
      [
        { role: "system", content: L3_ABSTRACTION_PROMPT.system },
        { role: "user", content: userPayload },
      ],
      {
        op: `${L3_ABSTRACTION_PROMPT.id}.v${L3_ABSTRACTION_PROMPT.version}`,
        temperature: 0.15,
        malformedRetries: 1,
        schemaHint: `{"title":"...","domain_tags":["..."],"environment":[{"label":"...","description":"...","evidenceIds":["..."]}],"inference":[...],"constraints":[...],"body":"markdown","confidence":0..1,"supersedes_world_ids":[]}`,
        validate: (v) => {
          const o = v as Record<string, unknown>;
          if (typeof o.title !== "string" || !(o.title as string).trim()) {
            throw new MemosError(
              ERROR_CODES.LLM_OUTPUT_MALFORMED,
              "l3.abstraction: 'title' must be a non-empty string",
              { got: o.title },
            );
          }
          const triple = ["environment", "inference", "constraints"];
          for (const k of triple) {
            if (!Array.isArray(o[k])) {
              throw new MemosError(
                ERROR_CODES.LLM_OUTPUT_MALFORMED,
                `l3.abstraction: '${k}' must be an array`,
                { got: o[k] },
              );
            }
          }
        },
      },
    );

    const draft = normaliseDraft(rsp.value);
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
    confidence: clamp01(args.draft.confidence ?? 0.5),
    policyIds: args.cluster.policies.map((p) => p.id),
    sourceEpisodeIds: Array.from(new Set(args.episodeIds)),
    inducedBy: args.inducedBy,
    vec: (args.cluster.centroidVec ?? null) as EmbeddingVector | null,
    createdAt: now,
    updatedAt: now,
    status: "active",
  };
}

// ─── Prompt packing ─────────────────────────────────────────────────────────

function packPrompt(
  input: AbstractInput,
  cfg: AbstractDeps["config"],
): string {
  const { cluster, evidenceByPolicy } = input;
  const header = [
    `CLUSTER_KEY: ${cluster.key}`,
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
  return {
    title: String(value.title ?? "").trim(),
    domainTags: normaliseTags(value.domain_tags),
    environment: triple.environment,
    inference: triple.inference,
    constraints: triple.constraints,
    body: typeof value.body === "string" ? (value.body as string).trim() : "",
    confidence: clamp01(typeof value.confidence === "number" ? value.confidence : 0.5),
    supersedesWorldIds: Array.isArray(value.supersedes_world_ids)
      ? (value.supersedes_world_ids as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s as WorldModelId)
      : [],
  };
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
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r): L3AbstractionDraftEntry | null => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const label = typeof o.label === "string" ? (o.label as string).trim() : "";
      const description = typeof o.description === "string" ? (o.description as string).trim() : "";
      if (!label && !description) return null;
      const evidenceIds = Array.isArray(o.evidenceIds)
        ? (o.evidenceIds as unknown[]).filter((s): s is string => typeof s === "string")
        : undefined;
      return { label, description, evidenceIds };
    })
    .filter((e): e is L3AbstractionDraftEntry => e !== null)
    .slice(0, 16);
}

function buildBody(draft: L3AbstractionDraft): string {
  if (draft.body && draft.body.length > 0) return draft.body;
  const lines: string[] = [`# ${draft.title}`, ""];
  if (draft.environment.length > 0) {
    lines.push("## Environment (ℰ)");
    for (const e of draft.environment) lines.push(`- **${e.label}** — ${e.description}`);
    lines.push("");
  }
  if (draft.inference.length > 0) {
    lines.push("## Inference rules (ℐ)");
    for (const e of draft.inference) lines.push(`- **${e.label}** — ${e.description}`);
    lines.push("");
  }
  if (draft.constraints.length > 0) {
    lines.push("## Constraints (C)");
    for (const e of draft.constraints) lines.push(`- **${e.label}** — ${e.description}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function normaliseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return dedupeStrings(
    (raw as unknown[])
      .filter((s): s is string => typeof s === "string")
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
