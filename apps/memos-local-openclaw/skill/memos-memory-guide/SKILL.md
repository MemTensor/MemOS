---
name: memos-memory-guide
description: Use the MemOS Local memory system to search and use the user's past conversations. Use this skill whenever the user refers to past chats, their own preferences or history, or when you need to answer from prior context. When auto-recall returns nothing (long or unclear user query), generate your own short search query and call memory_search. Use task_summary when you need full task context, skill_get for experience guides, skill_search to discover public skills, memory_write_public for shared knowledge, and memory_timeline to expand around a memory hit.
---

# MemOS Local Memory — Agent Guide

This skill describes how to use the MemOS memory tools so you can reliably search and use the user's long-term conversation history, share knowledge across agents, and discover public skills.

## How memory is provided each turn

- **Automatic recall (hook):** At the start of each turn, the system runs a memory search using the user's current message and injects relevant past memories into your context. You do not need to call any tool for that.
- **When that is not enough:** If the user's message is very long, vague, or the automatic search returns **no memories**, you should **generate your own short, focused query** and call `memory_search` yourself.
- **Memory isolation:** Each agent can only see its own memories and memories marked as `public`. Other agents' private memories are invisible to you.

## Tools — what they do and when to call

### memory_search

- **What it does:** Searches the user's stored conversation memory by a natural-language query. Returns a list of relevant excerpts with `chunkId` and optionally `task_id`. Only returns memories belonging to the current agent or marked as public.
- **When to call:**
  - The automatic recall did not run or returned nothing.
  - The user's query is long or unclear — **generate a short query yourself** and call `memory_search(query="...")`.
  - You need to search with a different angle (e.g. filter by `role='user'`).
- **Parameters:** `query` (required), optional `minScore`, `role`.

### memory_write_public

- **What it does:** Writes a piece of information to **public memory**. Public memory is visible to all agents — any agent doing `memory_search` can find it.
- **When to call:** In multi-agent or collaborative scenarios, when you have **persistent information useful to everyone** (e.g. shared decisions, conventions, configurations, workflows). Do not write session-only or purely private content.
- **Parameters:** `content` (required), `summary` (optional).

### task_summary

- **What it does:** Returns the full task summary for a given `task_id`: title, status, and the complete narrative summary.
- **When to call:** A `memory_search` hit included a `task_id` and you need the full story of that task.
- **Parameters:** `taskId` (from a search hit).

### skill_get

- **What it does:** Returns the content of a learned skill (experience guide) by `skillId` or by `taskId`.
- **When to call:** A search hit has a `task_id` and the task has a "how to do this again" guide. Use this to follow the same approach or reuse steps.
- **Parameters:** `skillId` (direct) or `taskId` (lookup).

### skill_search

- **What it does:** Searches available **skills** (capabilities/guides) by natural language. Can search your own skills, other agents' public skills, or both — controlled by the `scope` parameter.
- **When to call:** The current task requires a capability or guide you don't have. Use `skill_search` to find one first; after finding it, use `skill_get` to read it, then `skill_install` to load it for future turns. Set `scope` to `public` to only see others' public skills, `self` for only your own, or leave as default `mix` for both.
- **Parameters:** `query` (required, natural language description of the need), `scope` (optional, default `mix`: self + public; `self`: own only; `public`: public only).

### skill_install

- **What it does:** Installs a skill (by `skillId`) into the workspace for future sessions.
- **When to call:** After `skill_get` when the skill is useful for ongoing use.
- **Parameters:** `skillId`.

### skill_publish

- **What it does:** Makes a skill **public** so other agents can discover and install it via `skill_search`.
- **When to call:** You have a useful skill that other agents could benefit from, and you want to share it.
- **Parameters:** `skillId`.

### skill_unpublish

- **What it does:** Makes a skill **private** again. Other agents will no longer discover it.
- **When to call:** You want to stop sharing a previously published skill.
- **Parameters:** `skillId`.

### memory_timeline

- **What it does:** Expands context around a single memory chunk: returns the surrounding conversation messages.
- **When to call:** A `memory_search` hit is relevant but you need the surrounding dialogue.
- **Parameters:** `chunkId` (from a search hit), optional `window` (default 2).

### memory_viewer

- **What it does:** Returns the URL of the MemOS Memory Viewer web dashboard.
- **When to call:** The user asks how to view their memories or open the memory dashboard.
- **Parameters:** None.

## Quick decision flow

1. **No memories in context or auto-recall reported nothing**
   → Call `memory_search` with a **self-generated short query**.

2. **Search returned hits with `task_id` and you need full context**
   → Call `task_summary(taskId)`.

3. **Task has an experience guide you want to follow**
   → Call `skill_get(taskId=...)` or `skill_get(skillId=...)`. Optionally `skill_install(skillId)` for future use.

4. **You need the exact surrounding conversation of a hit**
   → Call `memory_timeline(chunkId=...)`.

5. **You need a capability/guide that you don't have**
   → Call `skill_search(query="...", scope="mix")` to discover available skills.

6. **You have shared knowledge useful to all agents**
   → Call `memory_write_public(content="...")` to persist it in public memory.

7. **You want to share a useful skill with other agents**
   → Call `skill_publish(skillId=...)`.

8. **User asks where to see or manage their memories**
   → Call `memory_viewer()` and share the URL.

## Writing good search queries

- Prefer **short, focused** queries (a few words or one clear question).
- Use **concrete terms**: names, topics, tools, or decisions.
- If the user's message is long, **derive one or two sub-queries** rather than pasting the whole message.
- Use `role='user'` when you specifically want to find what the user said.
