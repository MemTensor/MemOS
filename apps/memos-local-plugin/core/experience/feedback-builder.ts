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
import { reflectionAsText } from "../capture/types.js";
import { createFeedbackRefiner } from "./feedback-refiner.js";
import { deriveMergeFamily } from "./merge-family.js";
import { ids } from "../id.js";
import { ownerFromNamespace } from "../runtime/namespace.js";
import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import type { Repos } from "../storage/repos/index.js";
import type { EmbeddingVector } from "../types.js";
import { MemosError, ERROR_CODES } from "../../agent-contract/errors.js";

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
  log?: Pick<Logger, "info" | "warn">;
}

export interface FeedbackExperienceInput {
  feedback: FeedbackRow;
  episode?: { id: EpisodeId; traceIds?: readonly TraceId[]; rTask?: number | null } | null;
  trace?: TraceRow | null;
}

type ExperienceType = NonNullable<PolicyRow["experienceType"]>;
type EvidencePolarity = NonNullable<PolicyRow["evidencePolarity"]>;

type RefineFallbackReason =
  | "llm_disabled"
  | "llm_missing_turn_context"
  | "llm_timeout"
  | "llm_malformed"
  | "llm_error";

interface RefineFallbackEvent {
  reason: RefineFallbackReason;
  traceCount?: number;
  keptTraceCount?: number;
  droppedTraceCount?: number;
  contextChars?: number;
  err?: string;
}

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
  refineFallback?: RefineFallbackEvent;
}

interface EpisodeContext {
  userRequest: string;
  agentResponse: string;
  fullContext: string;
  traceCount: number;
  keptTraceCount: number;
  droppedTraceCount: number;
  contextChars: number;
}

const MIN_SIGNIFICANCE = 0.5;
const MERGE_SIMILARITY = 0.72;
const MAX_TITLE_CHARS = 120;
const MAX_LINE_CHARS = 360;
const REFINE_TIMEOUT_MS = 30_000;
const REFINE_MAX_CONTEXT_CHARS = 16_000;
// Strict scenarios: only full credit counts as a pass (covers {-1,+1} and 0..1
// reward scales — anything short of 1 means the task was not fully solved).
const FULL_PASS_REWARD = 1;

