/**
 * Turn-relation classifier — V7 §0.1.
 *
 * Given the previous episode's `q_k` + `y_hat_k` and the **new** user
 * message `q_{k+1}`, decide which of three categories applies:
 *
 *   - `revision`  — correcting the previous answer (same task, same
 *                   episode). R_human back-propagates to existing
 *                   traces.
 *   - `follow_up` — same session, new sub-task (new episode).
 *   - `new_task`  — unrelated task (new session).
 *
 * Decision flow (improved from legacy `memos-local-openclaw` task-processor):
 *
 *   1. No previous context available             → `new_task` @ 0.75.
 *   2. Time gap > 2h                             → `new_task` @ 0.9.
 *   3. Heuristic rule fires with confidence ≥ 0.85 → use it.
 *   4. LLM available                              → `completeJson`.
 *   5. LLM returns `new_task` with confidence < 0.65 → arbitration pass.
 *   6. Heuristic fallback (any rule).
 *   7. Default `follow_up` @ 0.5 (safest middle ground per V7 §0.5).
 *
 * The classifier is pure wrt its dependencies — only the injected
 * `LlmClient` + heuristics. Unit tests stub both.
 */
import { ERROR_CODES, MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import { sanitizeDerivedText } from "../safety/content.js";
import type { RelationDecision, RelationInput, TurnRelation } from "./types.js";

// ─── Heuristic rules ─────────────────────────────────────────────────────

type Tag = "neg" | "quote" | "follow_phrase" | "new_phrase" | "domain_shift" | "pronoun_ref" | "time_gap";

interface Rule {
  id: string;
  label: string;
  kind: TurnRelation;
  confidence: number;
  test: (inp: RelationInput) => Tag | null;
}

// Negation patterns — match sentence-initial negations that clearly target
// the previous answer. Mid-sentence negations like "如果这个不对的话" are
// left to the LLM to disambiguate.
const NEG_PATTERNS = [
  /^不对/,
  /^错了/,
  /^重做/,
  /^改一下/,
  /^再来一次/,
  /^重新/,
  /^而不是/,
  /^\s*wrong\b/i,
  /^\s*incorrect\b/i,
  /^\s*not (what|quite|right|correct)\b/i,
  /^\s*no[,.]?\s+(that'?s\s+)?(wrong|incorrect|not right)/i,
  /^\s*redo\b/i,
  /^\s*try again\b/i,
];

const FOLLOW_PATTERNS = [
  /再(帮)?我/i,
  /下一个/i,
  /另一个类似/i,
  /\bnext\b/i,
  /\bthen\b/i,
  /\balso\b/i,
  /\banother (similar|one)\b/i,
  /\bmore of (that|this)\b/i,
];

const NEW_TASK_PATTERNS = [
  // Strict variant kept for backward compatibility.
  /换个(话题|问题|任务|主题|场景)/i,
  // Relaxed: allow 1–5 chars between "换个" and the topic noun, so
  // natural phrasings like "换个新任务", "换个下一个话题",
  // "换个完全不同的问题" all fire the strong heuristic without
  // bouncing through the LLM (which often overrules them as
  // follow_up when the new task shares a project / domain).
  /换个[^\s。,，！!?？]{1,6}(话题|问题|任务|主题|场景)/i,
  // "换下一个 / 换下个 ..." family.
  /换下(一)?个[^\s。,，！!?？]{0,6}(话题|问题|任务|主题|场景)?/i,
  // "下一个任务 / 下一个话题 ..." prefix family — matches when the
  // user opens a brand-new turn with an explicit ordinal cue.
  /^\s*下一?个(\S{0,5})?(话题|问题|任务|主题|场景)/i,
  // Other explicit Chinese cues.
  /现在(帮我)?处理另一个/i,
  /先放下/i,
  /忘掉之前/i,
  // English cues.
  /\bnew (task|question|topic|subject)\b/i,
  /\bforget (that|about it)\b/i,
  /\bchange (of )?(topic|subject|task)\b/i,
  /\bmoving on\b/i,
  /\bnext (task|topic|question)\b/i,
];

// Short message with pronoun reference — almost always a follow-up to the
// current topic. Ported from legacy `buildTopicJudgeState`.
const PRONOUN_REF_RE = /^[那这它其还哪啥]/;

const RULES: Rule[] = [
  // Direct negation at start of message → almost certainly revision.
  {
    id: "r1_negation_keyword",
    label: "negation keyword at start of turn",
    kind: "revision",
    confidence: 0.85,
    test: (inp) => (matchesAny(inp.newUserText.trim(), NEG_PATTERNS) ? "neg" : null),
  },
  // Quoting / referencing prev assistant output.
  {
    id: "r2_quotes_prev",
    label: "references previous assistant output",
    kind: "revision",
    confidence: 0.75,
    test: (inp) => {
      const prev = (inp.prevAssistantText ?? "").trim();
      if (prev.length < 20) return null;
      const prevWords = prev.split(/\s+/).filter((w) => w.length >= 3);
      if (prevWords.length < 8) return null;
      const nu = inp.newUserText.toLowerCase();
      for (let i = 0; i + 8 <= prevWords.length; i++) {
        const window = prevWords
          .slice(i, i + 8)
          .join(" ")
          .toLowerCase();
        if (window.length > 24 && nu.includes(window)) return "quote";
      }
      return null;
    },
  },
  // Short message with Chinese pronoun reference — strong follow-up signal.
  // Mirrors legacy: "那XX呢", "这个怎么办", "哪些啊" are almost always
  // follow-ups pointing to the current topic.
  {
    id: "r3_pronoun_ref",
    label: "short message with pronoun reference (那/这/它/其/还/哪/啥)",
    kind: "follow_up",
    confidence: 0.85,
    test: (inp) => {
      const text = inp.newUserText.trim();
      if (text.length > 60) return null;
      return PRONOUN_REF_RE.test(text) ? "pronoun_ref" : null;
    },
  },
  // Explicit follow-up language.
  {
    id: "r4_follow_phrase",
    label: "follow-up phrase ('再…' / 'also…' / 'next…')",
    kind: "follow_up",
    confidence: 0.8,
    test: (inp) => (matchesAny(inp.newUserText, FOLLOW_PATTERNS) ? "follow_phrase" : null),
  },
  // Explicit "new task" language.
  {
    id: "r5_new_phrase",
    label: "new-task phrase ('换个话题' / 'new topic' / 'forget that')",
    kind: "new_task",
    confidence: 0.85,
    test: (inp) => (matchesAny(inp.newUserText, NEW_TASK_PATTERNS) ? "new_phrase" : null),
  },
  // Large gap → lean toward new_task but NOT strong enough to bypass LLM.
  {
    id: "r6_time_gap",
    label: "time gap > 30min since previous episode",
    kind: "new_task",
    confidence: 0.6,
    test: (inp) => {
      const gap = inp.gapMs ?? 0;
      const GAP_THRESHOLD_MS = 30 * 60 * 1000;
      return gap > GAP_THRESHOLD_MS ? "time_gap" : null;
    },
  },
  // Domain shift — no tag overlap with the previous episode.
  {
    id: "r7_domain_shift",
    label: "no domain-tag overlap with previous episode",
    kind: "new_task",
    confidence: 0.55,
    test: (inp) => {
      if (!inp.prevTags || inp.prevTags.length === 0) return null;
      const nu = inp.newUserText.toLowerCase();
      const overlap = inp.prevTags.some((t) => nu.includes(t.toLowerCase()));
      return overlap ? null : "domain_shift";
    },
  },
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function ruleTiePriority(rule: Rule): number {
  switch (rule.id) {
    case "r5_new_phrase":
      return 40;
    case "r1_negation_keyword":
      return 30;
    case "r2_quotes_prev":
      return 20;
    case "r3_pronoun_ref":
      return 10;
    default:
      return 0;
  }
}

// ─── Strong heuristic threshold ──────────────────────────────────────────

const STRONG_HEURISTIC_THRESHOLD = 0.85;

// ─── Idle timeout (mirrors legacy 2h hard-split) ─────────────────────────

const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// ─── Low-confidence new_task threshold for arbitration ───────────────────
//
// Raised from 0.65 → 0.8 so the LLM has to be quite sure (confidence ≥ 0.8)
// before its `new_task` verdict is taken at face value. Anything below that
// goes through the second-pass arbitration prompt (which is biased toward
// follow_up). Real-world observation: the primary classifier often returns
// `new_task` at 0.65–0.75 for messages that are actually sub-tasks of the
// same project — pulling the cut-off up reduces false topic splits at the
// cost of one extra LLM call on borderline turns.
const ARBITRATION_THRESHOLD = 0.8;

// ─── Public factory ──────────────────────────────────────────────────────

export interface RelationClassifierOptions {
  llm?: LlmClient;
  timeoutMs?: number;
  /** Skip LLM path (tests / offline mode). */
  disableLlm?: boolean;
}

export interface RelationClassifier {
  classify(input: RelationInput): Promise<RelationDecision>;
}

export function createRelationClassifier(
  opts: RelationClassifierOptions = {},
): RelationClassifier {
  const log = rootLogger.child({ channel: "core.session.relation" });
  const llmDisabled = opts.disableLlm ?? !opts.llm;
  const timeoutMs = opts.timeoutMs ?? 6_000;

  return {
    async classify(input: RelationInput): Promise<RelationDecision> {
      const newText = (input.newUserText ?? "").trim();
      if (!newText) {
        return mkDecision("unknown", 0, "empty message", ["empty"]);
      }
      // No prior context: first turn of the session.
      if (!input.prevUserText) {
        return mkDecision(
          "new_task",
          0.75,
          "no previous episode in this session",
          ["bootstrap"],
        );
      }

      // Hard split: idle > 2h, matching legacy taskIdleTimeoutMs.
      const gap = input.gapMs ?? 0;
      if (gap > IDLE_TIMEOUT_MS) {
        log.info("idle_timeout", { gapMs: gap, thresholdMs: IDLE_TIMEOUT_MS });
        return mkDecision(
          "new_task",
          0.9,
          `idle ${Math.round(gap / 60_000)}min > 120min threshold`,
          ["idle_timeout"],
        );
      }

      // Step 1: strongest heuristic.
      const fired: { rule: Rule; tag: Tag }[] = [];
      for (const rule of RULES) {
        const tag = rule.test(input);
        if (tag) fired.push({ rule, tag });
      }
      if (fired.length > 0) {
        fired.sort(
          (a, b) =>
            b.rule.confidence - a.rule.confidence ||
            ruleTiePriority(b.rule) - ruleTiePriority(a.rule),
        );
        const top = fired[0];
        if (top.rule.confidence >= STRONG_HEURISTIC_THRESHOLD) {
          log.debug("heuristic.strong", {
            ruleId: top.rule.id,
            kind: top.rule.kind,
            confidence: top.rule.confidence,
          });
          return mkDecision(
            top.rule.kind,
            top.rule.confidence,
            top.rule.label,
            [top.rule.id],
          );
        }
      }

      // Step 2: LLM classification.
      if (!llmDisabled && opts.llm) {
        try {
          const result = await withTimeout(callLlm(opts.llm, input), timeoutMs, "relation.llm.timeout");
          log.debug("llm.ok", {
            relation: result.relation,
            confidence: result.confidence,
          });

          // Step 3: Two-pass arbitration for low-confidence new_task.
          // Ported from legacy `arbitrateTopicSplit` — if the primary
          // classifier says NEW but isn't very sure, run a second prompt
          // biased toward SAME to reduce false splits.
          if (
            result.relation === "new_task" &&
            result.confidence < ARBITRATION_THRESHOLD
          ) {
            log.info("arbitration.triggered", {
              confidence: result.confidence,
              threshold: ARBITRATION_THRESHOLD,
            });
            try {
              const arb = await withTimeout(
                callArbitration(opts.llm, input),
                timeoutMs,
                "relation.arbitration.timeout",
              );
              log.info("arbitration.result", { relation: arb });
              if (arb !== "new_task") {
                const signals = ["llm", "arbitration_override"];
                if (fired.length > 0) signals.push(...fired.map((f) => `heuristic:${f.rule.id}(weak)`));
                return {
                  relation: "follow_up",
                  confidence: clamp01(0.55),
                  reason: "arbitration overrode low-confidence new_task → follow_up",
                  signals,
                  llmModel: result.servedBy,
                };
              }
            } catch (err) {
              log.warn("arbitration.failed", { err: summarizeErr(err) });
              // Arbitration failed — downgrade to follow_up to be safe.
              const signals = ["llm", "arbitration_failed_fallback"];
              return {
                relation: "follow_up",
                confidence: clamp01(0.5),
                reason: "arbitration failed; defaulting low-confidence new_task → follow_up",
                signals,
                llmModel: result.servedBy,
              };
            }
          }

          const signals = ["llm"];
          if (fired.length > 0) signals.push(...fired.map((f) => `heuristic:${f.rule.id}(weak)`));
          return {
            relation: result.relation,
            confidence: clamp01(result.confidence),
            reason: result.reason.slice(0, 120),
            signals,
            llmModel: result.servedBy,
          };
        } catch (err) {
          log.warn("llm.failed", { err: summarizeErr(err) });
        }
      }

      // Step 4: heuristic fallback (highest-confidence rule, even if weak).
      if (fired.length > 0) {
        const top = fired[0];
        return mkDecision(
          top.rule.kind,
          top.rule.confidence,
          `${top.rule.label} (fallback)`,
          [top.rule.id, "llm_skipped"],
        );
      }

      // Step 5: default — safest middle ground.
      return mkDecision(
        "follow_up",
        0.5,
        "no classifier signal; defaulting to follow_up",
        ["default_follow_up"],
      );
    },
  };
}

// ─── Private helpers ─────────────────────────────────────────────────────

function mkDecision(
  relation: TurnRelation,
  confidence: number,
  reason: string,
  signals: string[],
): RelationDecision {
  return {
    relation,
    confidence: clamp01(confidence),
    reason: reason.slice(0, 120),
    signals,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function summarizeErr(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
}

// ─── LLM path ────────────────────────────────────────────────────────────

const ALLOWED: TurnRelation[] = ["revision", "follow_up", "new_task", "unknown"];

interface LlmRelationAnswer {
  relation: TurnRelation;
  confidence: number;
  reason: string;
  servedBy: string;
}

// Prompt incorporates the legacy `TOPIC_JUDGE_PROMPT`'s detailed rules and
// Chinese examples, plus the V7 revision/follow_up/new_task vocabulary.
const RELATION_SYSTEM = `You classify how a NEW user message relates to the previous conversation turn.

Return ONE of:
  - "revision"  — user is correcting / refining the PREVIOUS answer (same task).
  - "follow_up" — continuing, following up, refining, or asking about the SAME topic/domain.
  - "new_task"  — COMPLETELY UNRELATED domain/topic.
  - "unknown"   — truly ambiguous.

Return JSON ONLY:
{
  "relation": one of the four labels,
  "confidence": number in [0, 1],
  "reason": short justification (≤ 80 chars)
}

## follow_up (SAME topic) — the new message:
- Continues, follows up on, refines, or corrects the same subject/project/task
- Asks a clarification or next-step question about what was just discussed
- Reports a result, error, or feedback about the current task
- Discusses different tools or approaches for the SAME goal (e.g., learning English via BBC → via ChatGPT = follow_up)
- Is a short acknowledgment (ok, thanks, 好的) in response to the current flow
- Contains pronouns or references (那, 这, 它, 其中, 哪些, those, which, what about, etc.) pointing to items from the current conversation
- Asks about a sub-topic, tool, detail, dimension, or aspect of the current discussion topic
- Shares the same core entity (person, company, event) even if the specific detail or angle differs

## revision — the new message:
- Contains negation directed at the previous answer ("不对", "wrong", "not quite")
- Quotes or references the previous answer's specifics to correct them
- Adds a constraint that only makes sense as a correction to the previous output

## new_task — the new message:
- Introduces a subject from a COMPLETELY DIFFERENT domain (e.g., tech → cooking, work → personal life)
- Has NO logical connection to what was being discussed — no shared entities, events, or themes
- Starts a request about a different project, system, or life area

## Key principles:
- DEFAULT to follow_up unless the topic domain CLEARLY changed. When in doubt, choose follow_up.
- CRITICAL: Short messages (under ~30 chars) that use pronouns or ask "what about X" / "哪些" / "那XX呢" are almost always follow_up. Only mark them new_task if they explicitly name a completely unrelated domain.
- Different aspects of the SAME project/system are follow_up (e.g., Nginx SSL → Nginx gzip = follow_up)
- Asking about tools, systems, or methods for the current topic is follow_up
- If unsure, lean follow_up with low confidence rather than unknown.

## Examples:
- "配置Nginx" → "加gzip压缩" = follow_up
- "港股调研" → "那处理系统有哪些" = follow_up
- "部署服务器" → "那数据库怎么配" = follow_up
- "配置Nginx" → "做红烧肉" = new_task
- "部署服务器" → "年会安排" = new_task
- "不对，应该用443端口" = revision
- "wrong, use port 443 instead" = revision`;

/**
 * Build the user-content block for the primary LLM call.
 *
 * For short / pronoun-heavy messages, we append extra assistant context
 * so the LLM can judge whether the user is referencing the current
 * topic — mirrors legacy `buildTopicJudgeState` which appends `lastA:`
 * for messages < 30 chars or starting with 那/这/它.
 */
function buildLlmUserContent(input: RelationInput): string {
  const prevUser = (input.prevUserText ?? "").slice(0, 800);
  const prevAssistant = (input.prevAssistantText ?? "").slice(0, 1500);
  const newUser = input.newUserText.slice(0, 800);

  const parts = [
    `PREVIOUS_USER_MESSAGE:\n${prevUser}`,
    `PREVIOUS_ASSISTANT_REPLY:\n${prevAssistant}`,
    `NEW_USER_MESSAGE:\n${newUser}`,
  ];

  // For short or pronoun-referencing messages, add extra assistant context
  // so the LLM sees what the user might be referencing.
  const trimmed = input.newUserText.trim();
  if (trimmed.length < 30 || PRONOUN_REF_RE.test(trimmed)) {
    if (prevAssistant.length > 200) {
      parts.push(`NOTE: The new message is very short and may reference the assistant's previous reply above. Consider it a follow_up unless it names a completely unrelated domain.`);
    }
  }

  return parts.join("\n\n");
}

async function callLlm(llm: LlmClient, input: RelationInput): Promise<LlmRelationAnswer> {
  const userContent = buildLlmUserContent(input);

  const rsp = await llm.completeJson<{ relation: unknown; confidence: unknown; reason: unknown }>(
    [
      { role: "system", content: RELATION_SYSTEM },
      { role: "user", content: userContent },
    ],
    {
      op: "session.relation.classify",
      phase: "session",
      episodeId: input.prevEpisodeId,
      schemaHint: `{"relation":"revision"|"follow_up"|"new_task"|"unknown","confidence":0..1,"reason":"..."}`,
      validate: (v) => {
        const o = v as Record<string, unknown>;
        if (typeof o.relation !== "string" || !ALLOWED.includes(o.relation as TurnRelation)) {
          throw new MemosError(
            ERROR_CODES.LLM_OUTPUT_MALFORMED,
            "relation out of vocabulary",
            { got: o.relation },
          );
        }
        if (typeof o.confidence !== "number") {
          throw new MemosError(
            ERROR_CODES.LLM_OUTPUT_MALFORMED,
            "confidence must be a number",
            { got: o.confidence },
          );
        }
        if (typeof o.reason !== "string") {
          throw new MemosError(
            ERROR_CODES.LLM_OUTPUT_MALFORMED,
            "reason must be a string",
            { got: o.reason },
          );
        }
      },
      malformedRetries: 1,
      temperature: 0,
    },
  );
  return {
    relation: rsp.value.relation as TurnRelation,
    confidence: rsp.value.confidence as number,
    reason: sanitizeDerivedText(rsp.value.reason),
    servedBy: rsp.servedBy,
  };
}

// ─── Arbitration pass (two-pass confirmation) ────────────────────────────
//
// Ported from legacy `TOPIC_ARBITRATION_PROMPT`. When the primary LLM
// returns new_task with low confidence (< 0.65), this second prompt
// re-evaluates with a bias toward SAME, reducing false splits.

const ARBITRATION_SYSTEM = `A classifier flagged this message as possibly a new, unrelated topic (low confidence).
Is it truly UNRELATED, or a sub-question/follow-up of the current conversation?

Tools/methods/details/sub-aspects of the current task = follow_up.
Shared entity/theme/project = follow_up.
Entirely different domain with zero connection = new_task.
When in doubt, choose follow_up.

Reply JSON ONLY: {"relation":"follow_up"|"new_task","reason":"..."}`;

async function callArbitration(llm: LlmClient, input: RelationInput): Promise<TurnRelation> {
  const userContent = [
    `CURRENT TASK CONTEXT:\n${(input.prevUserText ?? "").slice(0, 600)}`,
    `ASSISTANT REPLY:\n${(input.prevAssistantText ?? "").slice(0, 800)}`,
    `NEW MESSAGE:\n${input.newUserText.slice(0, 600)}`,
  ].join("\n\n");

  const rsp = await llm.completeJson<{ relation: unknown; reason: unknown }>(
    [
      { role: "system", content: ARBITRATION_SYSTEM },
      { role: "user", content: userContent },
    ],
    {
      op: "session.relation.arbitrate",
      phase: "session",
      episodeId: input.prevEpisodeId,
      schemaHint: `{"relation":"follow_up"|"new_task","reason":"..."}`,
      validate: (v) => {
        const o = v as Record<string, unknown>;
        if (typeof o.relation !== "string" || !["follow_up", "new_task"].includes(o.relation as string)) {
          throw new MemosError(
            ERROR_CODES.LLM_OUTPUT_MALFORMED,
            "arbitration relation must be follow_up or new_task",
            { got: o.relation },
          );
        }
      },
      malformedRetries: 1,
      temperature: 0,
    },
  );
  return rsp.value.relation as TurnRelation;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new MemosError(ERROR_CODES.LLM_TIMEOUT, label, { timeoutMs: ms })),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exposed for audit / frontend display. */
export function listRelationRules(): ReadonlyArray<{
  id: string;
  kind: TurnRelation;
  label: string;
}> {
  return RULES.map((r) => ({ id: r.id, kind: r.kind, label: r.label }));
}
