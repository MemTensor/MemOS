import type { Logger } from "../logger/types.js";
import type { LlmClient } from "../llm/index.js";
import {
  detectDominantLanguage,
  languageSteeringLine,
} from "../llm/prompts/index.js";
import { FAILURE_EXPERIENCE_SINK_PROMPT } from "../llm/prompts/failure-experience-sink.js";
import { ids } from "../id.js";
import { deriveMergeFamily } from "./merge-family.js";
import type {
  EpisodeId,
  FeedbackId,
  FeedbackRow,
  PolicyId,
  PolicyRow,
  TraceRow,
} from "../types.js";
import type { Repos } from "../storage/repos/index.js";
import { buildCorrectiveSignalsForSink } from "./corrective-signals.js";
import { buildPolicyVectorText } from "./policy-vector-text.js";

export interface RunL2FailureInput {
  episodeId: EpisodeId;
  sessionId: TraceRow["sessionId"];
  traces: readonly TraceRow[];
  /** When omitted, loaded from `feedback.getForEpisode` in `runL2Failure`. */
  feedbacks?: readonly FeedbackRow[];
}

export interface RunL2FailureDeps {
  repos: Pick<Repos, "policies" | "feedback" | "embeddingRetryQueue">;
  llm: LlmClient | null;
  log: Logger;
  now?: () => number;
}

export interface RunL2FailureResult {
  created: boolean;
  policyId?: PolicyId;
  skippedReason?: string;
}

