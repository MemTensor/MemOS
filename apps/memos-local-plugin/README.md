# MemOS — Hermes Memory Plugin

[![npm version](https://img.shields.io/npm/v/@memtensor/memos-local-hermes-plugin)](https://www.npmjs.com/package/@memtensor/memos-local-hermes-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/MemTensor/MemOS/blob/main/LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![GitHub](https://img.shields.io/badge/GitHub-Source-181717?logo=github)](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)

Persistent local conversation memory for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Every conversation is automatically captured, semantically indexed, and instantly recallable — with **task summarization & skill evolution**, **team sharing**, and **Memory Viewer**.

**Full-write | Hybrid Search | Task Summarization & Skill Evolution | Team Sharing | Memory Viewer**

> 📦 [NPM](https://www.npmjs.com/package/@memtensor/memos-local-hermes-plugin) · 📖 [Documentation](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin/www/docs)

## Why MemOS

| Problem | Solution |
|---------|----------|
| Agent forgets everything between sessions | **Persistent memory** — every conversation auto-captured to local SQLite |
| Fragmented context, repeated mistakes | **Task summarization & skill evolution** — conversations organized into structured tasks, then distilled into reusable skills that auto-upgrade |
| No visibility into what the agent remembers | **Memory Viewer** — full visualization of all memories, tasks, and skills |
| Privacy concerns with cloud storage | **100% local** — zero cloud uploads, anonymous opt-out telemetry only |

## Features

### Memory Engine
- **Auto-capture** — Stores user, assistant, and tool messages after each agent turn
- **Smart deduplication** — Exact content-hash skip; then Top-5 similar chunks (threshold 0.75) with LLM judge: DUPLICATE (skip), UPDATE (merge), or NEW (create)
- **Semantic chunking** — Splits by code blocks, function bodies, paragraphs; never cuts mid-function
- **Hybrid retrieval** — FTS5 keyword + vector semantic dual-channel search with RRF fusion
- **MMR diversity** — Maximal Marginal Relevance reranking prevents near-duplicate results
- **Recency decay** — Configurable time-based decay (half-life: 14 days) biases recent memories
- **Multi-provider embedding** — OpenAI-compatible, Gemini, Cohere, Voyage, Mistral, or local offline (Xenova/all-MiniLM-L6-v2)

### Task Summarization & Skill Evolution
- **Auto task boundary detection** — Per-turn LLM topic judgment + 2-hour idle timeout segments conversations into tasks
- **Structured summaries** — LLM generates Goal, Key Steps, Result, Key Details for each completed task
- **Key detail preservation** — Code, commands, URLs, file paths, error messages retained in summaries
- **Automatic evaluation** — After task completion, rule filter + LLM evaluates if the task is worth distilling into a skill
- **Skill generation** — Multi-step LLM pipeline creates SKILL.md + scripts + references from real execution records
- **Skill upgrading** — When similar tasks appear, existing skills are auto-upgraded
- **Version management** — Full version history with changelog and upgrade type tracking

### Memory Viewer
- **7 management pages** — Memories, Tasks, Skills, Analytics, Logs, Import, Settings
- **Full CRUD** — Create, edit, delete, search memories
- **Task browser** — Status filters, chat-bubble chunk view, structured summaries
- **Skill browser** — Version history, quality scores, one-click download as ZIP
- **Analytics dashboard** — Daily read/write activity, memory breakdown charts
- **Security** — Password-protected, localhost-only (127.0.0.1), session cookies
- **i18n** — Chinese / English toggle
- **Themes** — Light / Dark mode

### Privacy & Security
- **100% on-device** — All data in local SQLite, no cloud uploads
- **Anonymous telemetry** — Enabled by default, opt-out via config. Only sends tool names, latencies, and version info. Never sends memory content, queries, or personal data.

## Quick Start

### 1. Install

One command installs the plugin, all dependencies, and build tools automatically.

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash
```

**Alternative — Install via npm:**

```bash
npm install -g @memtensor/memos-local-hermes-plugin
```

> **Environment variables for install script:**
>
> | Variable | Default | Description |
> |---|---|---|
> | `MEMOS_INSTALL_DIR` | `~/.hermes/memos-plugin` | Override install directory |
> | `MEMOS_STATE_DIR` | auto | Override memory DB location |
> | `MEMOS_DAEMON_PORT` | `18992` | Bridge daemon port |
> | `MEMOS_VIEWER_PORT` | `18901` | Memory Viewer port |
> | `MEMOS_EMBEDDING_PROVIDER` | `local` | Embedding provider |

### 2. Configure

Copy and edit the environment template:

```bash
cd ~/.hermes/memos-plugin
cp .env.example .env
```

Edit `.env` with your API keys (or leave blank for local-only mode):

```bash
# Embedding — leave blank to use local offline model (Xenova/all-MiniLM-L6-v2)
EMBEDDING_PROVIDER=openai_compatible
EMBEDDING_API_KEY=your-embedding-api-key
EMBEDDING_ENDPOINT=https://your-embedding-api.com/v1
EMBEDDING_MODEL=bge-m3

# Summarizer — leave blank for rule-based fallback
SUMMARIZER_PROVIDER=openai_compatible
SUMMARIZER_API_KEY=your-summarizer-api-key
SUMMARIZER_ENDPOINT=https://api.openai.com/v1
SUMMARIZER_MODEL=gpt-4o-mini
SUMMARIZER_TEMPERATURE=0
```

#### Embedding Provider Options

| Provider | `provider` value | Example `model` | Notes |
|---|---|---|---|
| OpenAI / compatible | `openai_compatible` | `bge-m3`, `text-embedding-3-small` | Any OpenAI-compatible API |
| Gemini | `gemini` | `text-embedding-004` | Requires `apiKey` |
| Cohere | `cohere` | `embed-english-v3.0` | Separates document/query embedding |
| Voyage | `voyage` | `voyage-2` | |
| Mistral | `mistral` | `mistral-embed` | |
| Local (offline) | `local` | — | Uses `Xenova/all-MiniLM-L6-v2`, no API needed |

#### Summarizer Provider Options

| Provider | `provider` value | Example `model` |
|---|---|---|
| OpenAI / compatible | `openai_compatible` | `gpt-4o-mini` |
| Anthropic | `anthropic` | `claude-3-haiku-20240307` |
| Gemini | `gemini` | `gemini-1.5-flash` |
| AWS Bedrock | `bedrock` | `anthropic.claude-3-haiku-20240307-v1:0` |

### 3. Bridge Modes

The plugin communicates with the Hermes Agent via a **JSON-RPC bridge** (`bridge.cts`), supporting two modes:

**Stdio mode (default)** — Short-lived, reads JSON-RPC from stdin, responds on stdout:

```bash
MEMOS_BRIDGE_CONFIG='...' npx tsx bridge.cts
```

**Daemon mode** — Long-running, listens on a TCP port, also starts the Memory Viewer:

```bash
MEMOS_BRIDGE_CONFIG='...' npx tsx bridge.cts --daemon --port 18992 --viewer-port 18901
```

### 4. Verify Installation

After installing and starting the daemon, open the Memory Viewer at `http://127.0.0.1:18901`.

## Adapters

The plugin includes adapters for different agent frameworks:

### Hermes Adapter

Located at `adapters/hermes/`. Python-based adapter for direct integration with the Hermes Agent.

```bash
cd adapters/hermes
bash install.sh
```

### OpenHarness Adapter

Located at `adapters/openharness/`. For integration via the OpenHarness framework.

```bash
cd adapters/openharness
bash install.sh
```

## How It Works

### Three Intelligent Pipelines

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

### Pipeline 2: Task Generation (auto after memory write)

```
New chunks → Group into user-turns → Process one turn at a time
→ Warm-up (first user turn): assign directly
→ Each subsequent user turn: LLM topic judge
  → "NEW"? → Finalize current task, create new task
  → "SAME"? → Assign to current task
→ Time gap > 2h? → Always split regardless of topic
→ Finalize: Chunks ≥ 4 & turns ≥ 2? → LLM structured summary
```

### Pipeline 3: Skill Evolution (auto after task completion)

```
Completed task → Rule filter (min chunks, non-trivial content)
→ Search for related existing skills
  → Related skill found? → Evaluate upgrade → Merge → Version bump
  → No related skill? → Evaluate create → Generate SKILL.md + scripts
  → Quality score (0-10) → Install if score ≥ 6
```

### Pipeline 4: Smart Retrieval

```
Query → FTS5 + Vector dual recall → RRF Fusion → MMR Rerank
→ Recency Decay → Score Filter → Top-K
→ LLM relevance filter → Dedup by excerpt overlap
→ Return excerpts + metadata
```

## Agent Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Search memories with hybrid retrieval (FTS5 + vector + RRF + MMR) |
| `memory_get` | Get full original text of a memory chunk |
| `memory_timeline` | Get surrounding conversation context around a chunk |
| `task_summary` | Get structured summary of a completed task |
| `skill_get` | Get skill content by skillId or taskId |
| `skill_install` | Install a skill into the agent workspace |
| `memory_viewer` | Get the URL of the Memory Viewer web UI |

### Search Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| `query` | — | — | Natural language search query |
| `maxResults` | 20 | 1–20 | Maximum candidates before LLM filter |
| `minScore` | 0.45 | 0.35–1.0 | Minimum relevance score |
| `role` | — | `user` / `assistant` / `tool` | Filter by message role |

## Memory Viewer

Open `http://127.0.0.1:18901` in your browser after starting the daemon.

| Page | Features |
|------|----------|
| **Memories** | Timeline view, pagination, filters, CRUD, semantic search |
| **Tasks** | Task list with status filters, chat-bubble chunk view, structured summaries |
| **Skills** | Skill list with version history, quality scores, ZIP download |
| **Analytics** | Daily write/read activity charts, memory/task/skill totals |
| **Logs** | Tool call log with input/output and duration |
| **Import** | Memory migration with real-time progress |
| **Settings** | Online configuration and team sharing settings |

**Forgot password?** Click "Forgot password?" on the login page.

## Advanced Configuration

All optional — shown with defaults:

```bash
# In .env or environment variables

# Recall tuning
RECALL_MAX_RESULTS=6          # Default search results
RECALL_MIN_SCORE=0.45         # Default min score threshold
RECALL_RRF_K=60               # RRF fusion constant
RECALL_MMR_LAMBDA=0.7         # MMR relevance vs diversity (0-1)
RECALL_RECENCY_HALF_LIFE=14   # Time decay half-life in days

# Deduplication
DEDUP_SIMILARITY_THRESHOLD=0.75  # Cosine similarity for dedup
DEDUP_ENABLE_SMART_MERGE=true    # LLM judge: DUPLICATE / UPDATE / NEW

# Skill Evolution
SKILL_EVOLUTION_ENABLED=true     # Enable skill evolution
SKILL_AUTO_EVALUATE=true         # Auto-evaluate tasks for skill generation
SKILL_AUTO_INSTALL=false         # Auto-install generated skills

# Viewer
VIEWER_PORT=18901                # Memory Viewer port

# Telemetry (opt-out)
TELEMETRY_ENABLED=true           # Set false to opt-out
```

## Telemetry

MemOS collects **anonymous** usage analytics to help improve the plugin. Telemetry is **enabled by default** and can be disabled at any time.

### What is collected
- Plugin version, OS, Node.js version, architecture
- Tool call names and latencies
- Aggregate counts (chunks ingested, skills installed)
- Daily active ping

### What is NEVER collected
- Memory content, search queries, or conversation text
- API keys, file paths, or any personally identifiable information
- Any data stored in your local database

### How to disable

Set environment variable:

```bash
TELEMETRY_ENABLED=false
```

## Project Structure

```
apps/memos-local-plugin/
├── index.ts                 # Plugin entry — hooks, tool registration, lifecycle
├── bridge.cts               # JSON-RPC bridge (stdio + daemon modes)
├── install.sh               # One-click installer script
├── adapters/
│   ├── hermes/              # Python adapter for Hermes Agent
│   │   ├── plugin.yaml      # Plugin metadata
│   │   ├── config.py        # Configuration
│   │   ├── bridge_client.py # JSON-RPC client
│   │   ├── daemon_manager.py# Daemon lifecycle management
│   │   └── install.sh       # Adapter installer
│   └── openharness/         # OpenHarness adapter
│       ├── plugin.json      # Plugin metadata
│       ├── scripts/         # Python bridge scripts
│       └── install.sh       # Adapter installer
├── src/
│   ├── config.ts            # Configuration schema & defaults
│   ├── types.ts             # TypeScript type definitions
│   ├── capture/             # Message capture & filtering
│   ├── embedding/           # Embedding providers
│   ├── ingest/              # Ingestion pipeline (chunker, dedup, tasks)
│   ├── recall/              # Hybrid retrieval engine (FTS5 + Vector + RRF + MMR)
│   ├── skill/               # Skill evolution pipeline
│   ├── storage/             # SQLite database layer + vector search
│   ├── tools/               # Tool implementations
│   ├── viewer/              # Memory Viewer web server
│   ├── client/              # Hub client & skill sync
│   ├── shared/              # Shared utilities (LLM fallback chain)
│   └── telemetry.ts         # Anonymous usage analytics
├── www/docs/                # Documentation pages
├── package.json
└── tsconfig.json
```

## Development

### Prerequisites

- **Node.js >= 18** (`node -v`)
- **npm >= 9** (`npm -v`)
- **C++ build tools** (for `better-sqlite3` native module):
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install build-essential python3`

### Clone & Setup

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS/apps/memos-local-plugin
npm install
```

### Build

```bash
npm run build       # Compile TypeScript
npm run dev         # Watch mode
```

### From Source

```bash
git clone https://github.com/MemTensor/MemOS.git
cd MemOS/apps/memos-local-plugin
npm install && npm run build
```

## Data Location

| File | Path |
|---|---|
| Database | `~/.hermes/memos-plugin/data/memos.db` |
| Plugin code | `~/.hermes/memos-plugin/` |
| Gateway log | `~/.hermes/memos-plugin/logs/` |

## Troubleshooting

1. **better-sqlite3 native module error** — `Could not locate the bindings file`:
   ```bash
   cd ~/.hermes/memos-plugin && npm rebuild better-sqlite3
   ```
   If rebuild fails, install C++ build tools:
   - macOS: `xcode-select --install`
   - Linux: `sudo apt install build-essential python3`

2. **Viewer won't open** — The viewer starts in daemon mode only. Ensure the daemon is running:
   ```bash
   npx tsx bridge.cts --daemon --port 18992 --viewer-port 18901
   ```

3. **Node version** — Requires Node.js >= 18 and < 25. Check with `node -v`.

## License

MIT — See [LICENSE](../../LICENSE) for details.
