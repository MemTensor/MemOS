/**
 * Snippet renderer.
 *
 * Converts `RankedCandidate`s into `InjectionSnippet` values + a single
 * rendered `InjectionPacket`. Adapters may walk `snippets` themselves or
 * just splice `rendered` verbatim into the host prompt.
 *
 * The rendering is intentionally plain-text (Markdown headings) — we don't
 * know yet how each adapter (OpenClaw vs Hermes) will format its prompt
 * section, so we stick to a neutral shape that they can either tweak or
 * wrap.
 */

import type {
  EpisodeId,
  EpochMs,
  InjectionPacket,
  InjectionSnippet,
  RetrievalReason,
  SessionId,
} from "../../agent-contract/dto.js";
import { ids } from "../id.js";
import type { CollectedGuidance } from "./decision-guidance.js";
import type { RankedCandidate } from "./ranker.js";
import type {
  EpisodeCandidate,
  RankedSnippet,
  SkillCandidate,
  TierCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "./types.js";

const MAX_SNIPPET_BODY_CHARS = 640;
const DEFAULT_SKILL_SUMMARY_CHARS = 200;

export type SkillInjectionMode = "summary" | "full";

export interface InjectorInput {
  ranked: readonly RankedCandidate[];
  reason: RetrievalReason;
  tierLatencyMs: { tier1: number; tier2: number; tier3: number };
  now: EpochMs;
  /**
   * Required so the packet can be correlated with `onTurnEnd` /
   * decision-repair calls on the adapter side. When we add a retrieval
   * entry point that has no session context (e.g. a CLI preview),
   * synthesise an id before calling.
   */
  sessionId: SessionId;
  episodeId: EpisodeId;
  /**
   * How Tier-1 skill candidates should be rendered. Defaults to
   * `"summary"` — a short descriptor + `skill_get(id="…")` invocation
   * hint, so the host model decides whether to pull the full guide.
   */
  skillInjectionMode?: SkillInjectionMode;
  /** Per-skill summary char cap when `skillInjectionMode === "summary"`. */
  skillSummaryChars?: number;
  /**
   * V7 §2.4.6 — preference / anti-pattern collected from policies that
   * share evidence with the retrieved traces / skills. Rendered as a
   * dedicated "Decision guidance" section so the agent reads it BEFORE
   * choosing its next action. Empty (default) means no guidance was
   * found for the current retrieval — the section is then omitted.
   */
  decisionGuidance?: CollectedGuidance;
}

export interface InjectorResult {
  packet: InjectionPacket;
  /** One-to-one with `packet.snippets`, carrying the debug origin. */
  mapping: RankedSnippet[];
}

export function toPacket(input: InjectorInput): InjectorResult {
  const skillMode: SkillInjectionMode = input.skillInjectionMode ?? "summary";
  const skillSummaryChars =
    input.skillSummaryChars ?? DEFAULT_SKILL_SUMMARY_CHARS;
  const mapping: RankedSnippet[] = [];
  for (const r of input.ranked) {
    const snippet = renderSnippet(r.candidate, {
      skillMode,
      skillSummaryChars,
    });
    if (!snippet) continue;
    snippet.score = round(r.score, 4);
    mapping.push({
      snippet,
      tier: r.candidate.tier,
      relevance: r.relevance,
      finalScore: r.score,
      origin: r.candidate,
    });
  }
  const snippets = mapping.map((m) => m.snippet);
  const rendered = renderWholePacket(snippets, input.reason, {
    skillMode,
    decisionGuidance: input.decisionGuidance,
  });

  const packet: InjectionPacket = {
    reason: input.reason,
    snippets,
    rendered,
    tierLatencyMs: input.tierLatencyMs,
    packetId: ids.span(), // short opaque id for logs/events
    ts: input.now,
    sessionId: input.sessionId,
    episodeId: input.episodeId,
  };
  return { packet, mapping };
}

/**
 * Public snippet renderer used by `llm-filter.ts` when it needs to
 * surface the LLM-dropped candidates back on the packet (for the Logs
 * page's `droppedByLlm` list). Reuses the same renderer as the
 * injected packet so the two views stay visually consistent.
 *
 * Skills are always rendered in `summary` mode here — the dropped list
 * is purely informational and we don't want oversized guides eating the
 * Logs view either.
 */
export function renderSnippetForDebug(c: TierCandidate): InjectionSnippet | null {
  return renderSnippet(c, {
    skillMode: "summary",
    skillSummaryChars: DEFAULT_SKILL_SUMMARY_CHARS,
  });
}

// ─── Per-candidate renderers ────────────────────────────────────────────────

interface RenderOpts {
  skillMode: SkillInjectionMode;
  skillSummaryChars: number;
}

function renderSnippet(c: TierCandidate, opts: RenderOpts): InjectionSnippet | null {
  switch (c.tier) {
    case "tier1":
      return renderSkill(c as SkillCandidate, opts);
    case "tier2":
      return c.refKind === "trace"
        ? renderTrace(c as TraceCandidate)
        : renderEpisode(c as EpisodeCandidate);
    case "tier3":
      return renderWorldModel(c as WorldModelCandidate);
    default:
      return null;
  }
}

/**
 * Render a Tier-1 Skill candidate.
 *
 * **Summary mode** (default): the prompt only carries a 1-line teaser
 * and a `skill_get(id="…")` hint. The host model can call that tool on
 * demand to fetch the full procedure — keeps prompts small and avoids
 * paying for skills the agent never needs.
 *
 * **Full mode**: legacy behaviour, the entire `invocationGuide` body is
 * inlined. Hosts without tool-calling support need this.
 */
function renderSkill(c: SkillCandidate, opts: RenderOpts): InjectionSnippet {
  if (opts.skillMode === "full") {
    const body = truncate(
      `Skill: ${c.skillName} (η=${c.eta.toFixed(2)})\n` + c.invocationGuide.trim(),
    );
    return {
      refKind: "skill",
      refId: c.refId,
      title: c.skillName,
      body,
    };
  }

  const summary = firstLineSummary(c.invocationGuide, opts.skillSummaryChars);
  const lines = [
    `${c.skillName} — η=${c.eta.toFixed(2)}, status=${c.status}`,
  ];
  if (summary) lines.push(summary);
  lines.push(
    `→ call \`skill_get(id="${c.refId}")\` to load the full procedure if you decide to use it`,
  );
  return {
    refKind: "skill",
    refId: c.refId,
    title: c.skillName,
    body: lines.join("\n"),
  };
}

/**
 * Pull a single-line summary from a Skill `invocationGuide`. Strategy:
 * take the first non-empty paragraph, collapse whitespace, drop common
 * markdown headings, then clamp to `maxChars`.
 */
function firstLineSummary(guide: string, maxChars: number): string {
  const trimmed = guide.trim();
  if (!trimmed) return "";
  // Split on blank line — first paragraph is the description.
  const para = trimmed.split(/\n\s*\n/)[0] ?? trimmed;
  // Strip leading "### Trigger:" / "Procedure:" style headings on
  // each line so the summary doesn't start mid-rubric.
  const cleaned = para
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars - 1) + "…";
}

