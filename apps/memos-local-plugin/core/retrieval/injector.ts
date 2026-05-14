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
  ExperienceCandidate,
  RankedSnippet,
  SkillCandidate,
  TierCandidate,
  TraceCandidate,
  WorldModelCandidate,
} from "./types.js";

const MAX_SNIPPET_BODY_CHARS = 640;
const DEFAULT_SKILL_SUMMARY_CHARS = 200;
const MEMORY_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "shortOffset",
});

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
   * `"summary"` — a short descriptor + `memos_skill_get(id="…")` invocation
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
  for (const r of suppressExperiencesCoveredBySkills(input.ranked)) {
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

function suppressExperiencesCoveredBySkills(
  ranked: readonly RankedCandidate[],
): RankedCandidate[] {
  const covered = new Set<string>();
  for (const r of ranked) {
    const c = r.candidate;
    if (c.refKind !== "skill") continue;
    for (const id of (c as SkillCandidate).sourcePolicyIds ?? []) {
      covered.add(id);
    }
  }
  if (covered.size === 0) return [...ranked];
  return ranked.filter((r) => {
    const c = r.candidate;
    if (c.refKind !== "experience") return true;
    if (!covered.has(c.refId)) return true;
    const experienceUpdatedAt = (c as ExperienceCandidate).updatedAt ?? 0;
    const coveringSkill = ranked.find((slot) => {
      const sk = slot.candidate;
      return (
        sk.refKind === "skill" &&
        ((sk as SkillCandidate).sourcePolicyIds ?? []).includes(c.refId)
      );
    })?.candidate as SkillCandidate | undefined;
    return Boolean(
      coveringSkill?.updatedAt && experienceUpdatedAt > coveringSkill.updatedAt,
    );
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
      if (c.refKind === "trace") return renderTrace(c as TraceCandidate);
      if (c.refKind === "experience") {
        return renderExperience(c as ExperienceCandidate);
      }
      return renderEpisode(c as EpisodeCandidate);
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
 * and a `memos_skill_get(id="…")` hint. The host model can call that tool on
 * demand to fetch the full procedure — keeps prompts small and avoids
 * paying for skills the agent never needs.
 *
 * **Full mode**: legacy behaviour, the entire `invocationGuide` body is
 * inlined. Hosts without tool-calling support need this.
 */
function renderSkill(c: SkillCandidate, opts: RenderOpts): InjectionSnippet {
  if (opts.skillMode === "full") {
    const body = truncate(
      `Skill: ${c.skillName}\n` + c.invocationGuide.trim(),
    );
    return {
      refKind: "skill",
      refId: c.refId,
      title: c.skillName,
      body,
    };
  }

  const description = firstLineSummary(c.invocationGuide, opts.skillSummaryChars);
  const lines: string[] = [
    `Name: ${c.skillName}`,
    `Description: ${description || "(not provided)"}`,
  ];
  lines.push(
    `→ call \`memos_skill_get(id="${c.refId}")\` to load the full procedure if you decide to use it`,
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
  const body = withToolFollowUp(
    truncate(parts.join("\n")),
    `→ call \`memos_get(id="${c.refId}", kind="trace")\` for the full turn`,
  );
  const when = formatMemoryTimestamp(c.ts);
  return {
    refKind: "trace",
    refId: c.refId,
    title: `Trace · ${when}`,
    body,
  };
}

function renderEpisode(c: EpisodeCandidate): InjectionSnippet {
  // Episode summary already comes with step-by-step action sequence
  // (see tier2-trace.ts::renderEpisodeSummary). Keep prompt-facing text
  // free of retrieval metrics; they are useful for logs, not for answers.
  const body = withToolFollowUp(
    truncate(stripEpisodePromptMetrics(c.summary)),
    `→ call \`memos_timeline(episodeId="${c.refId}")\` for the full step-by-step traces`,
  );
  const when = formatMemoryTimestamp(c.ts);
  return {
    refKind: "episode",
    refId: c.refId,
    title: `Past task · ${when}`,
    body,
  };
}

function stripEpisodePromptMetrics(summary: string): string {
  return summary
    .replace(
      /^episode\s+\d+\s+steps\s*·\s*best\s+V=[+-]?\d+(?:\.\d+)?\s*·\s*goal-sim=[+-]?\d+(?:\.\d+)?/i,
      "Past similar episode",
    )
    .replace(/\bstep\s+(\d+)\s+\(V=[+-]?\d+(?:\.\d+)?\)/gi, "step $1");
}

function renderExperience(c: ExperienceCandidate): InjectionSnippet {
  const parts = [
    c.trigger ? `Trigger: ${c.trigger}` : null,
    c.procedure ? `Do: ${c.procedure}` : null,
    c.decisionGuidance.antiPattern.length > 0
      ? `Avoid: ${c.decisionGuidance.antiPattern.join("; ")}`
      : null,
    c.boundary ? `Scope: ${c.boundary}` : null,
    c.verification ? `Check: ${c.verification}` : null,
  ].filter(Boolean);
  return {
    refKind: "experience",
    refId: c.refId,
    title: c.title,
    body: withToolFollowUp(
      truncate(parts.join("\n")),
      `→ call \`memos_get(id="${c.refId}", kind="policy")\` for the full experience`,
    ),
  };
}

function renderWorldModel(c: WorldModelCandidate): InjectionSnippet {
  const body = withToolFollowUp(
    truncate(`World model: ${c.title}\n${c.body}`),
    `→ call \`memos_get(id="${c.refId}", kind="world_model")\` for the full environment knowledge`,
  );
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
 * ### Similar Past Tasks
 *
 * 1. [Past task · 2026-03-05 10:12]
 *    Past similar episode
 *    step 1 …
 *
 * ### Relevant Trace Memories
 *
 * 1. [Trace · 2026-03-05 10:12]
 *    [user] 我喜欢的运动是游泳
 *    [assistant] 记住了。
 *
 * ## Skills
 *
 * 1. Python dependency fix
 *    When container pip fails, install -dev OS lib first …
 *
 * Available follow-up tools:
 * - call `memos_search(query=...)` for a shorter, more targeted query
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
  const episodes = snippets.filter((s) => s.refKind === "episode");
  const traces = snippets.filter((s) => s.refKind === "trace");
  const experiences = snippets.filter((s) => s.refKind === "experience");
  const worlds = snippets.filter((s) => s.refKind === "world-model");

  if (skills.length > 0) {
    if (opts.skillMode === "summary") {
      // In summary mode, frame the section as "candidate skills you can
      // call". The bodies already carry the per-skill `memos_skill_get(...)`
      // hint, so the agent knows how to expand them on demand.
      parts.push(
        "## Candidate skills (call `memos_skill_get` to load any you decide to use)\n",
      );
    } else {
      parts.push("## Skills\n");
    }
    skills.forEach((s, i) => {
      parts.push(renderNumberedSnippet(s, i + 1));
    });
  }

  parts.push(...renderMemoriesSection(episodes, traces));

  if (experiences.length > 0) {
    parts.push("## Experiences\n");
    experiences.forEach((s, i) => {
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

  parts.push(footerFor(opts.skillMode, snippets));
  return parts.join("\n\n");
}

function renderMemoriesSection(
  episodes: readonly InjectionSnippet[],
  traces: readonly InjectionSnippet[],
): string[] {
  if (episodes.length === 0 && traces.length === 0) return [];

  const parts: string[] = ["## Memories"];
  if (episodes.length > 0) {
    parts.push("### Similar Past Tasks");
    episodes.forEach((s, i) => {
      parts.push(renderNumberedSnippet(s, i + 1));
    });
  }
  if (traces.length > 0) {
    parts.push("### Relevant Trace Memories");
    traces.forEach((s, i) => {
      parts.push(renderNumberedSnippet(s, i + 1));
    });
  }
  return parts;
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
  const block = [`${n}. ${title}`, s.body]
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

const FOOTER_LINES_SEARCH: readonly string[] = [
  "- `memos_search(query, maxResults?)` — re-query with a shorter / rephrased string",
];

const FOOTER_LINES_SKILL_SUMMARY: readonly string[] = [
  "- `memos_skill_get(id)` — load the full procedure/verification of a candidate skill listed above",
];

const FOOTER_LINES_TIMELINE: readonly string[] = [
  "- `memos_timeline(episodeId, limit?)` — expand a similar past task into step-by-step traces",
];

const FOOTER_LINES_TRACE_GET: readonly string[] = [
  "- `memos_get(id, kind=\"trace\")` — fetch a full trace turn by id",
];

const FOOTER_LINES_POLICY_GET: readonly string[] = [
  "- `memos_get(id, kind=\"policy\")` — fetch a full experience by id",
];

const FOOTER_LINES_WORLD_MODEL: readonly string[] = [
  "- `memos_get(id, kind=\"world_model\")` — fetch full environment knowledge by id",
];

function footerFor(
  skillMode: SkillInjectionMode,
  snippets: readonly InjectionSnippet[],
): string {
  const kinds = new Set(snippets.map((s) => s.refKind));
  const lines: string[] = ["Available follow-up tools:"];
  if (skillMode === "summary" && kinds.has("skill")) {
    lines.push(...FOOTER_LINES_SKILL_SUMMARY);
  }
  if (kinds.has("episode")) {
    lines.push(...FOOTER_LINES_TIMELINE);
  }
  if (kinds.has("trace")) {
    lines.push(...FOOTER_LINES_TRACE_GET);
  }
  if (kinds.has("experience")) {
    lines.push(...FOOTER_LINES_POLICY_GET);
  }
  if (kinds.has("world-model")) {
    lines.push(...FOOTER_LINES_WORLD_MODEL);
  }
  lines.push(...FOOTER_LINES_SEARCH);
  return lines.join("\n");
}

function withToolFollowUp(body: string, hint: string): string {
  if (!hint) return body;
  return body ? `${body}\n${hint}` : hint;
}

function indentBlock(s: string): string {
  return s
    .split("\n")
    .map((line) => (line ? "   " + line : line))
    .join("\n")
    .replace(/^ {3}/, ""); // first line flush with the bullet number
}

function formatMemoryTimestamp(ts: number): string {
  const parts = MEMORY_TIME_FORMATTER.formatToParts(new Date(ts));
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
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
