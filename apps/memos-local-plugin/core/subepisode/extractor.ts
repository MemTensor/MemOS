import type { Embedder } from "../embedding/index.js";
import { ids } from "../id.js";
import type { EmbeddingVector, EpisodeId, EpochMs, SubEpisodeRow, TraceRow } from "../types.js";
import { priorityFor } from "../reward/backprop.js";

const MAX_SPAN_TRACES = 6;
const MIN_LEARNABILITY = 0.45;

export interface BuildSubEpisodesInput {
  episodeId: EpisodeId;
  traces: readonly TraceRow[];
  rHuman: number;
  gamma: number;
  decayHalfLifeDays: number;
  now: EpochMs;
}

export async function buildSubEpisodes(
  input: BuildSubEpisodesInput,
  opts: { embedder?: Embedder | null } = {},
): Promise<SubEpisodeRow[]> {
  const ordered = [...input.traces].sort((a, b) => a.ts - b.ts);
  const spans = candidateSpans(ordered)
    .map(scoreSpan)
    .filter((span) => span.learnabilityScore >= MIN_LEARNABILITY);
  const rows = backpropSubEpisodes(spans.map((span) => rowFromSpan(span, input.now)), input);
  if (opts.embedder && rows.length > 0) {
    const vecs = await embedSummaries(opts.embedder, rows);
    rows.forEach((row, i) => {
      row.vecSummary = vecs[i] ?? null;
    });
  }
  return rows;
}

export interface TraceSubEpisodeScoreUpdate {
  traceId: TraceRow["id"];
  subEpisodeId: SubEpisodeRow["id"] | null;
  value: number;
  alpha: number;
  rHuman: number | null;
  priority: number;
}

export function traceScoreUpdatesFromSubEpisodes(
  traces: readonly TraceRow[],
  subEpisodes: readonly SubEpisodeRow[],
  opts: { rHuman?: number | null } = {},
): TraceSubEpisodeScoreUpdate[] {
  const ownerByTraceId = new Map<TraceRow["id"], SubEpisodeRow>();
  for (const subEpisode of subEpisodes) {
    for (const traceId of subEpisode.traceIds) {
      const current = ownerByTraceId.get(traceId);
      if (!current || betterOwner(subEpisode, current)) {
        ownerByTraceId.set(traceId, subEpisode);
      }
    }
  }

  return traces.map((trace) => {
    const owner = ownerByTraceId.get(trace.id);
    if (!owner) {
      return {
        traceId: trace.id,
        subEpisodeId: null,
        value: 0,
        alpha: 0,
        rHuman: null,
        priority: 0,
      };
    }
    return {
      traceId: trace.id,
      subEpisodeId: owner.id,
      value: owner.value,
      alpha: owner.alpha,
      rHuman: opts.rHuman ?? null,
      priority: owner.priority,
    };
  });
}

interface CandidateSpan {
  traces: TraceRow[];
}

interface ScoredSpan extends CandidateSpan {
  learnabilityScore: number;
  learnabilityReasons: string[];
}

function candidateSpans(traces: readonly TraceRow[]): CandidateSpan[] {
  const spans: CandidateSpan[] = [];
  let current: TraceRow[] = [];
  for (const trace of traces) {
    if (current.length === 0) {
      if (canStart(trace)) current = [trace];
      continue;
    }

    const previous = current[current.length - 1]!;
    const shouldCloseBefore =
      isTaskSwitch(previous, trace) ||
      current.length >= MAX_SPAN_TRACES ||
      (hasClearOutcome(previous) && canStart(trace));
    if (shouldCloseBefore) {
      spans.push({ traces: current });
      current = canStart(trace) ? [trace] : [];
      continue;
    }

    if (isRelated(current, trace)) {
      current.push(trace);
      if (hasClearOutcome(trace) || hasVerification(trace)) {
        spans.push({ traces: current });
        current = [];
      }
    } else {
      spans.push({ traces: current });
      current = canStart(trace) ? [trace] : [];
    }
  }
  if (current.length > 0) spans.push({ traces: current });
  return spans;
}