function renderTrace(c: TraceCandidate): InjectionSnippet {
  // LLM-focused shape. When we have an LLM-generated summary, lead
  // with it — the summary was deliberately compressed to "the fact
  // worth remembering", so it's the most prompt-budget-efficient
  // form. Then attach the raw turn text as backup so the model can
  // disambiguate pronouns, names, and anything the summary elided.
  const parts: string[] = [];
  const summaryLine = c.summary?.trim();
  if (summaryLine) parts.push(summaryLine);
  if (c.userText) parts.push(`[user] ${c.userText}`);
  if (c.agentText) parts.push(`[assistant] ${c.agentText}`);
  if (c.reflection) parts.push(`[note] ${c.reflection}`);
  const body = truncate(parts.join("\n"));
  const when = new Date(c.ts).toISOString().slice(0, 16).replace("T", " ");
  return {
    refKind: "trace",
    refId: c.refId,
    title: `Trace · ${when}`,
    body,
  };
}

function renderEpisode(c: EpisodeCandidate): InjectionSnippet {
  // Episode summary already comes with step-by-step action sequence
  // (see tier2-trace.ts::renderEpisodeSummary), so we drop the raw
  // V-score prefix and hand the summary through as-is.
  const body = truncate(c.summary);
  const when = new Date(c.ts).toISOString().slice(0, 16).replace("T", " ");
  return {
    refKind: "episode",
    refId: c.refId,
    title: `Sub-task · ${when}`,
    body,
  };
}

