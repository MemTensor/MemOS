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
import type { NormalizedStep } from "./types.js";

const SYSTEM = `You are reviewing a single step of an AI agent's decision.

Write a first-person reflection from the agent's perspective explaining WHY
it produced this response / tool calls given the user input. Keep it to
2–4 sentences, concrete, avoid repeating the visible action.

If the step is empty or incoherent, return exactly:  NO_REFLECTION`;

export interface SynthesizedReflection {
  text: string | null;
  model: string;
}

export async function synthesizeReflection(
  llm: LlmClient,
  step: NormalizedStep,
): Promise<SynthesizedReflection> {
  const log = rootLogger.child({ channel: "core.capture.reflection" });

  const thinking = (step.agentThinking ?? "").trim();
  const userPayload = [
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
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const rsp = await llm.complete(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: userPayload },
      ],
      { op: "capture.reflection.synth", temperature: 0.1 },
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
