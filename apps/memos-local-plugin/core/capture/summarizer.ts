/**
 * Capture-side trace summarizer — produces the short, viewer-friendly
 * summary string that ends up in `traces.summary` and (downstream) in
 * the Memories panel / retrieval snippets.
 *
 * Design mirrors `memos-local-openclaw`'s `Summarizer`:
 *
 *   - Ask the configured LLM for a single-sentence distillation.
 *   - If the LLM is unavailable, times out, or returns malformed JSON,
 *     fall back to a deterministic heuristic so capture never blocks.
 *
 * The summary is what downstream retrieval embeds (see
 * `core/capture/embedder.ts::summaryText`) and what the Memories
 * viewer shows as the primary row text. Keeping it short (≤ 140
 * chars) keeps the viewer skim-able and the prompt-injection block
 * small.
 */

import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import type { Logger } from "../logger/types.js";
import type { NormalizedStep } from "./types.js";

const MAX_SUMMARY_CHARS = 140;
const MAX_INPUT_CHARS = 3_500;

export interface SummarizerOptions {
  llm: LlmClient | null;
  log?: Logger;
  timeoutMs?: number;
}

export interface Summarizer {
  summarize(step: NormalizedStep): Promise<string>;
}

/**
 * Build a summarizer bound to the provided LLM client. When `llm` is
 * null the returned summarizer uses the heuristic path only — capture
 * still works, just with a more verbose summary.
 */
export function createSummarizer(opts: SummarizerOptions): Summarizer {
  const log = opts.log ?? rootLogger.child({ channel: "core.capture.summarizer" });
  const timeoutMs = opts.timeoutMs ?? 8_000;

  async function summarize(step: NormalizedStep): Promise<string> {
    // Heuristic first pass — a safety net both when the LLM is off
    // and as the input we re-anchor the LLM call against (so even if
    // the LLM returns garbage we still have a sensible string).
    const heuristic = heuristicSummary(step);
    if (!opts.llm) return heuristic;

    try {
      const result = await withTimeout(
        opts.llm.completeJson<{ summary?: unknown }>(
          [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: buildUserPrompt(step),
            },
          ],
          {
            op: "capture.summarize",
            schemaHint: '{"summary":"..."}',
            validate: (v) => {
              const s = (v as { summary?: unknown }).summary;
              if (typeof s !== "string" || s.trim().length === 0) {
                throw new Error("summary missing or empty");
              }
            },
            malformedRetries: 1,
            temperature: 0,
          },
        ),
        timeoutMs,
      );
      const llmSummary = String((result?.value as { summary?: string })?.summary ?? "").trim();
      if (!llmSummary) return heuristic;
      return clampLength(llmSummary, MAX_SUMMARY_CHARS);
    } catch (err) {
      log.debug("summarize.fallback", {
        err: err instanceof Error ? err.message : String(err),
      });
      return heuristic;
    }
  }

  return { summarize };
}

// ─── Prompts ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You condense a single agent/user exchange into ONE short memory line.

Rules:
- Output MUST be a single JSON object: { "summary": "..." }
- The summary must be ≤ 100 characters, in the user's original language.
- Focus on the *fact worth remembering next time* — a preference, a name, a
  decision, a file path, an error signature, an answer that was confirmed.
- Do NOT prefix with "The user said" / "用户说了". Just state the fact.
- Do NOT quote whole sentences. Compress.
- If nothing is worth remembering, still produce a short summary (e.g. the
  main topic of the exchange) — never return an empty string.`;

function buildUserPrompt(step: NormalizedStep): string {
  const parts: string[] = [];
  if (step.userText) parts.push(`USER:\n${clampLength(step.userText, 1_400)}`);
  if (step.agentText) parts.push(`ASSISTANT:\n${clampLength(step.agentText, 1_400)}`);
  if (step.toolCalls.length > 0) {
    const toolSig = step.toolCalls
      .map((t) => `${t.name}(${shortInput(t.input)})`)
      .join("; ");
    parts.push(`TOOLS:\n${clampLength(toolSig, 400)}`);
  }
  if (step.rawReflection) {
    parts.push(`REFLECTION:\n${clampLength(step.rawReflection, 300)}`);
  }
  return clampLength(parts.join("\n\n"), MAX_INPUT_CHARS);
}

function shortInput(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.slice(0, 120);
  try {
    return JSON.stringify(v).slice(0, 120);
  } catch {
    return String(v).slice(0, 120);
  }
}

// ─── Heuristic fallback ────────────────────────────────────────────────────

function heuristicSummary(step: NormalizedStep): string {
  const user = (step.userText ?? "").trim();
  const assistant = (step.agentText ?? "").trim();
  // Prefer the user's line — that's what they'll recognise in the
  // Memories panel. Fall back to the assistant's reply when we only
  // have an agent-initiated turn (subagent, recall probe, etc.).
  const base = user || assistant || "(empty turn)";
  return clampLength(oneLine(base), MAX_SUMMARY_CHARS);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clampLength(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`summarize timeout ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