function renderWorldModel(c: WorldModelCandidate): InjectionSnippet {
  const body = truncate(`World model: ${c.title}\n${c.body}`);
  return {
    refKind: "world-model",
    refId: c.refId,
    title: c.title,
    body,
  };
}

// ─── Whole-packet renderer ──────────────────────────────────────────────────

/**
 * Render the whole retrieval packet as a prompt-prependable block.
 *
 * Format (LLM-actionable, mirrors the legacy `memos-local-openclaw`
 * adapter so downstream prompts see the same shape):
 *
 * ```
 * # User's conversation history (from memory system)
 *
 * IMPORTANT: The following are facts from previous conversations with
 * this user. You MUST treat these as established knowledge and use them
 * directly when answering. Do NOT say you don't know if the answer is
 * in these memories.
 *
 * ## Memories
 *
 * 1. [Trace · 2026-03-05 10:12]
 *    [user] 我喜欢的运动是游泳
 *    [assistant] 记住了。
 *    refId="trace_xyz"
 *
 * ## Skills
 *
 * 1. [Skill · Python dependency fix] (η=0.82)
 *    When container pip fails, install -dev OS lib first …
 *    refId="skill_abc"
 *
 * Available follow-up tools:
 * - call `memory_search(query=...)` for a shorter, more targeted query
 * - call `memory_timeline(episodeId=...)` to expand an episode
 * ```
 *
 * We deliberately keep the "IMPORTANT" instructions — without them the
 * LLM tends to ignore the block and answers from its own parameters.
 */
function renderWholePacket(
  snippets: readonly InjectionSnippet[],
  reason: RetrievalReason,
  opts: { skillMode: SkillInjectionMode; decisionGuidance?: CollectedGuidance },
): string {
  const guidanceBlock = renderDecisionGuidance(opts.decisionGuidance);
  if (snippets.length === 0 && !guidanceBlock) return "";

  const header = HEADER_BY_REASON[reason] ?? HEADER_BY_REASON.turn_start;
  const parts: string[] = [header];

  const skills = snippets.filter((s) => s.refKind === "skill");
  const traces = snippets.filter(
    (s) => s.refKind === "trace" || s.refKind === "episode",
  );
  const worlds = snippets.filter((s) => s.refKind === "world-model");

  if (skills.length > 0) {
    if (opts.skillMode === "summary") {
      // In summary mode, frame the section as "candidate skills you can
      // call". The bodies already carry the per-skill `skill_get(...)`
      // hint, so the agent knows how to expand them on demand.
      parts.push(
        "## Candidate skills (call `skill_get` to load any you decide to use)\n",
      );
    } else {
      parts.push("## Skills\n");
    }
    skills.forEach((s, i) => {
      parts.push(renderNumberedSnippet(s, i + 1));
    });
  }

  if (traces.length > 0) {
    parts.push("## Memories\n");
    traces.forEach((s, i) => {
      parts.push(renderNumberedSnippet(s, i + 1));
    });
  }

  if (worlds.length > 0) {
    parts.push("## Environment Knowledge\n");
    worlds.forEach((s, i) => {
      parts.push(renderNumberedSnippet(s, i + 1));
    });
  }

  // V7 §2.4.6 — surface decision guidance LAST so it sits immediately
  // before the available-tools footer. The agent has already read the
  // facts (Memories, Skills, Environment); now we prime it with
  // "preferred / avoided" lines distilled from past failures + fixes.
  if (guidanceBlock) parts.push(guidanceBlock);

  parts.push(footerFor(opts.skillMode, skills.length > 0));
  return parts.join("\n\n");
}

