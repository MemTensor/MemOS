# 🧠 MemOS — OpenClaw Memory Plugin

[![npm version](https://img.shields.io/npm/v/@memtensor/memos-local-openclaw-plugin)](https://www.npmjs.com/package/@memtensor/memos-local-openclaw-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/MemTensor/MemOS/blob/main/LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-Source-181717?logo=github)](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-openclaw)

Persistent local conversation memory for [OpenClaw](https://github.com/nicepkg/openclaw) AI Agents. Every conversation is automatically captured, semantically indexed, and instantly recallable — with **task summarization & skill evolution**, **team sharing for memories and skills**, and **multi-agent collaborative memory**.

**Full-write | Hybrid Search | Task Summarization & Skill Evolution | Team Sharing | Memory Viewer**

> 🌐 [Homepage](https://memos-claw.openmem.net) · 📖 [Documentation](https://memos-claw.openmem.net/docs/) · 📦 [NPM](https://www.npmjs.com/package/@memtensor/memos-local-openclaw-plugin) · 🛠 [Troubleshooting](https://memos-claw.openmem.net/docs/troubleshooting.html)

## Why MemOS

| Problem | Solution |
|---------|----------|
| Agent forgets everything between sessions | **Persistent memory** — every conversation auto-captured to local SQLite |
| Fragmented context, repeated mistakes | **Task summarization & skill evolution** — conversations organized into structured tasks, then distilled into reusable skills that auto-upgrade |
| Multi-agent teams work in isolation | **Multi-agent collaboration** — memory isolation + public memory + skill sharing enables collective evolution |
| No visibility into what the agent remembers | **Memory Viewer** — full visualization of all memories, tasks, and skills |
| Privacy concerns with cloud storage | **100% local** — zero cloud uploads, anonymous opt-out telemetry only, password-protected |

## Features

### Memory Engine
- **Auto-capture** — Stores user, assistant, and tool messages after each agent turn via `agent_end` event (consecutive assistant messages merged into one)
- **Smart deduplication** — Exact content-hash skip; then Top-5 similar chunks (threshold 0.75) with LLM judge: DUPLICATE (skip), UPDATE (merge summary + append content), or NEW (create). Evolved chunks track merge history.
- **Semantic chunking** — Splits by code blocks, function bodies, paragraphs; never cuts mid-function
- **Hybrid retrieval** — FTS5 keyword + vector semantic dual-channel search with RRF fusion
- **MMR diversity** — Maximal Marginal Relevance reranking prevents near-duplicate results
- **Recency decay** — Configurable time-based decay (half-life: 14 days) biases recent memories
- **Multi-provider embedding** — OpenAI-compatible, Gemini, Cohere, Voyage, Mistral, or local offline (Xenova/all-MiniLM-L6-v2)

### Task Summarization & Skill Evolution
- **Auto task boundary detection** — Per-turn LLM topic judgment (warm-up: 1 user turn) + 2-hour idle timeout segments conversations into tasks. Strongly biased toward SAME to avoid over-splitting related topics
- **Structured summaries** — LLM generates Goal, Key Steps, Result, Key Details for each completed task
- **Key detail preservation** — Code, commands, URLs, file paths, error messages retained in summaries
- **Quality filtering** — Tasks with too few chunks, too few turns, or trivial content are auto-skipped
- **Task status** — `active` (in progress), `completed` (with LLM summary), `skipped` (too brief, excluded from search)
- **Task/Skill CRUD** — Edit title/summary, delete tasks and skills, retry skill generation from task cards
- **Automatic evaluation** — After task completion, rule filter + LLM evaluates if the task is worth distilling into a skill
- **Skill generation** — Multi-step LLM pipeline creates SKILL.md + scripts + references + evals from real execution records
- **Skill upgrading** — When similar tasks appear, existing skills are auto-upgraded (refine / extend / fix)
- **Quality scoring** — 0-10 quality assessment; scores below 6 marked as draft
- **Version management** — Full version history with changelog, change summary, and upgrade type tracking
- **Auto-install** — Generated skills can be auto-installed into the workspace for immediate use
- **Dedicated model** — Optional separate LLM model for skill generation (e.g., Claude 4.6 for higher quality)
- **LLM fallback chain** — `skillSummarizer` → `summarizer` → OpenClaw native model (auto-detected from `openclaw.json`). If all configured models fail, the next in chain is tried automatically

### Team Sharing (v4)
- **Hub-Client architecture** — One Hub stores shared data; clients keep private data local and query the Hub on demand. Roles can be switched dynamically with proper confirmation and cleanup
- **Hub port auto-derivation** — Hub port derived from gateway port (`gatewayPort + 11`) to avoid conflicts in multi-instance setups; automatic port retry on `EADDRINUSE`
- **Admin approval flow** — Join requests require admin approval; admins can promote, demote, and remove members (with self-removal prevention)
- **Notification system** — Role change notifications (promoted/demoted), resource sharing notifications (shared/unshared/removed) with localized messages, Hub shutdown alerts
- **Scoped retrieval** — `memory_search` and `skill_search` support `local`, `group`, and `all` search scopes
- **Task sharing** — `task_share` / `task_unshare` push or remove task memories from the team without changing local private storage
- **Skill publish/pull** — Skills can be published to team visibility scopes and pulled back locally as full bundles for offline reuse
- **Graceful state transitions** — Client-to-Hub switch triggers confirmation, pending request withdrawal, connection cleanup, and automatic restart
- **Multi-instance support** — Viewer port, Hub port, sessions, and databases are all isolated per instance; supports running multiple OpenClaw instances on the same machine
- **Viewer integration** — Full team management UI: connection state, member management, pending approvals, scoped search, task share controls, skill pull, notification feed, and setup guide

### Memory Migration — Reconnect 🦐
- **One-click import** — Seamlessly migrate OpenClaw's native built-in memories (SQLite + JSONL) into the MemOS intelligent memory system
- **Smart deduplication** — Vector similarity + LLM judgment prevents duplicate imports; similar content auto-merged
- **Resume anytime** — Pause and resume at any time; refreshing the page auto-restores progress; already processed items are skipped
- **Post-import processing** — Optionally generate task summaries and evolve skills from imported memories; serial processing within each agent, parallel across agents
- **Agent parallelism** — Configurable concurrency (1–8) for parallel processing across agents; sessions within each agent are processed serially
- **Source tagging** — All migrated memories are tagged with 🦐, visually distinguishing them from conversation-generated memories
- **Real-time progress** — Live progress bar, stats (stored/skipped/merged/errors), and scrolling log via SSE

### Memory Viewer
- **7 management pages** — Memories, Tasks, Skills, Analytics, **Logs**, **Import**, Settings
- **Full CRUD** — Create, edit, delete, search memories; evolution badges and merge history on memory cards
- **Task browser** — Status filters, chat-bubble chunk view, structured summaries, skill generation status; edit/delete/retry-skill buttons on cards
- **Skill browser** — Version history, quality scores, visibility toggle, one-click download as ZIP; edit/delete/publish buttons on cards
- **Analytics dashboard** — Daily read/write activity, memory breakdown charts
- **Logs** — Tool call log (memory_search, auto_recall, memory_add, etc.) with input/output and duration; filter by tool, auto-refresh
- **Online configuration** — Modify embedding, summarizer, skill evolution settings via web UI
- **Security** — Password-protected, localhost-only (127.0.0.1), session cookies
- **i18n** — Chinese / English toggle
- **Themes** — Light / Dark mode

### Privacy & Security
- **100% on-device** — All data in local SQLite, no cloud uploads
- **Anonymous telemetry** — Enabled by default, opt-out via config. Only sends tool names, latencies, and version info. Never sends memory content, queries, or personal data. See [Telemetry](#telemetry) section.
- **Viewer security** — Binds to 127.0.0.1 only, password-protected with session cookies
- **Auto-recall + Skill** — Each turn, relevant memories are injected via `before_agent_start` hook (invisible to user). When nothing is recalled (e.g. long or unclear query), the agent is prompted to call `memory_search` with a self-generated short query. The bundled skill `memos-memory-guide` documents all tools and when to use them.

## Quick Start

### 1. Install

One command installs the plugin, all dependencies, and build tools automatically. Supports auto-upgrade to the latest version.

**macOS / Linux:**

```bash
curl -fsSL https://cdn.memtensor.com.cn/memos-local-openclaw/install.sh | bash
```

**Windows (PowerShell):**

```powershell
powershell -c "irm https://cdn.memtensor.com.cn/memos-local-openclaw/install.ps1 | iex"
```

**Alternative — Install via OpenClaw CLI:**

```bash
openclaw plugins install @memtensor/memos-local-openclaw-plugin
```

> **Note:** The Memory Viewer starts only when the **OpenClaw gateway** is running. After install, **configure** `openclaw.json` (step 2) and **start the gateway** (step 3); the viewer will then be available at `http://127.0.0.1:18799`.
>
> **Installation failed?** See the [Troubleshooting](#troubleshooting) section, the [detailed troubleshooting guide](https://memos-claw.openmem.net/docs/troubleshooting.html), or the [official better-sqlite3 troubleshooting docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md). You can also try manually rebuilding the native module:
> ```bash
> cd ~/.openclaw/extensions/memos-local-openclaw-plugin && npm rebuild better-sqlite3
> ```

**From source (development):**

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS/apps/memos-local-openclaw
npm install && npm run build
openclaw plugins install .
```

### 2. Configure

Add the plugin config to `~/.openclaw/openclaw.json`:

```jsonc
{
  "agents": {
    "defaults": {
      // IMPORTANT: Disable OpenClaw's built-in memory to avoid conflicts
      "memorySearch": {
        "enabled": false
      }
    }
  },
  "plugins": {
    "slots": {
      "memory": "memos-local-openclaw-plugin"
    },
    "entries": {
      "memos-local-openclaw-plugin": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai_compatible",
            "endpoint": "https://your-api-endpoint/v1",
            "apiKey": "sk-••••••",
            "model": "bge-m3"
          },
          "summarizer": {
            "provider": "openai_compatible",
            "endpoint": "https://your-api-endpoint/v1",
            "apiKey": "sk-••••••",
            "model": "gpt-4o-mini",
            "temperature": 0
          }
        }
      }
    }
  }
}
```

> **Critical:** You must set `agents.defaults.memorySearch.enabled` to `false`. Otherwise OpenClaw's built-in memory search runs alongside this plugin, causing duplicate retrieval and wasted tokens.

#### Embedding Provider Options

| Provider | `provider` value | Example `model` | Notes |
|---|---|---|---|
| OpenAI / compatible | `openai_compatible` | `bge-m3`, `text-embedding-3-small` | Any OpenAI-compatible API |
| Gemini | `gemini` | `text-embedding-004` | Requires `apiKey` |
| Cohere | `cohere` | `embed-english-v3.0` | Separates document/query embedding |
| Voyage | `voyage` | `voyage-2` | |
| Mistral | `mistral` | `mistral-embed` | |
| Local (offline) | `local` | — | Uses `Xenova/all-MiniLM-L6-v2`, no API needed |

> **No embedding config?** In the current sidecar build, the plugin falls back to the local embedding model automatically. If you need deterministic team-wide behavior, configure an explicit provider.

#### Summarizer Provider Options

| Provider | `provider` value | Example `model` |
|---|---|---|
| OpenAI / compatible | `openai_compatible` | `gpt-4o-mini` |
| Anthropic | `anthropic` | `claude-3-haiku-20240307` |
| Gemini | `gemini` | `gemini-1.5-flash` |
| AWS Bedrock | `bedrock` | `anthropic.claude-3-haiku-20240307-v1:0` |

> **No summarizer config?** The plugin automatically falls back to the OpenClaw native model (auto-detected from `~/.openclaw/openclaw.json`). If that is also unavailable, a rule-based fallback generates summaries from the first sentence + key entities. Good enough to start.

#### Skill Evolution Configuration (Optional)

You can optionally configure a dedicated model for skill generation (for higher quality skills):

```jsonc
{
  "config": {
    "skillSummarizer": {
      "provider": "anthropic",
      "apiKey": "sk-ant-xxx",
      "model": "claude-sonnet-4-20250514",
      "temperature": 0
    },
    "skillEvolution": {
      "enabled": true,
      "autoEvaluate": true,
      "autoInstall": false
    }
  }
}
```

**LLM fallback chain:** `skillSummarizer` → `summarizer` → OpenClaw native model (auto-detected from `~/.openclaw/openclaw.json`). If `skillSummarizer` is not configured, the plugin tries the regular `summarizer`, then falls back to the OpenClaw native model. Each step in the chain is tried automatically if the previous one fails.

#### Environment Variable Support

Use `${ENV_VAR}` placeholders in config to avoid hardcoding keys:

```jsonc
{
  "apiKey": "${OPENAI_API_KEY}"
}
```

### 3. Start or Restart the Gateway

```bash
openclaw gateway stop    # if already running
openclaw gateway install # ensure LaunchAgent is installed (macOS)
openclaw gateway start
```

Once the gateway is up, the plugin loads and starts the Memory Viewer at `http://127.0.0.1:18799`.

### 4. Verify Installation

```bash
tail -20 ~/.openclaw/logs/gateway.log
```

You should see:

```
memos-local: initialized (db: ~/.openclaw/memos-local/memos.db)
memos-local: started (embedding: openai_compatible)
╔══════════════════════════════════════════╗
║  MemOS Memory Viewer                     ║
║  → http://127.0.0.1:18799               ║
║  Open in browser to manage memories       ║
╚══════════════════════════════════════════╝
```

## Team Sharing (v4)

Team Sharing turns multiple OpenClaw instances into a collaborative memory network. One instance serves as the **Hub** (team server), others connect as **Clients**. Private data stays local; only explicitly shared tasks, memories, and skills are visible to the team.

### Key Capabilities

| Capability | Description |
|---|---|
| **Hub / Client architecture** | One Hub stores shared data; clients keep private data local and query the Hub on demand |
| **Hub port auto-derivation** | Hub port is automatically derived from the gateway port (`gatewayPort + 11`), avoiding port conflicts in multi-instance setups. Explicit `hub.port` config overrides this. |
| **Port retry on conflict** | If the derived/configured Hub port is in use (`EADDRINUSE`), the server automatically retries up to 3 consecutive ports |
| **Admin approval flow** | New members submit join requests; admin approves/rejects from the Viewer |
| **Self-removal prevention** | Admins cannot accidentally remove themselves from the team |
| **Role change notifications** | When an admin promotes/demotes a member, the affected user receives a notification |
| **Resource notifications** | Shared/unshared/removed resources trigger localized notifications with resource names |
| **Pending withdrawal** | Clients can cancel pending join requests when switching roles or disabling sharing |
| **Graceful role transitions** | Switching from Client to Hub (or vice versa) triggers confirmation prompts, proper cleanup of remote connections, and restart |
| **Hub shutdown notification** | When a Hub owner disables sharing, all connected clients receive a `hub_shutdown` notification |
| **Leave team** | Clients can leave a team with a confirmation dialog; the Hub is notified and the client's data is cleaned up |
| **Scoped retrieval** | `memory_search` and `skill_search` support `local`, `group`, and `all` search scopes |
| **Task sharing** | Push/remove task memories to/from the team |
| **Skill publish/pull** | Publish skills to team visibility; pull team skills locally as full bundles for offline use |

### Quick Setup

**Option A — Start a Hub (team server):**

```jsonc
{
  "config": {
    "sharing": {
      "enabled": true,
      "role": "hub",
      "hub": {
        "teamName": "My Team",
        "teamToken": "${MEMOS_TEAM_TOKEN}"
        // port is auto-derived; set explicitly only if needed
      }
    }
  }
}
```

**Option B — Join as Client:**

```jsonc
{
  "config": {
    "sharing": {
      "enabled": true,
      "role": "client",
      "client": {
        "hubAddress": "192.168.1.100:18800"
      }
    }
  }
}
```

You can also configure sharing entirely through the **Viewer → Settings → Team Sharing** panel — no need to edit `openclaw.json` manually.

### Multi-Instance Deployment

When running multiple OpenClaw instances on the same machine (e.g., personal + work):

- **Viewer port**: Each instance derives its Viewer port from the gateway port, so they won't conflict
- **Hub port**: Auto-derived as `gatewayPort + 11` (e.g., gateway `18789` → Hub `18800`, gateway `19001` → Hub `19012`)
- **Session isolation**: Each instance uses a separate cookie name based on its Viewer port, so multiple Viewers can be logged in simultaneously
- **Database isolation**: Each instance uses its own `memos.db` under its respective state directory

### Viewer Team Sharing Panel

The **Settings → Team Sharing** panel provides a complete management interface:

- **Hub mode**: Team name, member count, active members, pending approvals, admin controls (approve/reject/promote/demote/remove)
- **Client mode**: Connection status, team info, leave team button, notification feed
- **Setup guide cards**: Always visible — choose "Host a Team" or "Join a Team" with step-by-step instructions
- **Real-time notifications**: Role changes, resource sharing events, Hub status changes

For the full end-user workflow, see [`HUB-SHARING-GUIDE.md`](./HUB-SHARING-GUIDE.md).

### 5. Verify Memory is Working

**Step A** — Have a conversation with your OpenClaw agent about anything.

**Step B** — Open the Memory Viewer at `http://127.0.0.1:18799` and check that the conversation appears.

**Step C** — In a new conversation, ask the agent to recall what you discussed:

```
You: 你还记得我之前让你帮我处理过什么事情吗？
Agent: (calls memory_search) 是的，我们之前讨论过...
```

## How It Works

### Three Intelligent Pipelines

MemOS Lite operates through three interconnected pipelines that form a continuous learning loop:

```
Conversation → Memory Write Pipeline → Task Generation Pipeline → Skill Evolution Pipeline
                                                                          ↓
                              Smart Retrieval Pipeline ← ← ← ← ← ← ← ← ←
```

### Pipeline 1: Memory Write (auto on every agent turn)

```
Conversation → Capture (filter roles, strip system prompts)
→ Semantic chunking (code blocks, paragraphs, error stacks)
→ Content hash dedup → LLM summarize each chunk
→ Vector embedding → Store (SQLite + FTS5 + Vector)
```

- System messages are skipped; tool results from the plugin's own tools are not re-stored
- Evidence wrapper blocks (`[STORED_MEMORY]...[/STORED_MEMORY]`) are stripped to prevent feedback loops
- Content hash (SHA-256, first 16 hex chars) prevents duplicate chunk ingestion within the same session+role

### Pipeline 2: Task Generation (auto after memory write)

```
New chunks → Group into user-turns → Process one turn at a time
→ Warm-up (first user turn): assign directly
→ Each subsequent user turn: LLM topic judge (context vs new message)
  → "NEW"? → Finalize current task, create new task
  → "SAME"? → Assign to current task
→ Time gap > 2h? → Always split regardless of topic
→ Finalize: Chunks ≥ 4 & turns ≥ 2? → LLM structured summary → status = "completed"
  → Otherwise → status = "skipped" (excluded from search)
```

**Why Tasks matter:**
- Raw memory chunks are fragmented — a single conversation about "deploying Nginx" might span 20 chunks
- Task summarization organizes these fragments into a structured record: Goal → Steps → Result → Key Details
- When the agent searches memory, it can quickly locate the complete experience via `task_summary`, not just fragments
- Task summaries preserve code, commands, URLs, configs, and error messages

### Pipeline 3: Skill Evolution (auto after task completion)

```
Completed task → Rule filter (min chunks, non-trivial content)
→ Search for related existing skills
  → Related skill found (confidence ≥ 0.7)?
    → Evaluate upgrade (refine/extend/fix) → Merge new experience → Version bump
  → No related skill (or confidence < 0.3)?
    → Evaluate create → Generate SKILL.md + scripts + evals
    → Quality score (0-10) → Install if score ≥ 6
```

**Why Skills matter:**
- Without skills, agents rediscover solutions every time they encounter similar problems
- Skills crystallize successful executions into reusable guides with steps, pitfall warnings, and verification checks
- Skills auto-upgrade when new tasks bring improved approaches — getting faster, more accurate, and more token-efficient
- The evolution is automatic: task completes → evaluate → create/upgrade → install

### Pipeline 4: Smart Retrieval

**Auto-recall (every turn):** The plugin hooks `before_agent_start`, runs a memory search with the user's message, then uses an LLM to filter which candidates are relevant and whether they are sufficient to answer. The filtered memories are injected into the agent's system context (invisible to the user). If no memories are found or the query is long/unclear, the agent is prompted to call `memory_search` with a self-generated short query.

**On-demand search (`memory_search`):**
```
Query → FTS5 + Vector dual recall → RRF Fusion → MMR Rerank
→ Recency Decay → Score Filter → Top-K (e.g. 20)
→ LLM relevance filter (minimum information) → Dedup by excerpt overlap
→ Return excerpts + chunkId / task_id (no summaries)
  → sufficient=false → suggest task_summary(taskId), skill_get(taskId), memory_timeline(chunkId)
```

- **RRF (Reciprocal Rank Fusion):** Merges FTS5 and vector search rankings into a unified score
- **MMR (Maximal Marginal Relevance):** Re-ranks to balance relevance with diversity
- **Recency Decay:** Recent memories get a boost (half-life: 14 days by default)
- **LLM filter:** Only memories that are genuinely useful for the query are returned; sufficiency determines whether follow-up tool tips are appended

## Retrieval Strategy

1. **Auto-recall (hook)** — On every turn, the plugin runs a memory search using the user's message and injects LLM-filtered relevant memories into the agent's context (via `before_agent_start`). The agent sees this as system context; the user does not.
2. **When nothing is recalled** — If the user's message is long, vague, or no matches are found, the plugin injects a short hint telling the agent to call **`memory_search`** with a **self-generated short query** (e.g. key topics or a rephrased question).
3. **Bundled skill** — The plugin installs `memos-memory-guide` into `~/.openclaw/workspace/skills/memos-memory-guide/` and `~/.openclaw/skills/memos-memory-guide/`. This skill documents all memory tools, when to call them, and how to write good search queries. Add `skills.load.extraDirs: ["~/.openclaw/skills"]` in `openclaw.json` if you want the skill to appear in the OpenClaw skills dashboard.
4. **Search results** — `memory_search` returns **excerpts** (original content snippets) and IDs (`chunkId`, `task_id`), not summaries. The agent uses `memory_get(chunkId)` for full original text, `task_summary(taskId)` for structured task context, `memory_timeline(chunkId)` for surrounding conversation, and `skill_get(skillId|taskId)` for reusable experience guides.

## Agent Tools

The plugin provides local memory tools plus v4 team-sharing tools, and auto-installs the **memos-memory-guide** skill:

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `auto_recall` | Automatically injects relevant memories into agent context each turn (via `before_agent_start` hook) | Runs automatically — no manual call needed |
| `memory_search` | Search memories with `scope: local | group | all`; team hits are returned separately from local hits | When auto-recall returned nothing or you need local + shared context |
| `memory_get` | Get full original text of a local memory chunk | When you need to verify exact details from a local search hit |
| `memory_timeline` | Surrounding conversation around a local chunk | When you need the exact dialogue before/after a local hit |
| `network_memory_detail` | Fetch full content for a team memory hit | When a shared search hit looks relevant and you need full detail |
| `memory_write_public` | Write a memory to the local shared public space (`owner="public"`) | When the agent discovers knowledge all local agents should access |
| `task_summary` | Full structured summary of a completed task | When a hit has `task_id` and you need the full story |
| `task_share` | Push a local task and its memories to the team | When a task should be searchable by your group or the whole team |
| `task_unshare` | Remove a shared task from the team | When a task should stop being shared |
| `skill_get` | Get local skill content by `skillId` or `taskId` | When a hit has a linked task/skill and you want the reusable guide |
| `skill_install` | Install a skill into the agent workspace | When the skill should be permanently available for future turns |
| `skill_search` | Search skills with `scope: local | group | all` | When an agent needs to discover local or team-shared skills |
| `skill_publish` | Publish a skill to team sharing or local public visibility, depending on scope | When a skill should be shared with teammates |
| `skill_unpublish` | Make a previously shared skill private again | When a skill should no longer be shared |
| `network_skill_pull` | Pull a team skill bundle into local storage | When a teammate's shared skill should be usable locally/offline |
| `network_team_info` | Show current team server URL, user, role, and groups | When you need to inspect current team connection state |
| `memory_viewer` | Get the URL of the Memory Viewer web UI | When the user asks where to view or manage their memories |

### Search Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `query` | — | — | Natural language search query (keep it short and focused) |
| `maxResults` | 20 | 1–20 | Maximum candidates before LLM filter |
| `minScore` | 0.45 | 0.35–1.0 | Minimum relevance score |
| `role` | — | `user` / `assistant` / `tool` | Filter by message role (e.g. `user` to find what the user said) |

> **Viewer search** uses a stricter threshold (`minScore` 0.64) for vector results. When no semantic matches are found, it falls back to FTS5 keyword search and returns the top 20 keyword-based results.

## Memory Viewer

Open `http://127.0.0.1:18799` in your browser after starting the gateway.

**Pages:**

| Page | Features |
|------|----------|
| **Memories** | Timeline view, pagination, session/role/kind/date filters, CRUD, semantic search; evolution badges and merge history on cards |
| **Tasks** | Task list with status filters (active/completed/skipped), chat-bubble chunk view, structured summaries, skill generation status |
| **Skills** | Skill list with status badges, version history with changelogs, quality scores, related tasks, one-click ZIP download |
| **Analytics** | Daily write/read activity charts, memory/task/skill totals, role breakdown |
| **Logs** | Tool call log (memory_search, auto_recall, memory_add, etc.) with input/output, duration, and tool filter; auto-refresh |
| **Import** | 🦐 OpenClaw native memory migration — scan, one-click import with real-time SSE progress, smart dedup, pause/resume; post-processing for task & skill generation |
| **Settings** | Online configuration plus **Team Sharing** status, current role, team/groups, and admin pending-user actions |

**Viewer won't open?**

- The viewer is started by the plugin when the **gateway** starts. It does **not** run at install time.
- Ensure the gateway is running: `openclaw gateway start`
- Ensure the plugin is enabled in `~/.openclaw/openclaw.json`
- Check the log: `tail -30 ~/.openclaw/logs/gateway.log` — look for `MemOS Memory Viewer`

**Forgot password?** Click "Forgot password?" on the login page and use the reset token:

```bash
grep "password reset token:" ~/.openclaw/logs/gateway.log 2>/dev/null | tail -1
```

Copy the 32-character hex string after `password reset token:`.

## Advanced Configuration

All optional — shown with defaults:

```jsonc
{
  "config": {
    "recall": {
      "maxResultsDefault": 6,     // Default search results
      "maxResultsMax": 20,        // Max search results
      "minScoreDefault": 0.45,    // Default min score threshold
      "minScoreFloor": 0.35,      // Lowest allowed min score
      "rrfK": 60,                 // RRF fusion constant
      "mmrLambda": 0.7,           // MMR relevance vs diversity (0-1)
      "recencyHalfLifeDays": 14,  // Time decay half-life
      "vectorSearchMaxChunks": 0  // 0 = search all (default). Set 200000–300000 only if search is slow on huge DBs
    },
    "dedup": {
      "similarityThreshold": 0.75,  // Cosine similarity for smart-dedup candidates (Top-5)
      "enableSmartMerge": true,     // LLM judge: DUPLICATE / UPDATE / NEW
      "maxCandidates": 5            // Max similar chunks to send to LLM
    },
    "skillEvolution": {
      "enabled": true,            // Enable skill evolution
      "autoEvaluate": true,       // Auto-evaluate tasks for skill generation
      "minChunksForEval": 6,      // Min chunks for a task to be evaluated
      "minConfidence": 0.7,       // Min LLM confidence to create/upgrade skill
      "autoInstall": false        // Auto-install generated skills
    },
    "viewerPort": 18799,          // Memory Viewer port
    "telemetry": {
      "enabled": true              // Anonymous usage analytics (default: true, set false to opt-out)
    }
  }
}
```

## Telemetry

MemOS Lite collects **anonymous** usage analytics to help us understand how the plugin is used and improve it. Telemetry is **enabled by default** and can be disabled at any time.

### What is collected

- Plugin version, OS, Node.js version, architecture
- Tool call names and latencies (e.g. "memory_search took 120ms")
- Aggregate counts (chunks ingested, skills installed)
- Daily active ping

### What is NEVER collected

- Memory content, search queries, or conversation text
- API keys, file paths, or any personally identifiable information
- Any data stored in your local database

### How to disable

Add `telemetry` to your plugin config in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "memos-local-openclaw-plugin": {
        "enabled": true,
        "config": {
          "telemetry": {
            "enabled": false
          }
          // ... other config
        }
      }
    }
  }
}
```

Or set the environment variable:

```bash
TELEMETRY_ENABLED=false
```

### Technical details

- Uses Aliyun ARMS RUM for event collection
- Each installation gets a random anonymous UUID (stored at `~/.openclaw/memos-local/.anonymous-id`)
- Events are batched and sent in the background; failures are silently ignored
- The anonymous ID is never linked to any personal information

## Upgrade

```bash
openclaw plugins update memos-local-openclaw-plugin
```

The plugin will automatically install dependencies, clean up legacy versions, and rebuild the native SQLite module. After update, restart the gateway:

```bash
openclaw gateway stop && openclaw gateway start
```

> **Tip:** To update all plugins at once: `openclaw plugins update --all`

**If `openclaw plugins update` doesn't work** (plugin not in install registry), reinstall:

```bash
rm -rf ~/.openclaw/extensions/memos-local-openclaw-plugin
openclaw plugins install @memtensor/memos-local-openclaw-plugin
```

> **Note:** `openclaw plugins install` requires the target directory to not exist. If you see `plugin already exists`, delete the directory first. Your memory data is stored separately at `~/.openclaw/memos-local/memos.db` and will not be affected.

## Troubleshooting

> 📖 **详细排查指南 / Detailed troubleshooting guide:** [docs/troubleshooting.html](https://memtensor.github.io/MemOS/apps/memos-local-openclaw/docs/troubleshooting.html) — 包含逐步排查流程、日志查看方法、完全重装步骤等。
>
> 📦 **better-sqlite3 official troubleshooting:** [better-sqlite3 Troubleshooting](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md) — the upstream guide for native module build issues.

### Common Issues

1. **Note the exact error** — e.g. `plugin not found`, `Cannot find module 'xxx'`, `Invalid config`.

2. **Check plugin status**
   ```bash
   openclaw plugins list
   ```
   - Status is **error** → note the error message
   - Not listed → not installed or not placed in `~/.openclaw/extensions/memos-local-openclaw-plugin`

3. **Check gateway logs**
   ```bash
   tail -50 ~/.openclaw/logs/gateway.log
   ```
   Search for `memos-local`, `failed to load`, `Error`, `Cannot find module`.

4. **Check environment**
   - Node version: `node -v` (requires **>= 18**)
   - Plugin directory exists: `ls ~/.openclaw/extensions/memos-local-openclaw-plugin/package.json`
   - Dependencies installed: `ls ~/.openclaw/extensions/memos-local-openclaw-plugin/node_modules/@sinclair/typebox`
     If missing: `cd ~/.openclaw/extensions/memos-local-openclaw-plugin && npm install --omit=dev`

5. **Check configuration** — Open `~/.openclaw/openclaw.json` and verify:
   - `agents.defaults.memorySearch.enabled` = `false` (disable built-in memory)
   - `plugins.slots.memory` = `"memos-local-openclaw-plugin"`
   - `plugins.entries.memos-local-openclaw-plugin.enabled` = `true`

6. **better-sqlite3 native module error** — `Could not locate the bindings file` means the native SQLite addon was not compiled for your Node.js version.
   ```bash
   cd ~/.openclaw/extensions/memos-local-openclaw-plugin
   npm rebuild better-sqlite3
   ```
   If rebuild fails, install C++ build tools first:
   - **macOS:** `xcode-select --install` (if you see `xcrun: error: invalid active developer path`, run this first)
   - **Linux:** `sudo apt install build-essential python3`
   - **Windows:** Usually not needed — `better-sqlite3` provides prebuilt binaries for Windows + Node.js LTS. If it still fails, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (select "C++ build tools" workload)

   Then retry `npm rebuild better-sqlite3` and restart the gateway.

   > **Still failing?** Check the official [better-sqlite3 troubleshooting guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md) for platform-specific solutions. For non-LTS Node.js versions (e.g., v25.x), prebuilt binaries may not be available and compilation from source is required.

7. **Memory conflict with built-in search** — If the agent calls both the built-in memory search and the plugin's `memory_search`, it means `agents.defaults.memorySearch.enabled` is not set to `false`.

8. **Skills not generating** — Check:
   - `skillEvolution.enabled` is `true`
   - Tasks have enough content (default requires >= 6 chunks)
   - LLM model is accessible (check gateway log for `judgeNewTopic failed` or `SkillEvolver` errors)
   - The LLM fallback chain will try: `skillSummarizer` → `summarizer` → OpenClaw native model. If all fail, skill generation is skipped
   - Look for `SkillEvolver` output in the gateway log

9. **LLM calls failing** — All LLM-dependent features (summarization, topic detection, skill generation) use a fallback chain. If the configured model returns an error, the next model in the chain is tried automatically. Check the gateway log for messages like `failed (model), trying next`. If all models fail, the operation falls back to rule-based logic or is skipped.

## Data Location

| File | Path |
|---|---|
| Database | `~/.openclaw/memos-local/memos.db` |
| Viewer auth | `~/.openclaw/memos-local/viewer-auth.json` |
| Gateway log | `~/.openclaw/logs/gateway.log` |
| Plugin code | `~/.openclaw/extensions/memos-local-openclaw-plugin/` |
| Memory-guide skill | `~/.openclaw/workspace/skills/memos-memory-guide/SKILL.md` (and `~/.openclaw/skills/memos-memory-guide/`) |
| Generated skills | `~/.openclaw/memos-local/skills-store/<skill-name>/` |
| Installed skills | `~/.openclaw/workspace/skills/<skill-name>/` |

## Development Guide

This section is for contributors who want to develop, test, or modify the plugin from source.

### Prerequisites

- **Node.js >= 18** (`node -v`)
- **npm >= 9** (`npm -v`)
- **C++ build tools** (for `better-sqlite3` native module):
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install build-essential python3`
  - Windows: usually not needed (prebuilt binaries available for LTS Node.js); if build fails, install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- **OpenClaw CLI** installed and available in PATH (`openclaw --version`)

