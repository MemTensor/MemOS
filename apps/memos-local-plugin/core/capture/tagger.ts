/**
 * Heuristic trace tagger.
 *
 * V7 §2.6 — "每条 trace 带有自动标注的领域标签（如 docker、pip、plugin），
 * 先按标签缩小候选集，再做语义匹配，减少检索开销。"
 *
 * We keep this cheap and deterministic (no LLM here). Tags are lowercased,
 * deduped and capped in length so they can be stored inline in
 * `traces.tags_json` and matched via `instr()`.
 *
 * Sources, in order of confidence:
 *
 *   1. Tool names       — e.g. `docker.run` → `docker`, `pip.install` → `pip`.
 *   2. Tool error codes — e.g. `E_NETWORK` → `network`.
 *   3. Agent text       — keyword dictionary (docker, database, kubernetes…).
 *
 * If more precise tagging is needed later (e.g. LLM-based intent classifier
 * in capture) it can replace this module without touching retrieval.
 */

import type { ScoredStep } from "./types.js";

const MAX_TAGS = 8;
const MAX_TAG_LEN = 32;

/** Two-char-or-less tokens never make useful tags. */
const MIN_TAG_LEN = 3;

/**
 * Common agent-text keywords worth surfacing as domain tags. Keep this list
 * small — the goal is coverage of "universal" tools, not an exhaustive
 * ontology. Extendable via config in later phases.
 */
const KEYWORD_TAGS: ReadonlyArray<{ re: RegExp; tag: string }> = [
  { re: /\bdocker\b|\bcontainer\b/i, tag: "docker" },
  { re: /\bkubernetes\b|\bkubectl\b|\bk8s\b/i, tag: "kubernetes" },
  { re: /\bpip\b|\bpip install\b|\brequirements\.txt\b/i, tag: "pip" },
  { re: /\bnpm\b|\byarn\b|\bpnpm\b|\bpackage\.json\b/i, tag: "npm" },
  { re: /\bsqlite\b|\bpostgres\b|\bpostgresql\b|\bmysql\b|\bdatabase\b/i, tag: "database" },
  { re: /\bsql\b|\bselect\s|\binsert\s/i, tag: "sql" },
  { re: /\bshell\b|\bbash\b|\bzsh\b|\bterminal\b/i, tag: "shell" },
  { re: /\bgit\b|\bcommit\b|\bmerge\b|\bbranch\b/i, tag: "git" },
  { re: /\bpython\b|\.py\b/i, tag: "python" },
  { re: /\btypescript\b|\.ts\b|\.tsx\b/i, tag: "typescript" },
  { re: /\bjavascript\b|\.js\b|\.jsx\b/i, tag: "javascript" },
  { re: /\brust\b|\bcargo\b|\.rs\b/i, tag: "rust" },
  { re: /\bplugin\b/i, tag: "plugin" },
  { re: /\bapi\b|\brest\b|\bhttp\b/i, tag: "http" },
  { re: /network|\bdns\b|\bproxy\b/i, tag: "network" },
  { re: /\bauth(entication|orization)?\b|\btoken\b|\boauth\b/i, tag: "auth" },
  { re: /\btest\b|\bunit test\b|\bjest\b|\bvitest\b|\bpytest\b/i, tag: "test" },
  { re: /\berror\b|\bexception\b|\btraceback\b|\bstack trace\b/i, tag: "error" },
];

/**
 * Derive tags for a single scored step. The resulting array is sorted and
 * deduped (lowercase), capped at `MAX_TAGS` entries.
 */
export function tagsForStep(step: ScoredStep): string[] {
  const bag = new Set<string>();

  // 1. Tool names → first segment before dot or underscore.
  for (const tc of step.toolCalls) {
    const name = typeof tc?.name === "string" ? tc.name.trim() : "";
    if (!name) continue;
    const head = name
      .toLowerCase()
      .split(/[.:/_-]/)[0]!
      .replace(/[^a-z0-9+]/g, "");
    pushTag(bag, head);
  }

  // 2. Error codes stored in tool-call results → last token after `_`.
  for (const tc of step.toolCalls) {
    const err = typeof tc?.errorCode === "string" ? tc.errorCode : undefined;
    if (!err) continue;
    const parts = err
      .toLowerCase()
      .split(/[_:./-]/)
      .filter(Boolean);
    for (const p of parts) {
      if (p === "e" || p === "err" || p === "error") continue;
      pushTag(bag, p);
    }
  }

  // 3. Keyword dictionary on agent + user text.
  const haystack = `${step.agentText ?? ""}\n${step.userText ?? ""}`;
  for (const { re, tag } of KEYWORD_TAGS) {
    if (bag.has(tag)) continue;
    if (re.test(haystack)) pushTag(bag, tag);
    if (bag.size >= MAX_TAGS) break;
  }

  return [...bag].sort().slice(0, MAX_TAGS);
}

/** Merge tag sets from many steps into a coarse "episode-level" tag set. */
export function tagsForEpisode(steps: readonly ScoredStep[]): string[] {
  const bag = new Set<string>();
  for (const s of steps) {
    for (const t of tagsForStep(s)) bag.add(t);
    if (bag.size >= MAX_TAGS * 2) break;
  }
  return [...bag].sort().slice(0, MAX_TAGS * 2);
}

function pushTag(bag: Set<string>, raw: string): void {
  const t = raw.trim().toLowerCase();
  if (t.length < MIN_TAG_LEN || t.length > MAX_TAG_LEN) return;
  if (!/^[a-z0-9][a-z0-9+]*$/.test(t)) return;
  bag.add(t);
}
