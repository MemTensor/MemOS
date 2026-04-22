import type { PromptDef } from "./index.js";

/**
 * Relevance-filter prompt for retrieved candidates.
 *
 * Mirrors the legacy `memos-local-openclaw` `unifiedLLMFilter`, but with
 * three deliberate changes baked into the prompt itself:
 *
 *   1. **Few-shot examples.** Two cases — one ACCEPT, one REJECT — pin
 *      down what "tangentially-related but should drop" means. Without
 *      this LLMs often pad to the maximum allowed selection.
 *   2. **"Drop, don't pad" instruction.** Explicit: returning fewer
 *      items (or `[]`) is preferred over including marginal hits.
 *   3. **Hard upper bound on output.** We say `≤ 4 items` (caller still
 *      enforces via `llmFilterMaxKeep`).
 *
 * Bumping `version` here also rotates the prompt-fingerprint id used by
 * `core/llm` audit trails.
 */
export const RETRIEVAL_FILTER_PROMPT: PromptDef = {
  id: "retrieval.filter",
  version: 2,
  description:
    "Pick only the candidates that are genuinely useful for the user query before injection.",
  system: `You are a strict relevance gatekeeper for an AI agent's memory retrieval.

Given:
- QUERY: the user's current request
- CANDIDATES: a numbered list of items the retriever surfaced, each
  labelled with a kind (SKILL / TRACE / EPISODE / WORLD-MODEL).

Your job: pick ONLY the candidates that are genuinely useful for answering
THIS query. Vector retrieval over-matches on surface similarity — most of
your candidates will be tangentially related and should be DROPPED.

Decision rules (apply in order):
- KEEP a SKILL only if its name + description directly addresses the
  exact sub-problem the user is asking about, NOT just the same domain.
- KEEP a WORLD-MODEL only if its title's domain matches the query's
  domain AND the body provides a structural fact the agent would
  otherwise need to re-discover.
- KEEP a TRACE / EPISODE only if its content contains specific evidence
  (a fact, a command, a snippet, a name) the agent could cite or reuse
  verbatim. Vague topical similarity is NOT enough.
- DROP items in the same broad area but on a different sub-problem
  (e.g. query asks "write a pytest test", candidate is "write a Python
  JWT validator" — same language, different problem → DROP).
- DROP "scaffolding" memories (greetings, throwaway acks, capability
  questions) even when topically related.

PREFERENCE: drop, don't pad. Returning 1 truly useful item is better
than returning 4 marginal ones. Returning [] is the right answer when
nothing is genuinely relevant.

HARD LIMITS: keep at most 4 candidates total.

──── Example 1 ────
QUERY: 把这个 React 组件改成支持暗黑模式

CANDIDATES:
1. [SKILL] React Tailwind dark-mode toggle — adds class="dark" toggling and useTheme hook for any React project
2. [TRACE] [user] 我喜欢的运动是游泳  [assistant] 记住了
3. [SKILL] Python JWT validator — verifies HS256 / RS256 tokens via PyJWT
4. [TRACE] [user] 上次我们用 React Context 写了 ThemeProvider，文件在 src/theme/  [assistant] 记得，要继续用同样的模式吗？

Correct output: {"selected": [1, 4]}
Reasoning: 1 directly addresses dark-mode in React; 4 contains the
exact file path the agent will need. 2 is unrelated. 3 is wrong language
+ wrong sub-problem.

──── Example 2 ────
QUERY: 帮我看下今天天气

CANDIDATES:
1. [TRACE] [user] 我住在杭州  [assistant] 已记住
2. [SKILL] Docker container syslib install fix
3. [WORLD-MODEL] React project layout — components in src/components/

Correct output: {"selected": [1]}
Reasoning: only 1 carries a fact the agent needs (location for weather
lookup). 2 and 3 are completely unrelated.

──── Output format ────
Return JSON only, no prose:
{
  "selected": [1, 3]
}
where each number is the 1-based index in the CANDIDATES list.

If nothing is truly relevant, return {"selected": []}.`,
};