> **`better-sqlite3` build issues?** This is the most common installation problem on macOS and Linux. If `npm install` fails, first install the C++ build tools above, then run `npm rebuild better-sqlite3`. For detailed platform-specific solutions, see the [official better-sqlite3 troubleshooting guide](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md) and our [installation troubleshooting page](https://memtensor.github.io/MemOS/apps/memos-local-openclaw/docs/troubleshooting.html).

### Clone & Setup

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS/apps/memos-local-openclaw
npm install
```

> `npm install` triggers the `postinstall` script which automatically rebuilds `better-sqlite3` for your Node.js version.

### Project Structure

```
apps/memos-local-openclaw/
├── index.ts                 # Plugin entry — hooks, tool registration, lifecycle
├── plugin-impl.ts           # OpenClaw plugin SDK implementation
├── src/
│   ├── index.ts             # Module re-exports
│   ├── config.ts            # Configuration schema & defaults
│   ├── types.ts             # TypeScript type definitions
│   ├── capture/index.ts     # Message capture & filtering logic
│   ├── embedding/           # Embedding providers (OpenAI, Gemini, Cohere, etc.)
│   ├── ingest/
│   │   ├── chunker.ts       # Semantic chunking (code blocks, paragraphs)
│   │   ├── dedup.ts         # Content-hash + vector deduplication
│   │   ├── worker.ts        # Async ingestion pipeline
│   │   ├── task-processor.ts # Task boundary detection & summarization
│   │   └── providers/       # LLM providers for summarization
│   ├── recall/
│   │   ├── engine.ts        # Hybrid retrieval engine (FTS5 + Vector)
│   │   ├── rrf.ts           # Reciprocal Rank Fusion
│   │   ├── mmr.ts           # Maximal Marginal Relevance
│   │   └── recency.ts       # Time-decay scoring
│   ├── shared/
│   │   └── llm-call.ts      # LLM fallback chain utility (callLLMWithFallback, buildSkillConfigChain)
│   ├── skill/               # Skill evolution pipeline (evaluator, generator, upgrader)
│   ├── storage/
│   │   ├── sqlite.ts        # SQLite database layer (chunks, tasks, skills, FTS5)
│   │   └── vector.ts        # Vector similarity search
│   ├── tools/               # Tool implementations (memory-search, memory-get, etc.)
│   ├── viewer/              # Memory Viewer web server & HTML templates
│   └── telemetry.ts         # Anonymous usage analytics
├── tests/                   # Test suite (vitest)
├── scripts/                 # Utility scripts (seed data, smoke test, viewer)
├── skill/                   # Bundled skill definitions (SKILL.md files)
├── openclaw.plugin.json     # Plugin metadata for OpenClaw registry
├── package.json             # Dependencies & scripts
├── tsconfig.json            # TypeScript configuration
└── vitest.config.ts         # Test runner configuration
```

**Files NOT in the repository** (generated locally, excluded via `.gitignore`):

| Directory / File | Purpose | How to generate |
|---|---|---|
| `node_modules/` | npm dependencies | `npm install` |
| `dist/` | Compiled JavaScript output | `npm run build` |
| `package-lock.json` | Dependency lock file | `npm install` (auto-generated) |
| `www/` | Memory Viewer static site (local preview) | Started automatically by the plugin |
| `docs/` | Documentation HTML pages | Built from source or viewed at the hosted URL |
| `ppt/` | Presentation files (internal use) | Not needed for development |
| `.env` | Local environment variables | Copy from `.env.example` |

### Build

```bash
npm run build       # Compile TypeScript → dist/
npm run dev         # Watch mode — auto-recompile on save
```

The build output goes to `dist/` (CommonJS modules with declarations and source maps).

### Configure for Local Development

1. **Copy the environment template:**

```bash
cp .env.example .env
```

2. **Edit `.env`** with your API keys (or leave blank for local-only mode):

```bash
# Embedding — leave blank to use local offline model
EMBEDDING_PROVIDER=openai_compatible
EMBEDDING_API_KEY=your-key
EMBEDDING_ENDPOINT=https://your-api.com/v1
EMBEDDING_MODEL=bge-m3

# Summarizer — leave blank for rule-based fallback
SUMMARIZER_PROVIDER=openai_compatible
SUMMARIZER_API_KEY=your-key
SUMMARIZER_ENDPOINT=https://api.openai.com/v1
SUMMARIZER_MODEL=gpt-4o-mini
```

3. **Install the plugin locally into OpenClaw:**

```bash
npm run build
openclaw plugins install .
```

4. **Configure OpenClaw** — Add the plugin to `~/.openclaw/openclaw.json` (see [Configure](#2-configure) section above).

5. **Start the gateway:**

```bash
openclaw gateway stop    # stop existing
openclaw gateway start   # start with new plugin
```

### Testing

Run the full test suite:

```bash
npm test              # Run all tests once
npm run test:watch    # Watch mode — re-run on file changes
```

Test coverage includes:

| Test File | Coverage |
|---|---|
| `tests/policy.test.ts` | Retrieval strategy, search filtering, evidence extraction, instruction stripping |
| `tests/recall.test.ts` | RRF fusion, recency decay correctness |
| `tests/capture.test.ts` | Message filtering, evidence block stripping, self-tool exclusion |
| `tests/storage.test.ts` | SQLite CRUD, FTS5, vector storage, content hash dedup |
| `tests/chunker.test.ts` | Semantic chunking for code blocks, paragraphs, function bodies |
| `tests/task-processor.test.ts` | Task boundary detection, skip logic, summary generation |
| `tests/multi-agent.test.ts` | Multi-agent memory isolation, owner filtering, public sharing |
| `tests/integration.test.ts` | End-to-end ingestion and retrieval pipeline |

> Tests use an **in-memory SQLite database** — no external services or API keys required.

### Development Workflow

1. **Make changes** to files in `src/` or `index.ts`
2. **Run tests** to verify: `npm test`
3. **Build** to check TypeScript compilation: `npm run build`
4. **Test with OpenClaw** locally:
   ```bash
   openclaw plugins install .   # re-install from local source
   openclaw gateway stop && openclaw gateway start
   tail -f ~/.openclaw/logs/gateway.log   # watch logs
   ```
5. **Open Memory Viewer** at `http://127.0.0.1:18799` to verify UI changes

### Publishing to npm

```bash
npm run build                    # Compile TypeScript
npm publish --access public      # Publish to npm registry
```

After publishing, users can install with:
```bash
openclaw plugins install @memtensor/memos-local-openclaw-plugin
```

### Utility Scripts

| Script | Command | Purpose |
|---|---|---|
| Seed test data | `npx tsx scripts/seed-test-data.ts` | Populate local DB with sample memories, tasks, and skills |
| Smoke test | `npx tsx scripts/smoke-test.ts` | Quick end-to-end verification of plugin functionality |
| Start viewer | `npx tsx scripts/start-viewer.ts` | Start Memory Viewer standalone (without gateway) |
| Refresh skills | `npx tsx scripts/refresh-skill.ts` | Re-evaluate and regenerate skills from existing tasks |
| Refresh summaries | `npx tsx scripts/refresh-summaries.ts` | Re-generate task summaries for completed tasks |
| Mock skills | `npx tsx scripts/mock-skills.ts` | Generate mock skill data for testing |

## License

MIT — See [LICENSE](../../LICENSE) for details.
