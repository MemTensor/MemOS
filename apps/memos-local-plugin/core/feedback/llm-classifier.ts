/**
 * LLM-assisted feedback classifier.
 *
 * Detects implicit user feedback that rule-based patterns miss:
 *   - "应该用递归实现" (implicit: current approach is wrong)
 *   - "能不能改成异步的" (implicit: sync version is inadequate)
 *   - "这样性能不好" (implicit: needs optimization)
 *
 * Decision flow:
 *   1. Rule-based fast path (strong markers) → immediate feedback
 *   2. LLM deep analysis (when available) → detect implicit feedback
 *   3. Fallback to rule-based classification
 *
 * The LLM call is optional and degrades gracefully when unavailable.
 */

import type { EpisodeId } from "../../agent-contract/dto.js";
import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";

const log = rootLogger.child({ channel: "core.feedback.llm-classifier" });

export interface FeedbackClassification {
  /** Whether this turn contains actionable user feedback. */
  isFeedback: boolean;
  /** Feedback polarity: positive, negative, neutral, or mixed. */
  polarity: "positive" | "negative" | "neutral" | "mixed";
  /** Feedback strength (0-1). */
  magnitude: number;
  /** Confidence in this classification (0-1). */
  confidence: number;
  /** Human-readable rationale extracted from user text. */
  rationale: string;
  /** Classification method: "rule" or "llm". */
  method: "rule" | "llm";
}

export interface FeedbackClassifierOptions {
  llm?: LlmClient;
  timeoutMs?: number;
  disableLlm?: boolean;
}

export interface ClassifyTurnInput {
  userText: string;
  agentText: string;
  episodeId?: EpisodeId;
}

export interface FeedbackClassifier {
  classifyTurn(input: ClassifyTurnInput): Promise<FeedbackClassification>;
}

/**
 * Create a feedback classifier that uses both rules and LLM.
 */
export function createFeedbackClassifier(
  opts: FeedbackClassifierOptions = {},
): FeedbackClassifier {
  const llmDisabled = opts.disableLlm ?? !opts.llm;
  const llm = opts.llm;
  const timeoutMs = opts.timeoutMs ?? 4_000;

  return {
    async classifyTurn(input: ClassifyTurnInput): Promise<FeedbackClassification> {
      const userText = (input.userText ?? "").trim();
      const agentText = (input.agentText ?? "").trim();

      if (!userText) {
        return noFeedback("empty user text", "rule");
      }

      // Step 1: Rule-based fast path for strong signals
      const ruleResult = classifyByRules(userText);
      if (ruleResult.confidence >= 0.8) {
        log.debug("rule.strong", {
          isFeedback: ruleResult.isFeedback,
          polarity: ruleResult.polarity,
          confidence: ruleResult.confidence,
        });
        return ruleResult;
      }

      // Step 2: LLM deep analysis when available
      if (!llmDisabled && llm && agentText) {
        try {
          const llmResult = await withTimeout(
            classifyByLlm(llm, userText, agentText, input.episodeId),
            timeoutMs,
          );
          log.debug("llm.ok", {
            isFeedback: llmResult.isFeedback,
            polarity: llmResult.polarity,
            magnitude: llmResult.magnitude,
            confidence: llmResult.confidence,
          });
          return llmResult;
        } catch (err) {
          log.warn("llm.failed", {
            err: err instanceof Error ? err.message : String(err),
          });
          // Fall through to rule-based fallback
        }
      }

      // Step 3: Fallback to rule-based classification
      log.debug("rule.fallback", {
        isFeedback: ruleResult.isFeedback,
        confidence: ruleResult.confidence,
      });
      return ruleResult;
    },
  };
}

// ─── Rule-based classification ──────────────────────────────────────────────

