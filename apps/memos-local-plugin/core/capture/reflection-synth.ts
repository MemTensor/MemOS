/**
 * `reflection-synth` — optionally ask the LLM to WRITE a reflection when
 * the agent turn contained none. Off by default (costly).
 *
 * This is strictly a fallback path; the extractor runs first.
 *
 * The prompt is deliberately minimal — we don't want the LLM to grade or
 * judge (that's `alpha-scorer`), just to produce a first-person
 * "here's what I was trying to do" summary. The α scorer gets the next
 * crack and can still mark it unusable.
 */

import { MemosError } from "../../agent-contract/errors.js";
import type { LlmClient } from "../llm/index.js";
import { rootLogger } from "../logger/index.js";
import { sanitizeDerivedText } from "../safety/content.js";
import type { NormalizedStep, ReflectionContext } from "./types.js";

const SYSTEM = `You are reviewing a single step of an AI agent's decision.

Write a first-person reflection from the agent's perspective explaining WHY
it produced this response / tool calls given the user input. Keep it to
2–4 sentences, concrete, avoid repeating the visible action.

If the step is empty or incoherent, return exactly:  NO_REFLECTION`;

export interface SynthesizedReflection {
  text: string | null;
  model: string;
}

export interface ReflectionSynthContext extends ReflectionContext {
  episodeId?: string;
  phase?: string;
  outcomeMaxChars?: number;
}

export async function synthesizeReflection(
  llm: LlmClient,
  step: NormalizedStep,
  context?: ReflectionSynthContext,
): Promise<SynthesizedReflection> {
  const log = rootLogger.child({ channel: "core.capture.reflection" });

  const thinking = (step.agentThinking ?? "").trim();
  const userPayload = [
    `TASK CONTEXT:`,
    context?.taskSummary?.trim().slice(0, 1_200) || "(none)",
    ``,
    `USER/OBSERVATION:`,
    step.userText.slice(0, 1_200) || "(none)",
    ``,
    `THINKING (model's native chain-of-thought, if any):`,
    thinking ? thinking.slice(0, 1_500) : "(none)",
    ``,
    `AGENT ACTION:`,
    step.agentText.slice(0, 1_500) || "(none)",
    step.toolCalls.length > 0
      ? `\nTOOL CALLS:\n${step.toolCalls
          .map((t) =>
            t.errorCode
              ? `- ${t.name}(${safeStringify(t.input).slice(0, 400)}) → ERROR[${t.errorCode}]`
              : `- ${t.name}(${safeStringify(t.input).slice(0, 400)})`,
          )
          .join("\n")}`
      : "",
    ``,
    `OUTCOME:`,
    lastToolOutcome(step, context?.outcomeMaxChars ?? 600),
    ``,
    `DOWNSTREAM STEP PREVIEW:`,
    formatDownstreamPreview(context),
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const rsp = await llm.complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPayload },
      ],
      {
        op: "capture.reflection.synth",
        episodeId: context?.episodeId,
        phase: context?.phase,
        temperature: 0.1,
      },
    );
    const raw = sanitizeDerivedText(rsp.text);
    if (raw === "" || raw === "NO_REFLECTION") {
      log.debug("synth.no_reflection", { key: step.key });
      return { text: null, model: rsp.servedBy };
    }
    return { text: raw.slice(0, 1_500), model: rsp.servedBy };
  } catch (err) {
    log.warn("synth.failed", { key: step.key, err: errDetail(err) });
    return { text: null, model: "none" };
  }
}

function errDetail(err: unknown): Record<string, unknown> {
  if (err instanceof MemosError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { value: String(err) };
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

function lastToolOutcome(step: NormalizedStep, maxChars: number): string {
  const last = step.toolCalls[step.toolCalls.length - 1];
  if (!last) return "(assistant-only step)";
  return (last.errorCode ? `ERROR[${last.errorCode}] ` : "") + truncate(outputOf(last), maxChars);
}

function outputOf(t: { output?: unknown }): string {
  if (t.output === undefined || t.output === null) return "";
  if (typeof t.output === "string") return t.output;
  try {
    return JSON.stringify(t.output);
  } catch {
    return String(t.output);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function formatDownstreamPreview(context?: ReflectionSynthContext): string {
  const preview = context?.downstream ?? [];
  if (preview.length === 0) return "(none)";
  return preview
    .map((item) => {
      const label = `step+${item.offset}`;
      if (item.kind === "tooluse") {
        const lines = [
          `[${label}] type=tooluse`,
          `tool_names: ${item.toolNames?.join(", ") || "(unknown)"}`,
          `tool_output: ${item.toolOutput?.trim() || "(none)"}`,
        ];
        if (item.reflection?.trim()) {
          lines.push(`existing_reflection: ${item.reflection.trim()}`);
        }
        return lines.join("\n");
      }
      return [`[${label}] type=text`, item.text?.trim() || "(empty)"].join("\n");
    })
    .join("\n\n");
}