function scoreSpan(span: CandidateSpan): ScoredSpan {
  const reasons: string[] = [];
  let score = 0;
  if (span.traces.some(hasGoal)) {
    score += 0.2;
    reasons.push("goal");
  }
  if (span.traces.some(hasAction)) {
    score += 0.25;
    reasons.push("action");
  }
  if (span.traces.some(hasObservation)) {
    score += 0.2;
    reasons.push("observation");
  }
  if (span.traces.some((t) => hasClearOutcome(t) || hasVerification(t))) {
    score += 0.2;
    reasons.push("outcome");
  }
  if (transferSignals(span.traces) > 0) {
    score += 0.15;
    reasons.push("transferable");
  }
  if (isNoise(span.traces)) {
    score -= 0.25;
    reasons.push("noise_penalty");
  }
  return {
    ...span,
    learnabilityScore: clamp(score, 0, 1),
    learnabilityReasons: reasons,
  };
}

function rowFromSpan(span: ScoredSpan, now: EpochMs): SubEpisodeRow {
  const traces = span.traces;
  const first = traces[0]!;
  const last = traces[traces.length - 1]!;
  const tags = unique(traces.flatMap((t) => t.tags ?? []));
  const errorSignatures = unique(traces.flatMap((t) => t.errorSignatures ?? []));
  const failureMode = inferFailureMode(traces, errorSignatures);
  const outcome = inferOutcome(traces);
  const verification = inferVerification(traces);
  const actionChain = buildActionChain(traces);
  const observations = buildObservations(traces, errorSignatures);
  const localGoal = inferLocalGoal(traces);
  const summary = renderSummary({
    localGoal,
    outcome,
    failureMode,
    actionChain,
    verification,
  });
  const completeness = completenessFor(span);
  const transferability = clamp(0.25 + transferSignals(traces) * 0.2, 0, 1);
  const alpha = clamp(0.15 + completeness * 0.45 + span.learnabilityScore * 0.35, 0, 1);
  return {
    id: subEpisodeIdFor(first.episodeId, first.id, last.id),
    episodeId: first.episodeId,
    sessionId: first.sessionId,
    ownerAgentKind: first.ownerAgentKind,
    ownerProfileId: first.ownerProfileId,
    ownerWorkspaceId: first.ownerWorkspaceId,
    traceIds: traces.map((t) => t.id),
    startTraceId: first.id,
    endTraceId: last.id,
    startTs: first.ts,
    endTs: last.ts,
    localGoal,
    trigger: inferTrigger(first, failureMode),
    actionChain,
    observations,
    outcome,
    verification,
    failureMode,
    reflection: `局部经验：${summary}`,
    alpha,
    value: 0,
    priority: 0,
    learnabilityScore: span.learnabilityScore,
    learnabilityReasons: span.learnabilityReasons,
    tags,
    errorSignatures,
    completeness,
    transferability,
    meanValue: 0,
    maxValue: 0,
    minValue: 0,
    polarity: "neutral",
    summary,
    vecSummary: null,
    createdAt: now,
    updatedAt: now,
    meta: { extractedBy: "deterministic.v1" },
  };
}

function backpropSubEpisodes(
  rows: SubEpisodeRow[],
  input: Pick<BuildSubEpisodesInput, "rHuman" | "gamma" | "decayHalfLifeDays" | "now">,
): SubEpisodeRow[] {
  let nextV = clamp(input.rHuman, -1, 1);
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const v = i === rows.length - 1
      ? clamp(input.rHuman, -1, 1)
      : row.alpha * input.rHuman + (1 - row.alpha) * input.gamma * nextV;
    row.value = clamp(v, -1, 1);
    row.priority = priorityFor(row.value, row.endTs, input.decayHalfLifeDays, input.now);
    row.meanValue = row.value;
    row.maxValue = row.value;
    row.minValue = row.value;
    row.polarity = row.value > 0.15 ? "positive" : row.value < -0.15 ? "negative" : "neutral";
    row.updatedAt = input.now;
    nextV = row.value;
  }
  return rows;
}

