---
name: memos-memory-guide
description: "Use the MemOS Local memory system to search and use the user's past conversations. Use this skill whenever the user refers to past chats, their own preferences or history, or when you need to answer from prior context. When auto-recall returns nothing (long or unclear user query), generate your own short search query and call memory_search. Available tools: memory_search, memory_get, memory_write_public, memory_share, memory_unshare, task_summary, skill_get, skill_search, skill_install, skill_publish, skill_unpublish, network_memory_detail, network_skill_pull, network_team_info, memory_timeline, memory_viewer."
metadata:
  openclaw:
    requires:
      bins:
        - node
        - npm
      anyBins:
        - curl
        - wget
      env:
        - OPENCLAW_STATE_DIR
        - OPENCLAW_CONFIG_PATH
      config:
        - ~/.openclaw/openclaw.json
    install:
      - kind: node
        package: better-sqlite3
        bins: []
    emoji: "\U0001F9E0"
    homepage: https://github.com/nicekate/MemOS
---

# MemOS Local Memory — Agent Guide

This skill describes how to use the MemOS memory tools so you can reliably search and use the user's long-term conversation history, query team-shared data, share tasks, and discover or pull reusable skills.

Two sharing planes exist and must not be confused:

- **Local agent sharing:** visible to agents in the same OpenClaw workspace only.
- **Team sharing:** visible to teammates through the configured team server.

## How memory is provided each turn

- **Automatic recall (hook):** At the start of each turn, the system runs a memory search using the user's current message and injects relevant past memories into your context. You do not need to call any tool for that.
- **When that is not enough:** If the user's message is very long, vague, or the automatic search returns **no memories**, you should **generate your own short, focused query** and call `memory_search` yourself.
- **Memory isolation:** Each agent can only see its own local private memories and local `public` memories. Team-shared data only appears when you search with `scope="group"` or `scope="all"`.

## Tools — what they do and when to call

### memory_search

- **What it does:** Search long-term conversation memory for past conversations, user preferences, decisions, and experiences. Returns relevant excerpts with `chunkId` and optionally `task_id`. Only returns memories belonging to the current agent or marked as public.
- **When to call:**
  - The automatic recall did not run or returned nothing.
  - The user's query is long or unclear — **generate a short query yourself** and call `memory_search(query="...")`.
  - You need to search with a different angle (e.g. filter by `role='user'`).
- **Parameters:**
  - `query` (string, **required**) — Natural language search query.
  - `scope` (string, optional) — `'local'` (default) for current agent + local shared memories, or `'group'` / `'all'` to include team-shared memories.
  - `maxResults` (number, optional) — Increase when the first search is too narrow.
  - `minScore` (number, optional) — Lower slightly if recall is too strict.
  - `role` (string, optional) — Filter local results by `'user'`, `'assistant'`, `'tool'`, or `'system'`.

### memory_get

- **What it does:** Get the full original text of a memory chunk. Use to verify exact details from a search hit.
- **When to call:** A `memory_search` hit looks relevant but you need to see the complete original content, not just the summary/excerpt.
- **Parameters:**
  - `chunkId` (string, **required**) — The chunkId from a search hit.
  - `maxChars` (number, optional) — Max characters to return (default 4000, max 12000).

### memory_write_public

- **What it does:** Create a brand new local shared memory. These memories are visible to all agents in the same OpenClaw workspace during `memory_search`. This does **not** publish anything to the team server.
- **When to call:** In multi-agent or collaborative scenarios, when you want to create a new persistent shared note from scratch (e.g. shared decisions, conventions, configurations, workflows). Do not use it if you already have a specific memory chunk to expose.
- **Parameters:**
  - `content` (string, **required**) — The content to write to local shared memory.
  - `summary` (string, optional) — Short summary of the content.

### memory_share

- **What it does:** Share an existing memory either with local OpenClaw agents, to the team, or to both.
- **When to call:**
  - If you want to share conversation content to team or hub, first retrieve memories related to that content to obtain the right `chunkId`(s), then share.
  - `target='agents'` (default): When those memories would clearly help other agents in the same workspace, you may share proactively without asking the user.
  - `target='hub'` or `'both'`: Only after explicit user consent when the content would benefit collaborators—explain briefly, ask first, then call `hub`/`both` (Hub must be configured). Never silently Hub-share.
- **Do not use when:** You are creating a brand-new shared note with **no** existing chunk—use `memory_write_public` instead.
- **Parameters:**
  - `chunkId` (string, **required**) — Existing memory chunk ID.
  - `target` (string, optional) — `'agents'` (default), `'hub'`, or `'both'`.
  - `visibility` (string, optional) — Team visibility when target includes team: `'public'` (default) or `'group'`.
  - `groupId` (string, optional) — Optional team group ID when `visibility='group'`.

### memory_unshare

