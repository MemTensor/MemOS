# MemOS Blind Functionality Audit — Session Summary

**Date:** 2026-04-06 to 2026-04-08
**Scope:** Autonomous blind audit of MemOS API (localhost:8001) — testing all documented capabilities against actual behavior.
**Full report:** `/home/openclaw/Coding/Hermes/tests/blind-audit-report.md`

---

## What Was Done

1. **Ran a full autonomous audit** — an agent read the OpenAPI spec and source code, then designed and executed its own test suite against a live MemOS instance. Created isolated test users (audit-alpha, audit-beta, audit-gamma) with their own cubes.

2. **Tested 14 areas** across write path, extraction, search, dedup, long content, cross-cube isolation, memory types, feedback, scheduler, chat, auth, delete, persistence, and edge cases.

3. **Root-cause analysis** — after the audit report, we traced each bug to exact source file + line number by reading the installed package at `/home/openclaw/.local/lib/python3.12/site-packages/memos/`.

---

## Overall Score: 6.8/10

### What Works Well
- **Write persistence** — Qdrant + Neo4j dual storage, survives restarts
- **Fine-mode extraction** — third-person perspective (10/10), pronoun resolution (10/10), timestamp resolution from `chat_time` (9/10)
- **Write-time dedup** — 90% similarity threshold correctly blocks exact and near-duplicates
- **Search** — relativity threshold and top_k work exactly as documented
- **Cross-cube isolation** — strict 403 enforcement, spoof protection works
- **Edge cases** — URLs, JSON, HTML, code, short/long content all handled correctly

### Critical Bugs Found

#### Bug 1: BCrypt Auth Overhead (~1.2s per request)
- **File:** `memos/api/middleware/agent_auth.py:176-183`
- **Cause:** `_authenticate_key()` iterates ALL agent bcrypt hashes sequentially. With 6 agents and bcrypt cost=12, worst case is ~1.2s pure auth overhead before any memory work.
- **Fix needed:** Add a prefix-based lookup. Each key starts with `ak_XXXX...` — build a dict mapping `key_prefix` to the agent entry, then only bcrypt-check the one matching prefix instead of all N.

#### Bug 2: Search-Time Dedup Modes (no/sim/mmr) Non-Functional
- **Files:**
  - `memos/api/handlers/search_handler.py:90-107` — handler-level sim/mmr dedup exists and works
  - `memos/memories/textual/tree_text_memory/retrieve/searcher.py:1020-1026` — tree searcher only does exact-text dedup, ignores mode
- **Cause:** The tree searcher's `_deduplicate_results()` treats dedup as a boolean (on/off), not modal. It always does exact-text dedup regardless of sim/mmr. The handler-level sim/mmr code runs after, but operates on already-deduped results.
- **Fix needed:** Either pass the dedup mode through to the tree searcher properly, or ensure embeddings are included in results so handler-level sim/mmr dedup has data to work with.

#### Bug 3: Custom Tags/Info Stripped on Write
- **File:** `memos/mem_reader/simple_struct.py:340-342, 359`
- **Cause:** `custom_tags` is popped from info dict (line 340) but never used in fast mode. Line 359 hardcodes `tags = ["mode:fast"]`. In fine mode, custom_tags are passed to the LLM prompt but not persisted as memory tags either.
- **Fix needed:** In fast mode, merge custom_tags into the tags list: `tags = ["mode:fast"] + (custom_tags or [])`. In fine mode, append custom_tags to whatever the LLM returns.

#### Bug 4: Feedback & Delete Endpoints Default to Wrong Cube ID
- **Files:**
  - `memos/api/routers/server_router.py:431` — feedback defaults `cube_ids = [user_id]`
  - `memos/api/routers/server_router.py:411` — delete does the same
  - `memos/api/handlers/feedback_handler.py:61` — handler also defaults to `[user_id]`
- **Cause:** Cube naming convention is `{user_id}-cube` but fallback uses raw `user_id`. Results in 403 because no cube named just `user_id` exists.
- **Fix needed:** Either change default to `[f"{user_id}-cube"]` or (better) require `writable_cube_ids` and return 400 if missing.

#### Bug 5: Scheduler Monitoring Broken Without Redis
- **Symptom:** `task_queue_status` returns 503, `allstatus` shows all zeros.
- **Cause:** Local queue mode works for processing but has no status API.
- **Fix needed:** Implement in-memory task status tracking as fallback when Redis is unavailable.

#### Bug 6: Chat Endpoint Non-Functional
- **Cause:** `ENABLE_CHAT_API=false` by default, and the request model expects `query` not `messages`.
- **Low priority** — not used in Hermes architecture.

---

## Fixes Not Yet Applied

We completed root-cause analysis for all bugs but were interrupted before implementing fixes. The priority order for fixing:

1. **BCrypt auth** (Bug 1) — biggest UX impact, every request is slow
2. **Custom tags** (Bug 3) — blocks metadata-based filtering
3. **Feedback/delete cube default** (Bug 4) — simple one-line fixes
4. **Search dedup modes** (Bug 2) — more complex, needs careful threading of mode parameter
5. **Scheduler monitoring** (Bug 5) — nice-to-have
6. **Chat endpoint** (Bug 6) — not needed currently

---

## Key Source Paths Referenced

| Component | Path |
|-----------|------|
| Auth middleware | `memos/api/middleware/agent_auth.py` |
| Search handler (dedup) | `memos/api/handlers/search_handler.py` |
| Tree searcher (dedup) | `memos/memories/textual/tree_text_memory/retrieve/searcher.py` |
| Add handler (tags/info) | `memos/api/handlers/add_handler.py` |
| Memory reader (fast/fine) | `memos/mem_reader/simple_struct.py` |
| Feedback handler | `memos/api/handlers/feedback_handler.py` |
| Server router | `memos/api/routers/server_router.py` |
| Installed package root | `/home/openclaw/.local/lib/python3.12/site-packages/memos/` |
| MemOS source repo | `/home/openclaw/Coding/MemOS/` |