function betterOwner(candidate: SubEpisodeRow, current: SubEpisodeRow): boolean {
  if (candidate.learnabilityScore !== current.learnabilityScore) {
    return candidate.learnabilityScore > current.learnabilityScore;
  }
  if (candidate.priority !== current.priority) {
    return candidate.priority > current.priority;
  }
  return candidate.traceIds.length < current.traceIds.length;
}

async function embedSummaries(embedder: Embedder, rows: readonly SubEpisodeRow[]): Promise<Array<EmbeddingVector | null>> {
  try {
    return await embedder.embedMany(
      rows.map((row) => ({
        role: "document" as const,
        text: subEpisodeEmbeddingText(row),
      })),
    );
  } catch {
    return rows.map(() => null);
  }
}

export function subEpisodeEmbeddingText(row: SubEpisodeRow): string {
  return [
    row.summary,
    `goal: ${row.localGoal}`,
    `trigger: ${row.trigger}`,
    `outcome: ${row.outcome}`,
    `verification: ${row.verification}`,
    `tags: ${row.tags.join(",")}`,
  ].filter(Boolean).join("\n");
}

function canStart(trace: TraceRow): boolean {
  return hasGoal(trace) || hasAction(trace) || hasObservation(trace);
}

function hasGoal(trace: TraceRow): boolean {
  return nonTrivial(trace.userText) || /\b(plan|fix|debug|implement|review|test|verify|解决|修复|实现|检查|验证|计划)\b/i.test(trace.agentText);
}

function hasAction(trace: TraceRow): boolean {
  if ((trace.toolCalls ?? []).length > 0) return true;
  return /\b(read|search|edit|write|run|test|build|install|execute|修改|运行|搜索|读取|写入)\b/i.test(trace.agentText);
}

function hasObservation(trace: TraceRow): boolean {
  if ((trace.errorSignatures ?? []).length > 0) return true;
  return (trace.toolCalls ?? []).some((call) => call.output !== undefined || call.errorCode);
}

function hasClearOutcome(trace: TraceRow): boolean {
  return /\b(done|fixed|passed|failed|resolved|success|cannot|blocked|完成|修复|通过|失败|解决|阻塞)\b/i.test(
    `${trace.agentText}\n${trace.reflection ?? ""}`,
  );
}

function hasVerification(trace: TraceRow): boolean {
  const text = `${trace.agentText}\n${trace.toolCalls.map((c) => c.name).join("\n")}`;
  return /\b(test|build|lint|verify|check|passed|验证|测试|检查|通过)\b/i.test(text);
}

function isRelated(span: readonly TraceRow[], trace: TraceRow): boolean {
  const tags = new Set(span.flatMap((t) => t.tags ?? []));
  if ((trace.tags ?? []).some((tag) => tags.has(tag))) return true;
  const tools = new Set(span.flatMap((t) => (t.toolCalls ?? []).map((call) => call.name)));
  if ((trace.toolCalls ?? []).some((call) => tools.has(call.name))) return true;
  if (span.some((t) => (t.errorSignatures ?? []).some((sig) => (trace.errorSignatures ?? []).includes(sig)))) return true;
  return hasAction(trace) || hasObservation(trace);
}

function isTaskSwitch(previous: TraceRow, next: TraceRow): boolean {
  if (!nonTrivial(next.userText)) return false;
  const prevTags = new Set(previous.tags ?? []);
  const nextTags = next.tags ?? [];
  return prevTags.size > 0 && nextTags.length > 0 && !nextTags.some((tag) => prevTags.has(tag));
}

function isNoise(traces: readonly TraceRow[]): boolean {
  return !traces.some(hasAction) && !traces.some(hasObservation) && traces.every((t) => !nonTrivial(t.userText));
}

function transferSignals(traces: readonly TraceRow[]): number {
  let n = 0;
  if (unique(traces.flatMap((t) => t.tags ?? [])).length > 0) n++;
  if (unique(traces.flatMap((t) => t.errorSignatures ?? [])).length > 0) n++;
  if (unique(traces.flatMap((t) => (t.toolCalls ?? []).map((c) => c.name))).length > 0) n++;
  if (traces.some((t) => /\b(prefer|avoid|always|never|应该|不要|偏好|必须)\b/i.test(`${t.userText}\n${t.agentText}`))) n++;
  return n;
}