- **What it does:** Remove an existing memory from local agent sharing, team sharing, or both.
- **When to call:** A memory should no longer be visible outside the current agent or should be removed from the team.
- **Parameters:**
  - `chunkId` (string, **required**) — Existing memory chunk ID.
  - `target` (string, optional) — `'agents'`, `'hub'`, or `'all'` (default).
  - `privateOwner` (string, optional) — Rare fallback only for older public memories that have no recorded original owner.

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

- **What it does:** Search available skills by natural language. Searches your own skills, local shared skills, or both. It can also include team skills.
- **When to call:** The current task requires a capability or guide you don't have. Use `skill_search` to find one first; after finding it, use `skill_get` to read it, then `skill_install` to load it for future turns.
- **Parameters:**
  - `query` (string, **required**) — Natural language description of the needed skill.
  - `scope` (string, optional) — `'mix'` (default, self + local shared), `'self'`, `'public'` (local shared only), or `'group'` / `'all'` to include team results.

### skill_install

- **What it does:** Install a learned skill into the agent workspace so it becomes permanently available. After installation, the skill will be loaded automatically in future sessions.
- **When to call:** After `skill_get` when the skill is useful for ongoing use.
- **Parameters:**
  - `skillId` (string, **required**) — The skill ID to install.

### skill_publish

- **What it does:** Share a skill with local agents, or publish it to the team.
- **When to call:** You have a useful skill that other agents or your team could benefit from.
- **Parameters:**
  - `skillId` (string, **required**) — The skill ID to publish.
  - `target` (string, optional) — `'agents'` (default) or `'hub'`.
  - `visibility` (string, optional) — When `target='hub'`, use `'public'` (default) or `'group'`.
  - `groupId` (string, optional) — Optional team group ID when `target='hub'` and `visibility='group'`.
  - `scope` (string, optional) — Backward-compatible alias for old calls. Prefer `target` + `visibility` in new calls.

### skill_unpublish

- **What it does:** Stop local agent sharing, remove a team-published copy, or do both.
- **When to call:** You want to stop sharing a previously published skill.
- **Parameters:**
  - `skillId` (string, **required**) — The skill ID to unpublish.
  - `target` (string, optional) — `'agents'` (default), `'hub'`, or `'all'`.

### network_memory_detail

- **What it does:** Fetches the full content behind a team search hit.
- **When to call:** A `memory_search` result came from the team and you need the full shared memory content.
- **Parameters:** `remoteHitId`.

### task_share / task_unshare

- **What they do:** Share a local task to the team, or remove it later.
- **When to call:** A task is valuable to your group or to the whole team and should be discoverable via shared search.
- **Parameters:** `taskId`, plus sharing visibility/scope when required.

### network_skill_pull

- **What it does:** Pulls a team-shared skill bundle down into local storage.
- **When to call:** `skill_search` found a useful team skill and you want to use it locally or offline.
- **Parameters:** `skillId`.

### network_team_info

- **What it does:** Returns current team server connection information, user, role, and groups.
- **When to call:** You need to confirm whether team sharing is configured or which groups the current client belongs to.
- **Call this first before:** `memory_share(... target='hub'|'both')`, `memory_unshare(... target='hub'|'all')`, `task_share`, `task_unshare`, `skill_publish(... target='hub')`, `skill_unpublish(... target='hub'|'all')`, or `network_skill_pull`.
- **Parameters:** none.

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

7. **You have new shared knowledge useful to all local agents**
   → Call `memory_write_public(content="...")`.

8. **You already have an existing memory chunk and want to expose or hide it**
   → Call `memory_share(chunkId="...", target="agents|hub|both")` or `memory_unshare(chunkId="...", target="agents|hub|all")`.

9. **You are about to do anything team-sharing-related**
   → Call `network_team_info()` first if team server availability is uncertain.

10. **You want to share/stop sharing a skill with local agents or team**
   → Prefer `skill_publish(skillId="...", target="agents|hub", visibility=...)` and `skill_unpublish(skillId="...", target="agents|hub|all")`.

11. **User asks where to see or manage their memories**
   → Call `memory_viewer()` and share the URL.

## Writing good search queries

- Prefer **short, focused** queries (a few words or one clear question).
- Use **concrete terms**: names, topics, tools, or decisions.
- If the user's message is long, **derive one or two sub-queries** rather than pasting the whole message.
- Use `role='user'` when you specifically want to find what the user said.

## Memory ownership and agent isolation

Each memory is tagged with an `owner` (e.g. `agent:main`, `agent:sales-bot`). This is handled **automatically** — you do not need to pass any owner parameter.

- **Your memories:** All tools (`memory_search`, `memory_get`, `memory_timeline`) automatically scope queries to your agent's own memories.
- **Local shared memories:** Memories marked as local shared are visible to all agents in the same OpenClaw workspace. Use `memory_write_public` to create them, or `memory_share(target='agents')` to expose an existing chunk.
- **Cross-agent isolation:** You cannot see memories owned by other agents (unless they are public).
- **How it works:** The system identifies your agent ID from the OpenClaw runtime context and applies owner filtering automatically on every search, recall, and retrieval.