/**
 * Render the V7 §2.4.6 "Decision guidance" section. Returns `null` when
 * no preference / anti-pattern lines were collected — the caller skips
 * the heading entirely so prompts stay tidy.
 *
 * Format mirrors the surrounding sections (Markdown heading + numbered
 * list) so the agent perceives it as part of the same memory packet,
 * not a foreign block.
 */
function renderDecisionGuidance(g: CollectedGuidance | undefined): string | null {
  if (!g) return null;
  if (g.preference.length === 0 && g.antiPattern.length === 0) return null;

  const lines: string[] = [
    "## Decision guidance (distilled from past similar situations)",
    "",
    "Apply these BEFORE choosing your next action. Each line was learned",
    "from one or more past episodes where the user told us what to prefer",
    "or avoid in this kind of context.",
  ];
  if (g.preference.length > 0) {
    lines.push("", "**Prefer**");
    g.preference.forEach((p, i) => {
      lines.push(`  ${i + 1}. ${p.text}`);
    });
  }
  if (g.antiPattern.length > 0) {
    lines.push("", "**Avoid**");
    g.antiPattern.forEach((a, i) => {
      lines.push(`  ${i + 1}. ${a.text}`);
    });
  }
  return lines.join("\n");
}

function renderNumberedSnippet(s: InjectionSnippet, n: number): string {
  const title = s.title ?? s.refId;
  const block = [`${n}. ${title}`, s.body, `   refId="${s.refId}"`]
    .filter(Boolean)
    .join("\n");
  return indentBlock(block);
}

const HEADER_BY_REASON: Record<RetrievalReason, string> = {
  turn_start:
    "# User's conversation history (from memory system)\n\n" +
    "IMPORTANT: The following are facts from previous conversations with this user.\n" +
    "You MUST treat these as established knowledge and use them directly when answering.\n" +
    "Do NOT say you don't know or don't have information if the answer is in these memories.",
  tool_driven:
    "# Memory search results\n\n" +
    "The memory tool returned the following hits. They are ranked by relevance.",
  skill_invoke:
    "# Invoked skill\n\n" +
    "Follow the procedure below; the verification step tells you when you're done.",
  sub_agent:
    "# Parent-agent context\n\n" +
    "Relevant memory surfaced for this sub-agent's mission.",
  decision_repair:
    "# Decision repair — please read before your next action\n\n" +
    "You have failed this tool multiple times in a row. Below are preferred / avoided actions\n" +
    "distilled from similar past situations. Please adapt your plan accordingly.",
};

const FOOTER_LINES_COMMON: readonly string[] = [
  "- `memory_search(query, maxResults?)` — re-query with a shorter / rephrased string",
  "- `memory_get(id, kind?)` — fetch a full trace / policy / world-model body by refId",
  "- `memory_timeline(episodeId, limit?)` — expand an episode into its step-by-step traces",
];

const FOOTER_LINES_SKILL_SUMMARY: readonly string[] = [
  "- `skill_get(id)` — load the full procedure/verification of a candidate skill listed above",
  "- `skill_list(status?, limit?)` — browse other crystallised skills not yet shown",
];

function footerFor(
  skillMode: SkillInjectionMode,
  hasSkills: boolean,
): string {
  const lines: string[] = ["Available follow-up tools:"];
  if (skillMode === "summary" && hasSkills) {
    lines.push(...FOOTER_LINES_SKILL_SUMMARY);
  }
  lines.push(...FOOTER_LINES_COMMON);
  return lines.join("\n");
}

function indentBlock(s: string): string {
  return s
    .split("\n")
    .map((line) => (line ? "   " + line : line))
    .join("\n")
    .replace(/^ {3}/, ""); // first line flush with the bullet number
}

function truncate(s: string): string {
  if (s.length <= MAX_SNIPPET_BODY_CHARS) return s;
  const head = s.slice(0, MAX_SNIPPET_BODY_CHARS - 16);
  return `${head}\n...[truncated]`;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
