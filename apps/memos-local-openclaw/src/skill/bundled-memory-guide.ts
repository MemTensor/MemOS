/**
 * Bundled MemOS memory-guide skill content.
 * Written to workspace/skills/memos-memory-guide on plugin register so OpenClaw loads it.
 */
export const MEMORY_GUIDE_SKILL_MD = `---
name: memos-memory-guide
description: Use the MemOS Local memory system to search and use the user's past conversations. Use this skill whenever the user refers to past chats, their own preferences or history, or when you need to answer from prior context. When auto-recall returns nothing (long or unclear user query), generate your own short search query and call memory_search. Use task_summary when you need full task context, skill_get for experience guides, and memory_timeline to expand around a memory hit.
---

# MemOS Local Memory — Agent Guide

This skill describes how to use the MemOS memory tools so you can reliably search and use the user's long-term conversation history.

## How memory is provided each turn

- **Automatic recall (hook):** At the start of each turn, the system runs a memory search using the user's current message and injects relevant past memories into your context. You do not need to call any tool for that.
- **When that is not enough:** If the user's message is very long, vague, or the automatic search returns **no memories**, you should **generate your own short, focused query** and call \`memory_search\` yourself. For example:
  - User sent a long paragraph → extract 1–2 key topics or a short question and search with that.
  - Auto-recall said "no memories" or you see no memory block → call \`memory_search\` with a query you derive (e.g. the user's name, a topic they often mention, or a rephrased question).
- **When you need more detail:** Search results only give excerpts and IDs. Use the tools below to fetch full task context, skill content, or surrounding messages.

## Tools — what they do and when to call

### memory_search

- **What it does:** Searches the user's stored conversation memory by a natural-language query. Returns a list of relevant excerpts with \`chunkId\` and optionally \`task_id\`.
- **When to call:**
  - The automatic recall did not run or returned nothing (e.g. no \`<memory_context>\` block, or a note that no memories were found).
  - The user's query is long or unclear — **generate a short query yourself** (keywords, rephrased question, or a clear sub-question) and call \`memory_search(query="...")\`.
  - You need to search with a different angle (e.g. filter by \`role='user'\` to find what the user said, or use a more specific query).
- **Parameters:** \`query\` (required), optional \`minScore\`, \`role\` (e.g. \`"user"\`).
- **Output:** List of items with role, excerpt, \`chunkId\`, and sometimes \`task_id\`. Use those IDs with the tools below when you need more context.

### task_summary

- **What it does:** Returns the full task summary for a given \`task_id\`: title, status, and the complete narrative summary of that conversation task (steps, decisions, URLs, commands, etc.).
- **When to call:** A \`memory_search\` hit included a \`task_id\` and you need the full story of that task (e.g. what was done, what the user decided, what failed or succeeded).
- **Parameters:** \`taskId\` (from a search hit).
- **Effect:** You get one coherent summary of the whole task instead of isolated excerpts.

### skill_get

- **What it does:** Returns the content of a learned skill (experience guide) by \`skillId\` or by \`taskId\`. If you pass \`taskId\`, the system finds the skill linked to that task.
- **When to call:** A search hit has a \`task_id\` and the task is the kind that has a "how to do this again" guide (e.g. a workflow the user has run before). Use this to follow the same approach or reuse steps.
- **Parameters:** \`skillId\` (direct) or \`taskId\` (lookup).
- **Effect:** You receive the full SKILL.md-style guide. You can then call \`skill_install(skillId)\` if the user or you want that skill loaded for future turns.

### skill_install

- **What it does:** Installs a skill (by \`skillId\`) into the workspace so it is loaded in future sessions.
- **When to call:** After \`skill_get\` when the skill is useful for ongoing use (e.g. the user's recurring workflow). Optional; only when you want the skill to be permanently available.
- **Parameters:** \`skillId\`.

### memory_timeline

- **What it does:** Expands context around a single memory chunk: returns the surrounding conversation messages (±N turns) so you see what was said before and after that excerpt.
- **When to call:** A \`memory_search\` hit is relevant but you need the surrounding dialogue (e.g. who said what next, or the exact follow-up question).
- **Parameters:** \`chunkId\` (from a search hit), optional \`window\` (default 2).
- **Effect:** You get a short, linear slice of the conversation around that chunk.

### memory_viewer

- **What it does:** Returns the URL of the MemOS Memory Viewer (web UI) where the user can browse, search, and manage their memories.
- **When to call:** The user asks how to view their memories, open the memory dashboard, or manage stored data.
- **Parameters:** None.
- **Effect:** You can tell the user to open that URL in a browser.

## Quick decision flow

1. **No memories in context or auto-recall reported nothing**
   → Call \`memory_search\` with a **self-generated short query** (e.g. key topic or rephrased question).

2. **Search returned hits with \`task_id\` and you need full context**
   → Call \`task_summary(taskId)\`.

3. **Task has an experience guide you want to follow**
   → Call \`skill_get(taskId=...)\` (or \`skill_get(skillId=...)\` if you have the id). Optionally \`skill_install(skillId)\` for future use.

4. **You need the exact surrounding conversation of a hit**
   → Call \`memory_timeline(chunkId=...)\`.

5. **User asks where to see or manage their memories**
   → Call \`memory_viewer()\` and share the URL.

## Writing good search queries

- Prefer **short, focused** queries (a few words or one clear question).
- Use **concrete terms**: names, topics, tools, or decisions (e.g. "preferred editor", "deploy script", "API key setup").
- If the user's message is long, **derive one or two sub-queries** rather than pasting the whole message.
- Use \`role='user'\` when you specifically want to find what the user said (e.g. preferences, past questions).
`;