function classifyByRules(userText: string): FeedbackClassification {
  const lower = userText.toLowerCase();

  // Strong positive markers
  if (
    /\b(perfect|great|awesome|excellent|works|fixed|correct)\b/.test(lower) ||
    /^(yes|ok|okay|sure|thanks?)[.!?]?\s*$/.test(lower) ||
    /好的|太棒了|不错|完美|搞定|对的|正确/.test(lower)
  ) {
    return {
      isFeedback: true,
      polarity: "positive",
      magnitude: 0.8,
      confidence: 0.85,
      rationale: userText,
      method: "rule",
    };
  }

  // Strong negative markers (correction)
  if (
    /不对|错了|不是|不行|写错了|做错了|理解错了/.test(lower) ||
    /\b(wrong|incorrect|not right|not correct|that'?s wrong|this is wrong)\b/.test(lower)
  ) {
    return {
      isFeedback: true,
      polarity: "negative",
      magnitude: 0.9,
      confidence: 0.85,
      rationale: userText,
      method: "rule",
    };
  }

  // Verifier feedback markers
  if (
    /本任务评为(反例|正例)/.test(lower) ||
    /verifier feedback|verification feedback/.test(lower) ||
    /r\s*[<>=≤≥]+\s*-?\d+(\.\d+)?/.test(lower)
  ) {
    const isPositive = /正例|r\s*>=\s*0\.5|passed|success/.test(lower);
    return {
      isFeedback: true,
      polarity: isPositive ? "positive" : "negative",
      magnitude: 1.0,
      confidence: 0.95,
      rationale: userText,
      method: "rule",
    };
  }

  // Weak correction signals (should, avoid, next time)
  if (
    /\b(should|avoid|don'?t|next time|instead)\b/.test(lower) ||
    /应该|不要|下次|别|改成|换成/.test(lower)
  ) {
    return {
      isFeedback: true,
      polarity: "negative",
      magnitude: 0.6,
      confidence: 0.65,
      rationale: userText,
      method: "rule",
    };
  }

  // No feedback detected
  return noFeedback("no rule match", "rule");
}

function noFeedback(reason: string, method: "rule" | "llm"): FeedbackClassification {
  return {
    isFeedback: false,
    polarity: "neutral",
    magnitude: 0,
    confidence: 0.9,
    rationale: reason,
    method,
  };
}

// ─── LLM-based classification ───────────────────────────────────────────────

async function classifyByLlm(
  llm: LlmClient,
  userText: string,
  agentText: string,
  episodeId?: EpisodeId,
): Promise<FeedbackClassification> {
  const prompt = buildClassificationPrompt(userText, agentText);

  const response = await llm.complete(
    [{ role: "user", content: prompt }],
    {
      temperature: 0.1,
      maxTokens: 200,
      episodeId,
      op: "feedback.classify",
    },
  );

  const text = response.text.trim();
  return parseLlmResponse(text, userText);
}

function buildClassificationPrompt(userText: string, agentText: string): string {
  return `You are analyzing a conversation turn to detect user feedback.

Agent's previous response:
"""
${agentText.slice(0, 800)}
"""

User's current message:
"""
${userText}
"""

Does the user's message contain actionable feedback about the agent's response?

Feedback includes:
- Corrections: "That's wrong", "不对", "应该是X不是Y"
- Preferences: "Use X instead", "改用Y", "下次用Z"
- Implicit corrections: "应该用递归", "能不能改成异步的", "这样性能不好"
- Approval: "Perfect", "好的", "Works"
- Rejection: "No", "不行", "Stop"

NOT feedback:
- Follow-up questions: "What about X?", "Can you also..."
- Acknowledgments without evaluation: "OK, continue", "I see"
- New requests unrelated to previous response

Output format (JSON):
{
  "isFeedback": true/false,
  "polarity": "positive" | "negative" | "neutral" | "mixed",
  "magnitude": 0.0-1.0,
  "confidence": 0.0-1.0,
  "rationale": "brief explanation"
}

JSON:`;
}

function parseLlmResponse(
  text: string,
  userText: string,
): FeedbackClassification {
  try {
    // Extract JSON from markdown code blocks if present
    const jsonMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      throw new Error("No JSON found in LLM response");
    }

    const parsed = JSON.parse(jsonMatch[1]);

    return {
      isFeedback: Boolean(parsed.isFeedback),
      polarity: parsed.polarity || "neutral",
      magnitude: clamp(Number(parsed.magnitude) || 0, 0, 1),
      confidence: clamp(Number(parsed.confidence) || 0.5, 0, 1),
      rationale: String(parsed.rationale || userText).slice(0, 500),
      method: "llm",
    };
  } catch (err) {
    log.warn("llm.parse_failed", {
      err: err instanceof Error ? err.message : String(err),
      text: text.slice(0, 200),
    });
    throw new Error("Failed to parse LLM response");
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    ),
  ]);
}
