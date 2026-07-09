/**
 * Rule-based fast path for `IntentClassifier`.
 *
 * Each rule is a pure function (text) → HeuristicMatch | null so the
 * classifier can report exactly which rules fired ("signals"). Callers
 * that want to inspect decisions (the frontend viewer, audit logs) get a
 * traceable reason.
 *
 * The rules here are intentionally conservative — they only fire on
 * obvious cases. The hybrid classifier escalates ambiguous input to
 * an LLM when one is configured.
 */

import type { IntentKind } from "./types.js";

export interface HeuristicRule {
  id: string;
  kind: IntentKind;
  confidence: number;
  /** Short label for logs / frontend badges. */
  label: string;
  match(text: string): boolean;
}

export interface HeuristicMatch {
  rule: HeuristicRule;
  kind: IntentKind;
  confidence: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const cjk = /[\u4E00-\u9FFF\u3400-\u4DBF]/;

function normalize(t: string): string {
  return t.trim();
}

function wordCount(t: string): number {
  if (cjk.test(t)) {
    // Approx: treat each CJK char as a "word" (search tokens are char-level).
    return Array.from(t).filter((c) => cjk.test(c) || /\w/.test(c)).length;
  }
  return t.split(/\s+/).filter(Boolean).length;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

// 1. Meta-command (plugin control). These must never leak into retrieval.
const metaCommand: HeuristicRule = {
  id: "meta.command_prefix",
  kind: "meta",
  confidence: 0.98,
  label: "/memos command",
  match(t) {
    return /^\s*\/(memos|memory|memo)\b/i.test(t);
  },
};

// 2. Chitchat openers with no content.
const chitchatGreeting: HeuristicRule = {
  id: "chitchat.greeting",
  kind: "chitchat",
  confidence: 0.9,
  label: "greeting",
  match(t) {
    const s = normalize(t).toLowerCase();
    if (s.length > 48) return false;
    // English greetings + "thanks" / "ok".
    if (/^(hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice)[\s!.?]*$/.test(s)) {
      return true;
    }
    // Chinese greetings (no final period required).
    if (/^(你好|在吗|在不在|谢谢|谢啦|好的|收到|ok 的|好啊)[\s!。？]*$/.test(s)) {
      return true;
    }
    return false;
  },
};

// 3. Memory probes — user explicitly references past context.
const memoryProbe: HeuristicRule = {
  id: "memory.past_reference",
  kind: "memory_probe",
  confidence: 0.88,
  label: "past-context query",
  match(t) {
    const s = t.trim();
    const en = /\b(what did (i|we) (say|discuss|talk|mention)|do you remember|last time|earlier we|previously we|we talked about)/i;
    if (en.test(s)) return true;
    // Chinese doesn't use word boundaries; match directly.
    if (/(我们(刚刚|之前|刚才)?(聊|说|讨论)过|你还记得|上次(?:我们)?|之前(?:我|我们|咱们)?(提|说|聊|讨论))/.test(s)) {
      return true;
    }
    // Memory verbs alone are also a good signal.
    if (/(回忆|回顾|总结(一下)?我们|帮我(想|回忆))/.test(s)) return true;
    return false;
  },
};

// 4. Task cues — imperative mood + tool-ish verbs. Not strict; just a hint.
const taskImperative: HeuristicRule = {
  id: "task.imperative_verb",
  kind: "task",
  confidence: 0.75,
  label: "imperative verb",
  match(t) {
    const s = t.trim();
    if (/^(please|pls)\s+/i.test(s)) return true;
    if (/^(write|build|create|fix|debug|run|install|refactor|add|remove|delete|generate|set up|analyze|review|test|deploy|implement|translate|explain)\b/i.test(s)) return true;
    if (/^(帮(我)?|请|麻烦|给我|替我)\s*(写|做|生成|实现|修复|调试|运行|安装|部署|优化|重构|添加|删除|查看|检查|分析|翻译)/.test(s)) return true;
    return false;
  },
};

// 5. Long free-form text → likely task. Short questions → ambiguous.
const longFreeformTask: HeuristicRule = {
  id: "task.long_freeform",
  kind: "task",
  confidence: 0.6,
  label: "long free-form",
  match(t) {
    // More than ~40 words / 60 CJK chars is rarely chitchat.
    return wordCount(t) >= 40;
  },
};

// Curated registry, order matters: the first match wins. "meta" always
// goes first; long-freeform is the weakest catch-all.
export const HEURISTIC_RULES: HeuristicRule[] = [
  metaCommand,
  chitchatGreeting,
  memoryProbe,
  taskImperative,
  longFreeformTask,
];

export function matchFirst(text: string, rules = HEURISTIC_RULES): HeuristicMatch | null {
  const t = normalize(text);
  if (t.length === 0) return null;
  for (const rule of rules) {
    if (rule.match(t)) {
      return { rule, kind: rule.kind, confidence: rule.confidence };
    }
  }
  return null;
}

/**
 * Pure utility — derive the retrieval-tier flags from an intent kind. Exposed
 * so non-classifier callers (tests, adapters that hardcode one kind) can stay
 * in sync with the classifier's own wiring.
 */
export function retrievalFor(kind: IntentKind): { tier1: boolean; tier2: boolean; tier3: boolean } {
  switch (kind) {
    case "task":
      return { tier1: true, tier2: true, tier3: true };
    case "memory_probe":
      return { tier1: true, tier2: true, tier3: false };
    case "chitchat":
      return { tier1: false, tier2: false, tier3: false };
    case "meta":
      return { tier1: false, tier2: false, tier3: false };
    case "unknown":
    default:
      // Fall through to full retrieval: missing memory is worse than extra cost.
      return { tier1: true, tier2: true, tier3: true };
  }
}
