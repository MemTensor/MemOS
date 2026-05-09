import type {
  EpisodeId,
  FeedbackId,
  FeedbackRow,
  PolicyId,
  PolicyRow,
  RuntimeNamespace,
  TraceId,
  TraceRow,
} from "../types.js";
import type { Embedder } from "../embedding/types.js";
import type { LlmClient } from "../llm/index.js";
import { classifyFeedback } from "../feedback/classifier.js";
import { createFeedbackRefiner } from "./feedback-refiner.js";
import { ids } from "../id.js";
import { ownerFromNamespace } from "../runtime/namespace.js";
import type { Repos } from "../storage/repos/index.js";
import type { EmbeddingVector } from "../types.js";

export interface FeedbackExperienceResult {
  created: boolean;
  policyId?: PolicyId;
  skippedReason?: string;
}

export interface FeedbackExperienceDeps {
  repos: Pick<Repos, "policies" | "embeddingRetryQueue" | "traces">;
  embedder: Embedder | null;
  llm?: LlmClient;
  namespace: RuntimeNamespace;
  now?: () => number;
}

export interface FeedbackExperienceInput {
  feedback: FeedbackRow;
  episode?: { id: EpisodeId; traceIds?: readonly TraceId[]; rTask?: number | null } | null;
  trace?: TraceRow | null;
}

type ExperienceType = NonNullable<PolicyRow["experienceType"]>;
type EvidencePolarity = NonNullable<PolicyRow["evidencePolarity"]>;

interface DraftExperience {
  type: ExperienceType;
  polarity: EvidencePolarity;
  title: string;
  trigger: string;
  procedure: string;
  verification: string;
  boundary: string;
  decisionGuidance: PolicyRow["decisionGuidance"];
  salience: number;
  confidence: number;
  skillEligible: boolean;
  verifierMeta: Record<string, unknown> | null;
  vectorText: string;
}

const MIN_SIGNIFICANCE = 0.5;
const MERGE_SIMILARITY = 0.72;
const MAX_TITLE_CHARS = 120;
const MAX_LINE_CHARS = 360;

export async function runFeedbackExperience(
  input: FeedbackExperienceInput,
  deps: FeedbackExperienceDeps,
): Promise<FeedbackExperienceResult> {
  const now = deps.now?.() ?? Date.now();
  const text = feedbackText(input.feedback);
  if (!text) return { created: false, skippedReason: "empty-feedback" };

  const classified = classifyFeedback(text);
  const significance = significanceOf(input.feedback, classified.confidence, input.episode?.rTask);
  if (significance < MIN_SIGNIFICANCE || !isActionableFeedback(text, classified.shape)) {
    return { created: false, skippedReason: "not-actionable" };
  }

  const draft = await buildDraft({
    feedback: input.feedback,
    text,
    classified,
    significance,
    episode: input.episode,
    trace: input.trace ?? null,
    llm: deps.llm,
    repos: deps.repos,
  });
  const vec = await embedPolicy(draft.vectorText, deps);
  const existing = findSimilarPolicy(draft, vec, deps);
  const sourceEpisodeIds = input.feedback.episodeId ? [input.feedback.episodeId] : [];
  const sourceTraceIds = collectTraceIds(input);
  const sourceFeedbackIds = [input.feedback.id as FeedbackId];

  if (existing) {
    const merged = mergePolicy(existing, draft, {
      sourceEpisodeIds,
      sourceTraceIds,
      sourceFeedbackIds,
      vec: vec ?? existing.vec,
      now,
    });
    deps.repos.policies.upsert(merged);
    if (!merged.vec) enqueueEmbedding(merged.id, draft.vectorText, now, deps);
    return { created: false, policyId: merged.id };
  }

  const id = ids.policy() as PolicyId;
  const row: PolicyRow = {
    id,
    ...ownerFromNamespace(deps.namespace),
    title: draft.title,
    trigger: draft.trigger,
    procedure: draft.procedure,
    verification: draft.verification,
    boundary: draft.boundary,
    support: 1,
    gain: Math.max(0.02, draft.salience),
    status: draft.salience >= 0.5 ? "active" : "candidate",
    experienceType: draft.type,
    evidencePolarity: draft.polarity,
    salience: draft.salience,
    confidence: draft.confidence,
    sourceEpisodeIds,
    sourceFeedbackIds,
    sourceTraceIds,
    inducedBy: "feedback.experience.v1",
    decisionGuidance: draft.decisionGuidance,
    verifierMeta: draft.verifierMeta,
    skillEligible: draft.skillEligible,
    vec,
    createdAt: now,
    updatedAt: now,
  };
  deps.repos.policies.insert(row);
  if (!vec) enqueueEmbedding(id, draft.vectorText, now, deps);
  return { created: true, policyId: id };
}