export async function runFeedbackExperience(
  input: FeedbackExperienceInput,
  deps: FeedbackExperienceDeps,
): Promise<FeedbackExperienceResult> {
  const now = deps.now?.() ?? Date.now();
  const log = deps.log ?? rootLogger.child({ channel: "core.experience.feedback-builder" });
  const text = feedbackText(input.feedback);
  if (!text) return { created: false, skippedReason: "empty-feedback" };

  const classified = classifyFeedback(text);
  const significance = significanceOf(input.feedback, classified.confidence, input.episode?.rTask);
  if (significance < MIN_SIGNIFICANCE || !isActionableFeedback(text, classified.shape)) {
    return { created: false, skippedReason: "not-actionable" };
  }

  let episodeContext: EpisodeContext | null = null;
  if (deps.llm && (input.trace || input.episode)) {
    episodeContext = buildEpisodeContext(
      input.episode,
      input.trace ?? null,
      deps.repos,
      text,
    );
    if (episodeContext.contextChars > REFINE_MAX_CONTEXT_CHARS) {
      log.info("feedback.experience.skipped", {
        feedbackId: input.feedback.id,
        episodeId: input.episode?.id ?? input.feedback.episodeId ?? null,
        skippedReason: "context_too_large",
        traceCount: episodeContext.traceCount,
        keptTraceCount: episodeContext.keptTraceCount,
        droppedTraceCount: episodeContext.droppedTraceCount,
        contextChars: episodeContext.contextChars,
        maxContextChars: REFINE_MAX_CONTEXT_CHARS,
      });
      return { created: false, skippedReason: "context_too_large" };
    }
  }

  const provisionalPolicyId = ids.policy() as PolicyId;

  const draft = await buildDraft({
    feedback: input.feedback,
    text,
    classified,
    significance,
    episode: input.episode,
    trace: input.trace ?? null,
    llm: deps.llm,
    repos: deps.repos,
    episodeContext,
  });
  const vec = await embedPolicy(draft.vectorText, deps);
  const mergeFamily = deriveMergeFamily({
    experienceType: draft.type,
    evidencePolarity: draft.polarity,
    inducedBy: "feedback.experience.v1",
  });
  const existing = findSimilarPolicy(draft, vec, mergeFamily, deps);
  const sourceEpisodeIds = input.feedback.episodeId ? [input.feedback.episodeId] : [];
  const sourceTraceIds = collectTraceIds(input);
  const sourceFeedbackIds = [input.feedback.id as FeedbackId];

  const hitActive = Boolean(existing && existing.status === "active");
  if (existing && !hitActive) {
    const merged = mergePolicy(existing, draft, {
      sourceEpisodeIds,
      sourceTraceIds,
      sourceFeedbackIds,
      vec: vec ?? existing.vec,
      now,
    });
    deps.repos.policies.upsert(merged);
    if (!merged.vec) enqueueEmbedding(merged.id, draft.vectorText, now, deps);
    logRefineFallback(log, draft.refineFallback, {
      policyId: merged.id,
      feedbackId: input.feedback.id,
      episodeId: input.episode?.id ?? input.feedback.episodeId ?? null,
    });
    return { created: false, policyId: merged.id };
  }

  const id = provisionalPolicyId;
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
    status: hitActive ? "candidate" : (draft.salience >= 0.5 ? "active" : "candidate"),
    experienceType: draft.type,
    evidencePolarity: draft.polarity,
    salience: draft.salience,
    confidence: draft.confidence,
    sourceEpisodeIds,
    sourceFeedbackIds,
    sourceTraceIds,
    inducedBy: "feedback.experience.v1",
    mergeFamily,
    decisionGuidance: draft.decisionGuidance,
    verifierMeta: draft.verifierMeta,
    skillEligible: draft.skillEligible,
    vec,
    createdAt: now,
    updatedAt: now,
  };
  deps.repos.policies.insert(row);
  if (!vec) enqueueEmbedding(id, draft.vectorText, now, deps);
  logRefineFallback(log, draft.refineFallback, {
    policyId: id,
    feedbackId: input.feedback.id,
    episodeId: input.episode?.id ?? input.feedback.episodeId ?? null,
  });
  return { created: true, policyId: id };
}