export async function runL2Failure(
  input: RunL2FailureInput,
  deps: RunL2FailureDeps,
): Promise<RunL2FailureResult> {
  if (!deps.llm) return { created: false, skippedReason: "llm_disabled" };
  if (input.traces.length === 0) return { created: false, skippedReason: "no_traces" };
  const now = deps.now?.() ?? Date.now();
  const feedbacks =
    input.feedbacks ?? deps.repos.feedback.getForEpisode(input.episodeId);
  const payload = buildSinkInput(input, feedbacks);
  const lang = detectDominantLanguage(
    input.traces.flatMap((t) => [t.userText, t.agentText]),
  );
  try {
    const rsp = await deps.llm.completeJson<{
      title: unknown;
      trigger: unknown;
      procedure: unknown;
      verification?: unknown;
      boundary?: unknown;
      experience_type?: unknown;
      decision_guidance?: unknown;
      support_trace_ids?: unknown;
    }>(
      [
        { role: "system", content: FAILURE_EXPERIENCE_SINK_PROMPT.system },
        { role: "system", content: languageSteeringLine(lang) },
        { role: "user", content: JSON.stringify(payload) },
      ],
      {
        op: `l2.${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`,
        phase: "l2",
        episodeId: input.episodeId,
        temperature: 0.1,
        malformedRetries: 1,
      },
    );
    const norm = normalizeOutput(rsp.value, input.traces);
    if (!hasActionableGuidance(norm.decisionGuidance)) {
      return { created: false, skippedReason: "empty_guidance" };
    }
    const sourceFeedbackIds = feedbacks.map((f) => f.id);
    const policyId = ids.policy() as PolicyId;
    const evidencePolarity = deriveEvidencePolarity(norm.decisionGuidance);
    const row: PolicyRow = {
      id: policyId,
      ownerAgentKind: input.traces[0]?.ownerAgentKind ?? "unknown",
      ownerProfileId: input.traces[0]?.ownerProfileId ?? "default",
      ownerWorkspaceId: input.traces[0]?.ownerWorkspaceId ?? null,
      title: norm.title,
      trigger: norm.trigger,
      procedure: norm.procedure,
      verification: norm.verification,
      boundary: norm.boundary,
      support: 1,
      gain: 0.02,
      status: "candidate",
      experienceType: norm.experienceType,
      evidencePolarity,
      sourceEpisodeIds: [input.episodeId],
      sourceTraceIds: norm.supportTraceIds,
      sourceFeedbackIds:
        sourceFeedbackIds.length > 0
          ? sourceFeedbackIds
          : [`f:sink:${input.episodeId}` as FeedbackId],
      inducedBy: `${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`,
      mergeFamily: deriveMergeFamily({
        experienceType: norm.experienceType,
        evidencePolarity,
        inducedBy: `${FAILURE_EXPERIENCE_SINK_PROMPT.id}.v${FAILURE_EXPERIENCE_SINK_PROMPT.version}`,
      }),
      decisionGuidance: norm.decisionGuidance,
      skillEligible: false,
      createdAt: now,
      updatedAt: now,
      vec: null,
    };
    deps.repos.policies.insert(row);
    deps.repos.embeddingRetryQueue.enqueue({
      id: `er_${ids.span()}`,
      targetKind: "policy",
      targetId: policyId,
      vectorField: "vec",
      sourceText: buildPolicyVectorText(row),
      now,
    });
    return { created: true, policyId };
  } catch (err) {
    deps.log.warn("l2.failure_sink.failed", {
      episodeId: input.episodeId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { created: false, skippedReason: "llm_failed" };
  }
}

function buildSinkInput(
  input: RunL2FailureInput,
  feedbacks: readonly FeedbackRow[],
): Record<string, unknown> {
  const ordered = [...input.traces].sort((a, b) => a.ts - b.ts);
  const userGoal = ordered.find((t) => t.userText.trim().length > 0)?.userText ?? "";
  const chunks = ordered.slice(-5).map((t) => ({
    trace_id: t.id,
    turn_id: t.turnId,
    trace_ts: t.ts,
    user: trim(t.userText, 300),
    agent: trim(t.agentText, 500),
    tools: (t.toolCalls ?? []).slice(0, 3).map((tool) => ({
      name: tool.name,
      output: trim(safeStringify(tool.output), 240),
      error_code: tool.errorCode ?? null,
    })),
  }));
  const anchored = buildCorrectiveSignalsForSink(
    input.episodeId,
    input.traces,
    feedbacks,
  );
  return {
    episode_id: input.episodeId,
    session_id: input.sessionId,
    task_context: {
      user_goal: trim(userGoal, 500),
    },
    phase_chunks: chunks,
    episode_timeline: anchored.episode_timeline,
    corrective_signals: anchored.corrective_signals,
  };
}

function normalizeOutput(
  value: Record<string, unknown>,
  traces: readonly TraceRow[],
): {
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  experienceType: NonNullable<PolicyRow["experienceType"]>;
  decisionGuidance: PolicyRow["decisionGuidance"];
  supportTraceIds: string[];
} {
  const guidance = normalizeGuidance(value.decision_guidance);
  const experienceType =
    value.experience_type === "failure_avoidance"
      ? "failure_avoidance"
      : "repair_instruction";
  const supportTraceIds = Array.isArray(value.support_trace_ids)
    ? (value.support_trace_ids as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  return {
    title: trim(asText(value.title) || "Failure sink policy", 120),
    trigger: asText(value.trigger) || "失败场景触发",
    procedure: asText(value.procedure) || "分析失败原因并执行最小修复步骤",
    verification: asText(value.verification) || "重跑关键步骤确认失败不再出现",
    boundary: asText(value.boundary) || "",
    experienceType,
    decisionGuidance: guidance,
    supportTraceIds: supportTraceIds.length > 0 ? supportTraceIds : traces.map((t) => t.id),
  };
}

function normalizeGuidance(raw: unknown): PolicyRow["decisionGuidance"] {
  if (!raw || typeof raw !== "object") return { preference: [], antiPattern: [] };
  const record = raw as Record<string, unknown>;
  const prefer = normalizeStringList(record.prefer);
  const avoid = normalizeStringList(record.avoid);
  return {
    preference: prefer,
    antiPattern: avoid,
  };
}

function deriveEvidencePolarity(
  decisionGuidance: PolicyRow["decisionGuidance"] | null | undefined,
): NonNullable<PolicyRow["evidencePolarity"]> {
  const preferenceCount = decisionGuidance?.preference?.length ?? 0;
  const antiPatternCount = decisionGuidance?.antiPattern?.length ?? 0;
  if (preferenceCount > 0 && antiPatternCount > 0) return "mixed";
  if (preferenceCount > 0) return "positive";
  if (antiPatternCount > 0) return "negative";
  return "negative";
}

function hasActionableGuidance(
  decisionGuidance: PolicyRow["decisionGuidance"] | null | undefined,
): boolean {
  const preferenceCount = decisionGuidance?.preference?.length ?? 0;
  const antiPatternCount = decisionGuidance?.antiPattern?.length ?? 0;
  return preferenceCount > 0 || antiPatternCount > 0;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