function completenessFor(span: ScoredSpan): number {
  const parts = ["goal", "action", "observation", "outcome"].filter((reason) =>
    span.learnabilityReasons.includes(reason),
  ).length;
  return parts / 4;
}

function inferLocalGoal(traces: readonly TraceRow[]): string {
  const user = traces.map((t) => t.userText.trim()).find(nonTrivial);
  if (user) return truncate(oneLine(user), 180);
  return truncate(oneLine(traces[0]?.agentText ?? "局部任务"), 180);
}

function inferTrigger(first: TraceRow, failureMode: string | null): string {
  if (failureMode) return failureMode;
  if (nonTrivial(first.userText)) return truncate(oneLine(first.userText), 180);
  return "agent_action";
}

function inferFailureMode(traces: readonly TraceRow[], errorSignatures: readonly string[]): string | null {
  if (errorSignatures.length > 0) return errorSignatures[0]!;
  for (const trace of traces) {
    for (const call of trace.toolCalls ?? []) {
      if (call.errorCode) return call.errorCode;
      const out = typeof call.output === "string" ? call.output : "";
      const m = out.match(/\b(error|failed|exception|exit\s*code\s*[1-9]\d*)\b[^.\n]*/i);
      if (m) return truncate(oneLine(m[0]), 120);
    }
  }
  return null;
}

function inferOutcome(traces: readonly TraceRow[]): string {
  const text = `${traces.map((t) => t.agentText).join("\n")}\n${traces.map((t) => t.reflection ?? "").join("\n")}`;
  if (/\b(passed|fixed|resolved|success|完成|修复|通过|解决)\b/i.test(text)) return "success";
  if (/\b(failed|blocked|cannot|error|失败|阻塞|无法)\b/i.test(text)) return "failure_or_blocked";
  return "observed";
}

function inferVerification(traces: readonly TraceRow[]): string {
  const hit = traces.find(hasVerification);
  if (!hit) return "";
  return truncate(oneLine(hit.agentText || hit.toolCalls.map((c) => c.name).join("; ")), 180);
}

function buildActionChain(traces: readonly TraceRow[]): string[] {
  const out: string[] = [];
  for (const trace of traces) {
    for (const call of trace.toolCalls ?? []) {
      out.push(`${call.name}(${truncate(safeStringify(call.input), 80)})`);
    }
    if (out.length === 0 && trace.agentText) out.push(truncate(oneLine(trace.agentText), 120));
  }
  return unique(out).slice(0, 8);
}

function buildObservations(traces: readonly TraceRow[], errorSignatures: readonly string[]): string[] {
  const out = [...errorSignatures];
  for (const trace of traces) {
    for (const call of trace.toolCalls ?? []) {
      if (call.errorCode) out.push(call.errorCode);
      if (typeof call.output === "string" && call.output.trim()) {
        out.push(truncate(oneLine(call.output), 160));
      }
    }
  }
  return unique(out).slice(0, 8);
}

function renderSummary(input: {
  localGoal: string;
  outcome: string;
  failureMode: string | null;
  actionChain: readonly string[];
  verification: string;
}): string {
  const parts = [
    `目标: ${input.localGoal}`,
    input.failureMode ? `触发: ${input.failureMode}` : "",
    input.actionChain.length > 0 ? `动作: ${input.actionChain.slice(0, 3).join(" -> ")}` : "",
    `结果: ${input.outcome}`,
    input.verification ? `验证: ${input.verification}` : "",
  ].filter(Boolean);
  return truncate(parts.join("；"), 500);
}

function subEpisodeIdFor(episodeId: EpisodeId, startTraceId: string, endTraceId: string): string {
  return `sub_${hash(`${episodeId}:${startTraceId}:${endTraceId}`)}`;
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) || ids.span();
}

function nonTrivial(s: string | undefined | null): boolean {
  const text = (s ?? "").trim();
  if (text.length < 8) return false;
  return !/^(ok|okay|yes|no|thanks|test|hello|继续|好的|谢谢|是的|嗯)[.!?。！？]*$/i.test(text);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function unique<T>(xs: readonly T[]): T[] {
  return Array.from(new Set(xs.filter(Boolean)));
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