function logRefineFallback(
  log: Pick<Logger, "info" | "warn">,
  event: RefineFallbackEvent | undefined,
  ids: { policyId: PolicyId; feedbackId: FeedbackId; episodeId: EpisodeId | null },
): void {
  if (!event) return;
  const level: "info" | "warn" =
    event.reason === "llm_disabled" ? "info" : "warn";
  log[level]("feedback.experience.refine_fallback", {
    policyId: ids.policyId,
    feedbackId: ids.feedbackId,
    episodeId: ids.episodeId,
    fallbackReason: event.reason,
    llmTimeoutMs: REFINE_TIMEOUT_MS,
    traceCount: event.traceCount,
    keptTraceCount: event.keptTraceCount,
    droppedTraceCount: event.droppedTraceCount,
    contextChars: event.contextChars,
    err: event.err,
  });
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
  episodeContext?: EpisodeContext | null;
}): Promise<DraftExperience> {
  let refineFallback: RefineFallbackEvent | undefined;
  const text = cleanLine(args.text, MAX_LINE_CHARS);
  const lower = args.text.toLowerCase();
  const verifier = extractVerifierMeta(args.feedback.raw, lower);
  // Authoritative success/failure from the verifier payload or episode reward.
  // Strict scenarios (coding/math/verifier): ONLY a full pass is positive — a
  // partial pass such as 3/4 (or reward 0) is a failure, never a positive exemplar.
  const outcome = objectiveOutcome(args.feedback.raw, args.episode?.rTask);
  const lexicalPass = isPositiveSignal(args.feedback, lower, args.classified.shape);
  const lexicalFail = isNegativeSignal(args.feedback, lower, args.classified.shape);
  // Objective outcome dominates; lexical signals only decide when it is unknown.
  const pass = outcome === "pass" || (outcome === "unknown" && lexicalPass && !lexicalFail);
  const fail = outcome === "fail" || (outcome === "unknown" && lexicalFail);
  const hasAvoid = /\b(avoid|do not|don't|never|stop|wrong|incorrect|failed|fail)\b/i.test(args.text)
    || /不要|别|不能|错误|失败|反例/.test(args.text);

  let type: ExperienceType;
  let polarity: EvidencePolarity;
  let skillEligible = false;
  if (pass) {
    type = "success_pattern";
    polarity = "positive";
    skillEligible = true;
  } else if (fail) {
    // Objective failure: never a positive exemplar, never skill-eligible.
    type = hasAvoid ? "failure_avoidance" : verifier ? "verifier_feedback" : "repair_instruction";
    polarity = "negative";
  } else if (args.classified.shape === "preference") {
    type = "preference";
    polarity = "neutral";
  } else if (hasAvoid) {
    type = "failure_avoidance";
    polarity = "negative";
  } else if (args.classified.shape === "correction" || args.classified.shape === "constraint") {
    type = "repair_instruction";
    polarity = "neutral";
  } else if (verifier) {
    type = "verifier_feedback";
    polarity = "neutral";
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
  // The LLM's "what to do" line, when refinement ran — used as the corrective
  // fix text for a constructive negative (Q6).
  let llmProcedure: string | null = null;

  if (args.llm && (args.trace || args.episode)) {
    try {
      const episodeContext = args.episodeContext ?? buildEpisodeContext(
        args.episode,
        args.trace,
        args.repos,
        args.text,
      );
      if (!episodeContext.userRequest.trim() || !episodeContext.agentResponse.trim()) {
        refineFallback = {
          reason: "llm_missing_turn_context",
          traceCount: episodeContext.traceCount,
          keptTraceCount: episodeContext.keptTraceCount,
          droppedTraceCount: episodeContext.droppedTraceCount,
          contextChars: episodeContext.contextChars,
        };
        const fallback = buildDraftFallback(args, type, text);
        title = fallback.title;
        trigger = fallback.trigger;
        procedure = fallback.procedure;
        verification = fallback.verification;
        guidance = fallback.guidance;
      } else {

        const refiner = createFeedbackRefiner({ llm: args.llm, timeoutMs: REFINE_TIMEOUT_MS });
        const refined = await refiner.refine({
          feedbackText: args.text,
          userRequest: episodeContext.userRequest,
          agentResponse: episodeContext.agentResponse,
          episodeContext: episodeContext.fullContext,
          polarity: polarity === "positive" ? "positive" : polarity === "negative" ? "negative" : "neutral",
          trace: args.trace,
        });
        if (refined.method === "rule") {
          const reason = refined.fallbackReason ?? "llm_error";
          refineFallback = {
            reason: reason === "llm_disabled" ? "llm_disabled" : reason,
            traceCount: episodeContext.traceCount,
            keptTraceCount: episodeContext.keptTraceCount,
            droppedTraceCount: episodeContext.droppedTraceCount,
            contextChars: episodeContext.contextChars,
          };
        }

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
        llmProcedure = refined.procedure;
      }
    } catch (err) {
      refineFallback = {
        reason: classifyLlmFallbackReason(err),
        err: err instanceof Error ? err.message : String(err),
      };
      // Fall back to rule-based extraction
      const fallback = buildDraftFallback(args, type, text);
      title = fallback.title;
      trigger = fallback.trigger;
      procedure = fallback.procedure;
      verification = fallback.verification;
      guidance = fallback.guidance;
    }
  } else {
    refineFallback = { reason: "llm_disabled" };
    // No LLM available, use rule-based extraction
    const fallback = buildDraftFallback(args, type, text);
    title = fallback.title;
    trigger = fallback.trigger;
    procedure = fallback.procedure;
    verification = fallback.verification;
    guidance = fallback.guidance;
  }

  // Q6: a constructive negative carries BOTH faces in one record — the
  // avoidance ("don't do X", already in antiPattern) and the suggested fix
  // ("do Y") as a preference. Only when the feedback actually names a
  // corrective direction; a bare verdict ("wrong", reward 0) stays a pure
  // warning and mints no fix (Q5: 没建设性就不沉淀修法).
  const fix = fail ? constructiveFix(args.classified, llmProcedure) : null;
  if (fix) {
    guidance = {
      preference: dedupeLines([...guidance.preference, fix]),
      antiPattern: guidance.antiPattern,
    };
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
    refineFallback,
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
  // Drop punctuation-only / empty captures (the classifier can extract "." from
  // a soft preference match) so guidance never stores garbage.
  return {
    preference: dedupeLines(preference.filter(substantive)),
    antiPattern: dedupeLines(antiPattern.filter(substantive)),
  };
}

// Corrective-direction cues ("do Y"), conservative on purpose: meta prompts
// like "reflect on what to improve" are NOT cues, so a bare verdict mints no
// fix. The capture group holds the fix text.
const CORRECTIVE_CLAUSE_PATTERNS: readonly RegExp[] = [
  /\binstead[,\s]+\s*(?:use|try|apply|do|switch to)\s+(.{4,240})/i,
  /\b(?:use|prefer|switch to|apply)\s+(.{4,240}?)\s+instead\b/i,
  /\b(?:should|must|need to|needs to|have to)\s+(?:use|be|do|switch to|apply)\s+(.{4,240})/i,
  /\b(?:use|prefer|switch to|apply)\s+(.{4,240})/i,
  /(?:改用|应该用|应改为|换成|建议用|下次用|应该)\s*(.{2,120})/,
];

/**
 * Reject only empty / pure-punctuation captures (e.g. the classifier's stray
 * ".") — anything with at least one letter or digit is real content. A higher
 * bar would wrongly drop short CJK guidance like "重复".
 */
function substantive(s: string | null | undefined): boolean {
  if (!s) return false;
  return /[\p{L}\p{N}]/u.test(s);
}

function extractCorrectiveClause(text: string): string | null {
  for (const re of CORRECTIVE_CLAUSE_PATTERNS) {
    const m = re.exec(text);
    const clause = m?.[1]?.trim();
    if (clause && substantive(clause)) return clause;
  }
  return null;
}

/**
 * For a failed/negative feedback, extract the *corrective direction* ("do Y")
 * when the feedback actually contains one. Returns null when the feedback only
 * delivers a verdict ("wrong", reward 0, plain TLE) with no reusable fix — those
 * stay a pure avoidance warning and mint no repair candidate downstream
 * (Q5: 没建设性就不沉淀修法).
 *
 * Gates on *substantive corrective text* rather than the classifier shape: the
 * lexical classifier is noisy here (soft "instead/use" hits extract nothing,
 * and pattern captures can grab punctuation like "."). The LLM's refined
 * procedure is preferred when present; otherwise we extract a clause ourselves.
 */
function constructiveFix(
  classified: ReturnType<typeof classifyFeedback>,
  llmProcedure: string | null,
): string | null {
  const candidates = [
    llmProcedure,
    extractCorrectiveClause(classified.text),
    classified.prefer,
    classified.correction,
    classified.constraint,
  ];
  for (const c of candidates) {
    const s = c?.trim();
    if (s && substantive(s)) return cleanLine(s, MAX_LINE_CHARS);
  }
  return null;
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
  mergeFamily: NonNullable<PolicyRow["mergeFamily"]>,
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
    if (row.mergeFamily && row.mergeFamily !== mergeFamily) continue;
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
  const nextExperienceType = skillEligible && polarity === "mixed"
    ? "repair_validated"
    : existing.experienceType ?? draft.type;
  return {
    ...existing,
    support: Math.max(1, existing.support) + 1,
    gain: Math.max(existing.gain, draft.salience, 0.02),
    status: existing.status === "archived" ? existing.status : "active",
    experienceType: nextExperienceType,
    evidencePolarity: polarity,
    mergeFamily: deriveMergeFamily({
      experienceType: nextExperienceType,
      evidencePolarity: polarity,
      inducedBy: existing.inducedBy,
    }),
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
): boolean {
  if (feedback.polarity === "positive") return true;
  if (shape === "positive") return true;
  // No substring "pass"/"通过" match here: "passed 3/4" is a partial failure, not
  // a positive signal. A genuine full pass is decided by objectiveOutcome().
  return /\b(success|succeeded|works well|looks good|lgtm|correct)\b/.test(lower)
    || /成功|正确|太好了|写得很好/.test(lower);
}

function isNegativeSignal(
  feedback: FeedbackRow,
  lower: string,
  shape: string,
): boolean {
  if (feedback.polarity === "negative") return true;
  if (shape === "negative") return true;
  if (shape === "correction") return true;
  return /\b(fail|failed|wrong|incorrect|counterexample|not acceptable|timeout|time limit exceeded)\b/.test(lower)
    || /失败|错误|不对|反例|超时/.test(lower);
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
  const src = verifierContainer(raw);
  if (!looksVerifier && !src) return null;
  const meta: Record<string, unknown> = { source: "feedback" };
  if (looksVerifier) meta.verifier = true;
  if (src) {
    // Read from the verifier payload (top-level or nested under `raw.verifier`)
    // so the discriminative fields (reward/passed/total) are preserved.
    for (const key of ["verdict", "score", "reward", "passed", "total", "taskId", "family", "reason"]) {
      if (src[key] !== undefined) meta[key] = src[key];
    }
  }
  return Object.keys(meta).length > 1 || looksVerifier ? meta : null;
}

/**
 * Return the object that actually holds verifier fields. Benchmark gateways nest
 * them under `raw.verifier`; older/manual feedback puts them at the top level.
 */
function verifierContainer(raw: unknown): Record<string, unknown> | null {
  let obj: unknown = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj == null) return null;
  const rec = obj as Record<string, unknown>;
  if (rec.verifier && typeof rec.verifier === "object") {
    return rec.verifier as Record<string, unknown>;
  }
  return rec;
}

interface VerifierStats {
  reward: number | null;
  passed: number | null;
  total: number | null;
}

function verifierStats(raw: unknown): VerifierStats {
  const src = verifierContainer(raw);
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (!src) return { reward: null, passed: null, total: null };
  return {
    reward: num(src.reward ?? src.score ?? src.r ?? src.rating),
    passed: num(src.passed),
    total: num(src.total),
  };
}

export type ObjectiveOutcome = "pass" | "fail" | "unknown";

/**
 * Authoritative success/failure from the verifier payload, falling back to the
 * episode reward. Strict scenarios (coding/math/verifier) treat ONLY a full pass
 * as positive: a partial pass (passed < total) or reward below full credit is a
 * failure, never a positive exemplar.
 *
 * Pass `rTask = null` for a *verifier-only* verdict: with no reward fallback it
 * returns "unknown" when the payload carries no verifier signal. Used by strict
 * repair-candidate trial resolution, which must never pass on a loose reward.
 */
export function objectiveOutcome(raw: unknown, rTask: number | null | undefined): ObjectiveOutcome {
  const { reward, passed, total } = verifierStats(raw);
  if (passed != null && total != null && total > 0) {
    return passed >= total ? "pass" : "fail";
  }
  if (reward != null) {
    // Epsilon guards against a float full-pass (e.g. 0.9999998) being misread as fail.
    return reward >= FULL_PASS_REWARD - 1e-9 ? "pass" : "fail";
  }
  if (typeof rTask === "number") {
    if (rTask > 0) return "pass";
    if (rTask < 0) return "fail";
  }
  return "unknown";
}

function verifierScore(raw: unknown): number {
  const { reward } = verifierStats(raw);
  return reward == null ? 0 : Math.min(1, Math.abs(reward));
}

function traceHint(trace: TraceRow): string {
  const parts = [
    trace.summary ? `summary=${cleanLine(trace.summary, 140)}` : null,
    trace.userText ? `user=${cleanLine(trace.userText, 140)}` : null,
    (() => {
      const refl = reflectionAsText(trace.reflection);
      return refl ? `note=${cleanLine(refl, 140)}` : null;
    })(),
  ];
  return parts.filter(Boolean).join(" | ");
}

/**
 * Build episode context for LLM refinement.
 * Strategy: include all traces (each abbreviated), keep chronological order,
 * drop lowest-value traces when over REFINE_MAX_CONTEXT_CHARS. PIVOTAL traces
 * (reflection label from capture, assigned before feedback refine) are never dropped.
 */
function buildEpisodeContext(
  episode: { id: EpisodeId; traceIds?: readonly TraceId[]; rTask?: number | null } | null | undefined,
  currentTrace: TraceRow | null,
  repos: Pick<Repos, "traces">,
  feedbackText: string,
): EpisodeContext {
  // Fallback: use current trace only
  if (!episode?.traceIds || episode.traceIds.length === 0) {
    if (currentTrace) {
      const block = formatTurn(1, currentTrace);
      return {
        userRequest: currentTrace.userText,
        agentResponse: currentTrace.agentText,
        fullContext: block,
        traceCount: 1,
        keptTraceCount: 1,
        droppedTraceCount: 0,
        contextChars: block.length,
      };
    }
    return {
      userRequest: "",
      agentResponse: "",
      fullContext: "",
      traceCount: 0,
      keptTraceCount: 0,
      droppedTraceCount: 0,
      contextChars: 0,
    };
  }

  // Fetch all traces
  const traces: TraceRow[] = [];
  for (const traceId of episode.traceIds) {
    const trace = repos.traces.getById(traceId as TraceId);
    if (trace) traces.push(trace);
  }

  if (traces.length === 0) {
    const block = currentTrace ? formatTurn(1, currentTrace) : "";
    return {
      userRequest: currentTrace?.userText ?? "",
      agentResponse: currentTrace?.agentText ?? "",
      fullContext: block,
      traceCount: currentTrace ? 1 : 0,
      keptTraceCount: currentTrace ? 1 : 0,
      droppedTraceCount: 0,
      contextChars: block.length,
    };
  }

  const selected = compressEpisodeTraces(traces, feedbackText, REFINE_MAX_CONTEXT_CHARS);
  const contextParts = selected.kept.map((item) =>
    formatTurn(item.idx + 1, item.trace),
  );
  const fullContext = contextParts.join("\n\n");
  const firstTurn = selected.kept[0]?.trace ?? traces[0];
  const lastTurn = selected.kept[selected.kept.length - 1]?.trace ?? traces[traces.length - 1];

  return {
    userRequest: lastTurn?.userText ?? "",
    agentResponse: lastTurn?.agentText ?? "",
    fullContext,
    traceCount: traces.length,
    keptTraceCount: selected.kept.length,
    droppedTraceCount: selected.droppedCount,
    contextChars: fullContext.length,
  };
}

function compressEpisodeTraces(
  traces: readonly TraceRow[],
  feedbackText: string,
  maxChars: number,
): {
  kept: Array<{ trace: TraceRow; idx: number; text: string; value: number }>;
  droppedCount: number;
} {
  const feedbackKeywords = extractFeedbackKeywords(feedbackText);
  const firstId = traces[0]?.id;
  const lastId = traces[traces.length - 1]?.id;
  const entries = traces.map((trace, idx) => {
    const text = formatTurn(idx + 1, trace);
    const value = traceInformationValue(trace, feedbackKeywords, firstId, lastId);
    return { trace, idx, text, value };
  });
  const kept = [...entries];
  let total = kept.reduce((sum, item) => sum + item.text.length, 0) + Math.max(0, kept.length - 1) * 2;
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
    total = kept.reduce((sum, item) => sum + item.text.length, 0) + Math.max(0, kept.length - 1) * 2;
  }
  kept.sort((a, b) => a.idx - b.idx);
  return { kept, droppedCount: entries.length - kept.length };
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

function formatTurn(turnNumber: number, trace: TraceRow): string {
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

function classifyLlmFallbackReason(err: unknown): Exclude<RefineFallbackReason, "llm_disabled" | "llm_missing_turn_context"> {
  if (MemosError.is(err)) {
    if (err.code === ERROR_CODES.LLM_TIMEOUT) return "llm_timeout";
    if (err.code === ERROR_CODES.LLM_OUTPUT_MALFORMED) return "llm_malformed";
    return "llm_error";
  }
  if (err instanceof Error && /timeout|timed out/i.test(err.message)) return "llm_timeout";
  return "llm_error";
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