export function feedbackText(feedback: FeedbackRow): string {
  const parts: string[] = [];
  if (feedback.rationale?.trim()) parts.push(feedback.rationale.trim());
  const raw = rawText(feedback.raw);
  if (raw) parts.push(raw);
  return dedupeLines(parts).join("\n").trim();
}

async function buildDraft(args: {
  feedback: FeedbackRow;
  text: string;
  classified: ReturnType<typeof classifyFeedback>;
  significance: number;
  episode?: { id: EpisodeId; traceIds?: readonly TraceId[]; rTask?: number | null } | null;
  trace: TraceRow | null;
  llm?: LlmClient;
  repos: Pick<Repos, "traces">;
}): Promise<DraftExperience> {
  const text = cleanLine(args.text, MAX_LINE_CHARS);
  const lower = args.text.toLowerCase();
  const verifier = extractVerifierMeta(args.feedback.raw, lower);
  const pass = isPositiveSignal(args.feedback, lower, args.classified.shape, verifier);
  const fail = isNegativeSignal(args.feedback, lower, args.classified.shape, verifier);
  const hasAvoid = /\b(avoid|do not|don't|never|stop|wrong|incorrect|failed|fail)\b/i.test(args.text)
    || /不要|别|不能|错误|失败|反例/.test(args.text);

  let type: ExperienceType;
  let polarity: EvidencePolarity;
  let skillEligible = false;
  if (pass) {
    type = "success_pattern";
    polarity = "positive";
    skillEligible = true;
  } else if (fail && hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (args.classified.shape === "preference") {
    type = "preference";
    polarity = fail ? "negative" : "neutral";
  } else if (hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (args.classified.shape === "correction" || args.classified.shape === "constraint" || fail) {
    type = "repair_instruction";
    polarity = fail ? "negative" : "neutral";
  } else if (verifier) {
    type = "verifier_feedback";
    polarity = pass ? "positive" : fail ? "negative" : "neutral";
  } else {
    type = "repair_instruction";
    polarity = "neutral";
  }

  // Try LLM refinement for better guidance extraction
  let title: string;
  let trigger: string;
  let procedure: string;
  let verification: string;
  let guidance: ReturnType<typeof guidanceOf>;

  if (args.llm && (args.trace || args.episode)) {
    try {
      // Build episode context: first turn + last 3 turns
      const episodeContext = buildEpisodeContext(args.episode, args.trace, args.repos);

      const refiner = createFeedbackRefiner({ llm: args.llm, timeoutMs: 5000 });
      const refined = await refiner.refine({
        feedbackText: args.text,
        userRequest: episodeContext.userRequest,
        agentResponse: episodeContext.agentResponse,
        episodeContext: episodeContext.fullContext,
        polarity: polarity === "positive" ? "positive" : polarity === "negative" ? "negative" : "neutral",
        trace: args.trace,
      });

      // Use refined guidance (following L2 induction structure)
      const prefix =
        type === "failure_avoidance"
          ? "Avoid"
          : type === "repair_instruction"
            ? "Repair"
            : type === "preference"
              ? "Prefer"
              : "Success";
      title = `${prefix}: ${refined.title}`;
      trigger = refined.trigger;
      procedure = refined.procedure;
      verification = refined.verification;
      guidance = {
        preference: [],
        antiPattern: refined.caveats,
      };
    } catch (err) {
      // Fall back to rule-based extraction
      const fallback = buildDraftFallback(args, type, text);
      title = fallback.title;
      trigger = fallback.trigger;
      procedure = fallback.procedure;
      verification = fallback.verification;
      guidance = fallback.guidance;
    }
  } else {
    // No LLM available, use rule-based extraction
    const fallback = buildDraftFallback(args, type, text);
    title = fallback.title;
    trigger = fallback.trigger;
    procedure = fallback.procedure;
    verification = fallback.verification;
    guidance = fallback.guidance;
  }

  const boundary = [
    "Use only for similar task shape, evaluator expectation, or user preference.",
    args.episode?.id ? `Source episode: ${args.episode.id}` : null,
    args.feedback.id ? `Source feedback: ${args.feedback.id}` : null,
  ].filter(Boolean).join("\n");
  const confidence = clamp(Math.max(args.classified.confidence, args.significance), 0, 1);
  const salience = clamp(Math.max(args.feedback.magnitude ?? 0, args.significance), 0, 1);
  return {
    type,
    polarity,
    title,
    trigger,
    procedure,
    verification,
    boundary,
    decisionGuidance: guidance,
    salience,
    confidence,
    skillEligible,
    verifierMeta: verifier,
    vectorText: [title, trigger, procedure, verification, boundary].join("\n"),
  };
}

function buildDraftFallback(
  args: {
    feedback: FeedbackRow;
    text: string;
    classified: ReturnType<typeof classifyFeedback>;
    episode?: { id: EpisodeId; traceIds?: readonly TraceId[]; rTask?: number | null } | null;
    trace: TraceRow | null;
  },
  type: ExperienceType,
  text: string,
) {
  const prefix =
    type === "failure_avoidance"
      ? "Avoid"
      : type === "repair_instruction"
        ? "Repair"
        : type === "preference"
          ? "Prefer"
          : "Success";
  const title = `${prefix}: ${firstSentence(text, MAX_TITLE_CHARS - prefix.length - 2)}`;
  const traceContext = args.trace ? traceHint(args.trace) : null;
  const guidance = guidanceOf(type, args.classified, text);
  const procedure = [
    type === "failure_avoidance"
      ? `Avoid repeating this behavior: ${text}`
      : type === "repair_instruction"
        ? `When this feedback pattern appears, repair the answer by applying: ${text}`
        : type === "preference"
          ? `Prefer this behavior in similar tasks: ${text}`
          : `This was accepted as a useful approach: ${text}`,
    traceContext ? `Source turn context: ${traceContext}` : null,
  ].filter(Boolean).join("\n");
  const trigger = [
    "When a future task is similar to the source episode or asks for comparable output.",
    args.trace?.userText ? `Source user request: ${cleanLine(args.trace.userText, 220)}` : null,
  ].filter(Boolean).join("\n");
  const verification = type === "success_pattern" || type === "repair_validated"
    ? "Before reusing, confirm the current task has the same success criteria as the feedback."
    : "Before answering, check the current plan against this avoid/repair instruction.";

  return { title, trigger, procedure, verification, guidance };
}

function guidanceOf(
  type: ExperienceType,
  classified: ReturnType<typeof classifyFeedback>,
  text: string,
): PolicyRow["decisionGuidance"] {
  const preference: string[] = [];
  const antiPattern: string[] = [];
  if (classified.shape === "preference") {
    if (classified.prefer) preference.push(cleanLine(classified.prefer, MAX_LINE_CHARS));
    if (classified.avoid) antiPattern.push(cleanLine(classified.avoid, MAX_LINE_CHARS));
  } else if (classified.shape === "correction" && classified.correction) {
    preference.push(cleanLine(classified.correction, MAX_LINE_CHARS));
  } else if (classified.shape === "constraint" && classified.constraint) {
    preference.push(cleanLine(classified.constraint, MAX_LINE_CHARS));
  }
  if (type === "failure_avoidance") antiPattern.push(text);
  if (type === "repair_instruction" || type === "success_pattern") preference.push(text);
  return {
    preference: dedupeLines(preference),
    antiPattern: dedupeLines(antiPattern),
  };
}

async function embedPolicy(
  text: string,
  deps: FeedbackExperienceDeps,
): Promise<EmbeddingVector | null> {
  if (!deps.embedder) return null;
  try {
    return await deps.embedder.embedOne({ text, role: "document" });
  } catch {
    return null;
  }
}

function findSimilarPolicy(
  draft: DraftExperience,
  vec: EmbeddingVector | null,
  deps: FeedbackExperienceDeps,
): PolicyRow | null {
  if (!vec) return null;
  const hits = deps.repos.policies.searchByVector(vec, 5, {
    statusIn: ["active", "candidate"],
    hardCap: 50,
  });
  for (const hit of hits) {
    if (hit.score < MERGE_SIMILARITY) continue;
    const row = deps.repos.policies.getById(hit.id as PolicyId);
    if (!row) continue;
    if (row.experienceType && row.experienceType !== draft.type && hit.score < 0.82) {
      continue;
    }
    return row;
  }
  return null;
}

function mergePolicy(
  existing: PolicyRow,
  draft: DraftExperience,
  patch: {
    sourceEpisodeIds: readonly EpisodeId[];
    sourceTraceIds: readonly TraceId[];
    sourceFeedbackIds: readonly FeedbackId[];
    vec: EmbeddingVector | null;
    now: number;
  },
): PolicyRow {
  const existingSkillEligible = existing.skillEligible !== false;
  const skillEligible = existingSkillEligible || draft.skillEligible;
  const polarity = mergePolarity(existing.evidencePolarity ?? "positive", draft.polarity);
  return {
    ...existing,
    support: Math.max(1, existing.support) + 1,
    gain: Math.max(existing.gain, draft.salience, 0.02),
    status: existing.status === "archived" ? existing.status : "active",
    experienceType: skillEligible && polarity === "mixed"
      ? "repair_validated"
      : existing.experienceType ?? draft.type,
    evidencePolarity: polarity,
    salience: Math.max(existing.salience ?? 0, draft.salience),
    confidence: Math.max(existing.confidence ?? 0.5, draft.confidence),
    sourceEpisodeIds: mergeIds(existing.sourceEpisodeIds ?? [], patch.sourceEpisodeIds),
    sourceFeedbackIds: mergeIds(existing.sourceFeedbackIds ?? [], patch.sourceFeedbackIds),
    sourceTraceIds: mergeIds(existing.sourceTraceIds ?? [], patch.sourceTraceIds),
    decisionGuidance: {
      preference: dedupeLines([
        ...(existing.decisionGuidance?.preference ?? []),
        ...draft.decisionGuidance.preference,
      ]),
      antiPattern: dedupeLines([
        ...(existing.decisionGuidance?.antiPattern ?? []),
        ...draft.decisionGuidance.antiPattern,
      ]),
    },
    verifierMeta: existing.verifierMeta ?? draft.verifierMeta,
    skillEligible,
    vec: patch.vec,
    updatedAt: patch.now,
  };
}

function significanceOf(
  feedback: FeedbackRow,
  classifierConfidence: number,
  episodeReward: number | null | undefined,
): number {
  const rawScore = verifierScore(feedback.raw);
  const reward = typeof episodeReward === "number" ? Math.abs(episodeReward) : 0;
  const magnitude = typeof feedback.magnitude === "number" ? feedback.magnitude : 0;
  return clamp(Math.max(magnitude, classifierConfidence, rawScore, reward), 0, 1);
}

function isActionableFeedback(text: string, shape: string): boolean {
  if (shape !== "unknown" && shape !== "confusion") return true;
  return /\b(next time|should|must|avoid|prefer|instead|do not|don't|pass|fail|failed|success|expected|actual)\b/i.test(text)
    || /下次|应该|必须|不要|别|成功|失败|反例|期望|实际|改/.test(text);
}

function isPositiveSignal(
  feedback: FeedbackRow,
  lower: string,
  shape: string,
  verifier: Record<string, unknown> | null,
): boolean {
  if (feedback.polarity === "positive") return true;
  if (shape === "positive") return true;
  if (verifier && lower.includes("pass")) return true;
  return /\b(success|succeeded|passed|task succeeded|works well|correct)\b/.test(lower)
    || /成功|通过|正确|太好了|写得很好/.test(lower);
}

function isNegativeSignal(
  feedback: FeedbackRow,
  lower: string,
  shape: string,
  verifier: Record<string, unknown> | null,
): boolean {
  if (feedback.polarity === "negative") return true;
  if (shape === "negative") return true;
  if (shape === "correction") return true;
  if (verifier && /\b(fail|failed|counterexample)\b/.test(lower)) return true;
  return /\b(fail|failed|wrong|incorrect|counterexample|not acceptable)\b/.test(lower)
    || /失败|错误|不对|反例/.test(lower);
}

function collectTraceIds(input: FeedbackExperienceInput): TraceId[] {
  const out: TraceId[] = [];
  if (input.feedback.traceId) out.push(input.feedback.traceId as TraceId);
  if (input.trace?.id) out.push(input.trace.id);
  for (const id of input.episode?.traceIds ?? []) out.push(id as TraceId);
  return mergeIds([], out);
}

function enqueueEmbedding(
  policyId: PolicyId,
  sourceText: string,
  now: number,
  deps: FeedbackExperienceDeps,
): void {
  deps.repos.embeddingRetryQueue.enqueue({
    id: ids.span(),
    targetKind: "policy",
    targetId: policyId,
    vectorField: "vec",
    sourceText,
    embedRole: "document",
    now,
  });
}

function rawText(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw !== "object") return String(raw);
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.feedback,
    obj.text,
    obj.message,
    obj.rationale,
    obj.reason,
    obj.verdict,
    obj.summary,
  ];
  const lines = candidates
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((s) => s.trim());
  return lines.join("\n");
}

function extractVerifierMeta(raw: unknown, lower: string): Record<string, unknown> | null {
  const looksVerifier = lower.includes("verifier")
    || lower.includes("verification")
    || lower.includes("counterexample")
    || lower.includes("本任务评为反例");
  if (!looksVerifier && (typeof raw !== "object" || raw == null)) return null;
  const meta: Record<string, unknown> = { source: "feedback" };
  if (looksVerifier) meta.verifier = true;
  if (typeof raw === "object" && raw != null) {
    const obj = raw as Record<string, unknown>;
    for (const key of ["verdict", "score", "reward", "passed", "taskId", "family", "reason"]) {
      if (obj[key] !== undefined) meta[key] = obj[key];
    }
  }
  return Object.keys(meta).length > 1 || looksVerifier ? meta : null;
}

function verifierScore(raw: unknown): number {
  if (typeof raw !== "object" || raw == null) return 0;
  const obj = raw as Record<string, unknown>;
  for (const key of ["score", "reward", "r", "rating"]) {
    const n = Number(obj[key]);
    if (Number.isFinite(n)) return Math.min(1, Math.abs(n));
  }
  return 0;
}

function traceHint(trace: TraceRow): string {
  const parts = [
    trace.summary ? `summary=${cleanLine(trace.summary, 140)}` : null,
    trace.userText ? `user=${cleanLine(trace.userText, 140)}` : null,
    trace.reflection ? `note=${cleanLine(trace.reflection, 140)}` : null,
  ];
  return parts.filter(Boolean).join(" | ");
}

interface EpisodeContext {
  userRequest: string;
  agentResponse: string;
  fullContext: string;
}

/**
 * Build episode context for LLM refinement.
 * Strategy: Include first turn + last 3 turns (smart truncation).
 */
function buildEpisodeContext(
  episode: { id: EpisodeId; traceIds?: readonly TraceId[]; rTask?: number | null } | null | undefined,
  currentTrace: TraceRow | null,
  repos: Pick<Repos, "traces">,
): EpisodeContext {
  // Fallback: use current trace only
  if (!episode?.traceIds || episode.traceIds.length === 0) {
    if (currentTrace) {
      return {
        userRequest: currentTrace.userText,
        agentResponse: currentTrace.agentText,
        fullContext: formatTurn(1, currentTrace),
      };
    }
    return {
      userRequest: "",
      agentResponse: "",
      fullContext: "",
    };
  }

  // Fetch all traces
  const traces: TraceRow[] = [];
  for (const traceId of episode.traceIds) {
    const trace = repos.traces.getById(traceId as TraceId);
    if (trace) traces.push(trace);
  }

  if (traces.length === 0) {
    return {
      userRequest: currentTrace?.userText ?? "",
      agentResponse: currentTrace?.agentText ?? "",
      fullContext: currentTrace ? formatTurn(1, currentTrace) : "",
    };
  }

  // Strategy: first turn + last 3 turns
  const selected: TraceRow[] = [];
  const firstTurn = traces[0];
  if (firstTurn) selected.push(firstTurn);

  // Last 3 turns (excluding first if already included)
  const lastN = 3;
  const startIdx = Math.max(1, traces.length - lastN);
  for (let i = startIdx; i < traces.length; i++) {
    const trace = traces[i];
    if (trace && trace.id !== firstTurn?.id) {
      selected.push(trace);
    }
  }

  // Format context
  const contextParts: string[] = [];
  for (let i = 0; i < selected.length; i++) {
    const trace = selected[i]!;
    const turnNumber = traces.indexOf(trace) + 1;
    contextParts.push(formatTurn(turnNumber, trace));
  }

  // Use last turn as primary user/agent text
  const lastTurn = selected[selected.length - 1] ?? firstTurn;

  return {
    userRequest: lastTurn?.userText ?? "",
    agentResponse: lastTurn?.agentText ?? "",
    fullContext: contextParts.join("\n\n"),
  };
}

function formatTurn(turnNumber: number, trace: TraceRow): string {
  const userText = truncate(trace.userText, 400);
  const agentText = truncate(trace.agentText, 600);
  return `Turn ${turnNumber}:\nUser: ${userText}\nAgent: ${agentText}`;
}

function truncate(s: string, maxLen: number): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function firstSentence(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const sentence = trimmed.split(/(?<=[.!?。！？])\s+/)[0] ?? trimmed;
  return cleanLine(sentence, maxChars);
}

function cleanLine(text: string, maxChars: number): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length <= maxChars ? s : `${s.slice(0, Math.max(0, maxChars - 1))}...`;
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

function mergeIds<T extends string>(a: readonly T[], b: readonly T[]): T[] {
  return Array.from(new Set([...a, ...b].filter(Boolean)));
}

function mergePolarity(a: EvidencePolarity, b: EvidencePolarity): EvidencePolarity {
  if (a === b) return a;
  if (a === "mixed" || b === "mixed") return "mixed";
  if (a === "neutral") return b;
  if (b === "neutral") return a;
  return "mixed";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
