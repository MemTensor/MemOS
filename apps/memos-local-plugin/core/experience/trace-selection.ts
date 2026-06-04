import type { TraceRow } from "../types.js";

export interface FeedbackTraceSelectionEntry {
  trace: TraceRow;
  idx: number;
  text: string;
  value: number;
}

export interface FeedbackTraceCompression {
  kept: FeedbackTraceSelectionEntry[];
  droppedCount: number;
}

export function compressFeedbackEpisodeTraces(
  traces: readonly TraceRow[],
  feedbackText: string,
  maxChars: number,
): FeedbackTraceCompression {
  const entries = buildFeedbackTraceEntries(traces, feedbackText);
  const firstId = traces[0]?.id;
  const lastId = traces[traces.length - 1]?.id;
  const kept = [...entries];
  let total = textTotal(kept);
  while (total > maxChars && kept.length > 1) {
    let dropIdx = -1;
    let dropValue = Infinity;
    let dropLen = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const entry = kept[i]!;
      if (isProtectedTrace(entry.trace, firstId, lastId)) continue;
      const better =
        entry.value < dropValue
        || (entry.value === dropValue && entry.text.length < dropLen);
      if (better) {
        dropIdx = i;
        dropValue = entry.value;
        dropLen = entry.text.length;
      }
    }
    if (dropIdx < 0) break;
    kept.splice(dropIdx, 1);
    total = textTotal(kept);
  }
  kept.sort((a, b) => a.idx - b.idx);
  return { kept, droppedCount: entries.length - kept.length };
}

export function selectRepresentativeFeedbackTraces(
  traces: readonly TraceRow[],
  feedbackText: string,
  limit: number,
): TraceRow[] {
  if (limit <= 0 || traces.length === 0) return [];
  const firstId = traces[0]?.id;
  const lastId = traces[traces.length - 1]?.id;
  return buildFeedbackTraceEntries(traces, feedbackText)
    .sort((a, b) => {
      const bp = protectedRank(b.trace, firstId, lastId);
      const ap = protectedRank(a.trace, firstId, lastId);
      if (bp !== ap) return bp - ap;
      if (b.value !== a.value) return b.value - a.value;
      return a.idx - b.idx;
    })
    .slice(0, limit)
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.trace);
}

export function formatFeedbackTraceTurn(turnNumber: number, trace: TraceRow): string {
  const userText = truncate(trace.userText, 280);
  const agentText = truncate(trace.agentText, 360);
  const toolSummary = summarizeTools(trace.toolCalls ?? []);
  const errorSummary = summarizeErrors(trace);
  const lines = [
    `Turn ${turnNumber}:`,
    `User: ${userText}`,
    `Agent: ${agentText}`,
    toolSummary ? `Tools: ${toolSummary}` : null,
    errorSummary ? `Errors: ${errorSummary}` : null,
  ].filter((line): line is string => typeof line === "string");
  return lines.join("\n");
}

function buildFeedbackTraceEntries(
  traces: readonly TraceRow[],
  feedbackText: string,
): FeedbackTraceSelectionEntry[] {
  const feedbackKeywords = extractFeedbackKeywords(feedbackText);
  const firstId = traces[0]?.id;
  const lastId = traces[traces.length - 1]?.id;
  return traces.map((trace, idx) => {
    const text = formatFeedbackTraceTurn(idx + 1, trace);
    const value = traceInformationValue(trace, feedbackKeywords, firstId, lastId);
    return { trace, idx, text, value };
  });
}

function textTotal(entries: readonly FeedbackTraceSelectionEntry[]): number {
  return entries.reduce((sum, item) => sum + item.text.length, 0) + Math.max(0, entries.length - 1) * 2;
}

/** Capture-time reflection label: pivotal steps must survive context compression. */
function isPivotalTrace(trace: TraceRow): boolean {
  return trace.reflection?.trim() === "PIVOTAL";
}

function isProtectedTrace(
  trace: TraceRow,
  firstId: string | undefined,
  lastId: string | undefined,
): boolean {
  return trace.id === firstId || trace.id === lastId || isPivotalTrace(trace);
}

function protectedRank(
  trace: TraceRow,
  firstId: string | undefined,
  lastId: string | undefined,
): number {
  if (isPivotalTrace(trace)) return 3;
  if (trace.id === firstId || trace.id === lastId) return 2;
  return 0;
}

function traceInformationValue(
  trace: TraceRow,
  feedbackKeywords: readonly string[],
  firstId: string | undefined,
  lastId: string | undefined,
): number {
  let score = 0;
  if (trace.id === firstId) score += 80;
  if (trace.id === lastId) score += 80;
  if (isPivotalTrace(trace)) score += 70;
  if ((trace.toolCalls?.length ?? 0) > 0) score += 18;
  if ((trace.errorSignatures?.length ?? 0) > 0) score += 42;
  if (trace.toolCalls?.some((tool) => typeof tool.errorCode === "string" && tool.errorCode.trim().length > 0)) {
    score += 45;
  }
  const corpus = `${trace.userText}\n${trace.agentText}`.toLowerCase();
  if (feedbackKeywords.some((kw) => corpus.includes(kw))) score += 30;
  if (/error|failed|failure|timeout|exception|错误|失败|超时/i.test(corpus)) score += 28;
  if (trace.userText.trim().length > 0) score += 5;
  if (trace.agentText.trim().length > 0) score += 5;
  return score;
}

function extractFeedbackKeywords(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens = normalized.split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => (/[a-z0-9]/.test(t) ? t.length >= 4 : t.length >= 2));
  return dedupeLines(tokens).slice(0, 32);
}

function summarizeTools(toolCalls: TraceRow["toolCalls"]): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  const pieces = toolCalls.slice(0, 4).map((tool) => {
    const name = tool.name || "unknown";
    const code = typeof tool.errorCode === "string" && tool.errorCode.trim() ? `#${tool.errorCode}` : "";
    const output = typeof tool.output === "string" ? truncate(tool.output.replace(/\s+/g, " "), 80) : "";
    return [name, code, output].filter(Boolean).join(" ");
  });
  return truncate(pieces.join(" | "), 280);
}

function summarizeErrors(trace: TraceRow): string {
  const sig = (trace.errorSignatures ?? []).slice(0, 3).map((s) => truncate(s, 80));
  const codes = (trace.toolCalls ?? [])
    .map((tool) => tool.errorCode)
    .filter((code): code is string => typeof code === "string" && code.trim().length > 0);
  const merged = dedupeLines([...codes, ...sig]);
  return truncate(merged.join(" | "), 260);
}

function truncate(s: string, maxLen: number): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function dedupeLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const s = line.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}
