---
name: memos-memory-guide
description: "Use the MemOS Local memory system to search and use the user's past conversations. Use this skill whenever the user refers to past chats, their own preferences or history, or when you need to answer from prior context. When auto-recall returns nothing (long or unclear user query), generate your own short search query and call memory_search. Available tools: memory_search, memory_get, memory_write_public, task_summary, skill_get, skill_search, skill_install, skill_publish, skill_unpublish, memory_timeline, memory_viewer."
---

# MemOS Local Memory — Agent Guide

This skill describes how to use the MemOS memory tools so you can reliably search and use the user's long-term conversation history, share knowledge across agents, and discover public skills.

## How memory is provided each turn

- **Automatic recall (hook):** At the start of each turn, the system runs a memory search using the user's current message and injects relevant past memories into your context. You do not need to call any tool for that.
- **When that is not enough:** If the user's message is very long, vague, or the automatic search returns **no memories**, you should **generate your own short, focused query** and call `memory_search` yourself.
- **Memory isolation:** Each agent can only see its own memories and memories marked as `public`. Other agents' private memories are invisible to you.

## Tools — what they do and when to call

### memory_search

- **What it does:** Search long-term conversation memory for past conversations, user preferences, decisions, and experiences. Returns relevant excerpts with `chunkId` and optionally `task_id`. Only returns memories belonging to the current agent or marked as public.
- **When to call:**
  - The automatic recall did not run or returned nothing.
  - The user's query is long or unclear — **generate a short query yourself** and call `memory_search(query="...")`.
  - You need to search with a different angle (e.g. filter by `role='user'`).
- **Parameters:**
  - `query` (string, **required**) — Natural language search query.
  - `maxResults` (number, optional) — Max results, default 20, max 20.
  - `minScore` (number, optional) — Minimum score 0–1, default 0.45, floor 0.35.
  - `role` (string, optional) — Filter by role: `'user'`, `'assistant'`, or `'tool'`. Use `'user'` to find what the user said.

### memory_get

- **What it does:** Get the full original text of a memory chunk. Use to verify exact details from a search hit.
- **When to call:** A `memory_search` hit looks relevant but you need to see the complete original content, not just the summary/excerpt.
- **Parameters:**
  - `chunkId` (string, **required**) — The chunkId from a search hit.
  - `maxChars` (number, optional) — Max characters to return (default 4000, max 12000).

### memory_write_public

- **What it does:** Write a piece of information to public memory. Public memories are visible to all agents during `memory_search`. Use for shared knowledge, team decisions, or cross-agent coordination information.
- **When to call:** In multi-agent or collaborative scenarios, when you have persistent information useful to everyone (e.g. shared decisions, conventions, configurations, workflows). Do not write session-only or purely private content.
- **Parameters:**
  - `content` (string, **required**) — The content to write to public memory.
  - `summary` (string, optional) — Short summary of the content.

### task_summary

- **What it does:** Get the detailed summary of a complete task: title, status, narrative summary, and related skills. Use when `memory_search` returns a hit with a `task_id` and you need the full story. Preserves critical information: URLs, file paths, commands, error codes, step-by-step instructions.
- **When to call:** A `memory_search` hit included a `task_id` and you need the full context of that task.
- **Parameters:**
  - `taskId` (string, **required**) — The task_id from a memory_search hit.

### skill_get

- **What it does:** Retrieve a proven skill (experience guide) by `skillId` or by `taskId`. If you pass a `taskId`, the system will find the associated skill automatically.
- **When to call:** A search hit has a `task_id` and the task has a "how to do this again" guide. Use this to follow the same approach or reuse steps.
- **Parameters:**
  - `skillId` (string, optional) — Direct skill ID.
  - `taskId` (string, optional) — Task ID — will look up the skill linked to this task.
  - At least one of `skillId` or `taskId` must be provided.

### skill_search

- **What it does:** Search available skills by natural language. Searches your own skills, public skills, or both — controlled by the `scope` parameter.
- **When to call:** The current task requires a capability or guide you don't have. Use `skill_search` to find one first; after finding it, use `skill_get` to read it, then `skill_install` to load it for future turns.
- **Parameters:**
  - `query` (string, **required**) — Natural language description of the needed skill.
  - `scope` (string, optional) — Search scope: `'mix'` (default, self + public), `'self'` (own only), `'public'` (public only).

### skill_install

- **What it does:** Install a learned skill into the agent workspace so it becomes permanently available. After installation, the skill will be loaded automatically in future sessions.
- **When to call:** After `skill_get` when the skill is useful for ongoing use.
- **Parameters:**
  - `skillId` (string, **required**) — The skill ID to install.

### skill_publish

- **What it does:** Make a skill public so other agents can discover and install it via `skill_search`.
- **When to call:** You have a useful skill that other agents could benefit from, and you want to share it.
- **Parameters:**
  - `skillId` (string, **required**) — The skill ID to publish.

### skill_unpublish

- **What it does:** Make a skill private again. Other agents will no longer be able to discover it.
- **When to call:** You want to stop sharing a previously published skill.
- **Parameters:**
  - `skillId` (string, **required**) — The skill ID to unpublish.

### memory_timeline

- **What it does:** Expand context around a memory search hit. Pass the `chunkId` from a search result to read the surrounding conversation messages.
- **When to call:** A `memory_search` hit is relevant but you need the surrounding dialogue.
- **Parameters:**
  - `chunkId` (string, **required**) — The chunkId from a memory_search hit.
  - `window` (number, optional) — Context window ±N messages, default 2.

### memory_viewer

- **What it does:** Show the MemOS Memory Viewer URL. Call this when the user asks how to view, browse, manage, or check their memories. Returns the URL the user can open in their browser.
- **When to call:** The user asks where to see or manage their memories.
- **Parameters:** None.

## Quick decision flow

1. **No memories in context or auto-recall reported nothing**
   → Call `memory_search(query="...")` with a **self-generated short query**.

2. **Need to see the full original text of a search hit**
   → Call `memory_get(chunkId="...")`.

3. **Search returned hits with `task_id` and you need full context**
   → Call `task_summary(taskId="...")`.

4. **Task has an experience guide you want to follow**
   → Call `skill_get(taskId="...")` or `skill_get(skillId="...")`. Optionally `skill_install(skillId="...")` for future use.

5. **You need the exact surrounding conversation of a hit**
   → Call `memory_timeline(chunkId="...")`.

6. **You need a capability/guide that you don't have**
   → Call `skill_search(query="...", scope="mix")` to discover available skills.

7. **You have shared knowledge useful to all agents**
   → Call `memory_write_public(content="...")` to persist it in public memory.

8. **You want to share/stop sharing a skill with other agents**
   → Call `skill_publish(skillId="...")` or `skill_unpublish(skillId="...")`.

9. **User asks where to see or manage their memories**
   → Call `memory_viewer()` and share the URL.

## Writing good search queries

- Prefer **short, focused** queries (a few words or one clear question).
- Use **concrete terms**: names, topics, tools, or decisions.
- If the user's message is long, **derive one or two sub-queries** rather than pasting the whole message.
- Use `role='user'` when you specifically want to find what the user said.

## Memory ownership and agent isolation

Each memory is tagged with an `owner` (e.g. `agent:main`, `agent:sales-bot`). This is handled **automatically** — you do not need to pass any owner parameter.

- **Your memories:** All tools (`memory_search`, `memory_get`, `memory_timeline`) automatically scope queries to your agent's own memories.
- **Public memories:** Memories marked as `public` are visible to all agents. Use `memory_write_public` to write shared knowledge.
- **Cross-agent isolation:** You cannot see memories owned by other agents (unless they are public).
- **How it works:** The system identifies your agent ID from the OpenClaw runtime context and applies owner filtering automatically on every search, recall, and retrieval.
