---
title: Local Plugin
desc: Use @memtensor/memos-local-plugin to bring local-first long-term memory, three-tier retrieval, skill crystallization, and an observable management panel to OpenClaw and Hermes Agent.
---

`@memtensor/memos-local-plugin` is the new MemOS local plugin: one local-first memory core for both **OpenClaw** and **Hermes Agent**. It does not host your memory data in the cloud. Instead, it maintains SQLite data, skill packages, and logs on your own machine so the agent can accumulate reusable experience locally.

If you want a cloud-hosted memory service for OpenClaw with the simplest API Key setup, see the [OpenClaw Cloud Plugin](/openclaw/guide). If you care more about privacy, local runtime, observability, or using the same local memory capability across OpenClaw / Hermes, use this local plugin.

## Core Capabilities

| Capability | Description |
| --- | --- |
| Local-first | OpenClaw and Hermes each get an isolated runtime home. SQLite, skills, logs, and config stay on your machine. |
| Dual-agent support | OpenClaw integrates through an in-process TypeScript plugin; Hermes integrates through a Python Provider that talks to the same Node.js memory core over JSON-RPC. |
| Four memory layers | L1 Trace records each execution step, L2 Policy induces cross-task strategies, L3 World Model compresses environment knowledge, and Skill turns high-value experience into callable capabilities. |
| Three-tier retrieval | Retrieval runs across Skill → Trace/Episode → World Model, combining vector, FTS5, keyword pattern, and error-signature channels with RRF + MMR. |
| Feedback-driven evolution | Tool outcomes, environment feedback, and explicit user feedback update memory value and drive policy induction, skill crystallization, and decision repair. |
| Local Viewer | Includes Overview, Memories, Tasks, Policies, World Models, Skills, Analytics, Logs, Import, Settings, and Help pages. |
| Import and migration | Supports JSON import/export, legacy plugin migration, and agent-specific native imports for OpenClaw session JSONL or Hermes `MEMORY.md`. |
| Optional team sharing | Isolated by default. Enable sharing from the Memory Viewer's Team Sharing panel to share crystallized Skills and optional trace excerpts over a LAN / VPN. |

## How It Works

Before each task, the plugin retrieves relevant context and injects it into the agent. After the task ends, it stores conversations, tool calls, observations, and feedback in the local pipeline. High-value patterns gradually become Policies, World Models, and callable Skills. The next time a similar task appears, the agent receives guidance about what to do and what to avoid.

| Stage | What Happens | Output |
| --- | --- | --- |
| 1. Agent adapter | OpenClaw / Hermes send conversations, tool calls, and feedback to the shared `MemoryCore` through their adapters. | Standardized turns, tool outcomes, feedback |
| 2. Local capture | `MemoryCore` turns the execution process into grounded, traceable step records. | L1 Trace |
| 3. Experience induction | Similar Traces are induced into cross-task strategies, then compressed into environment knowledge. | L2 Policy, L3 World Model |
| 4. Skill crystallization | High-value strategies become callable Skills and keep updating reliability from later feedback. | Skill, η, lifecycle status |
| 5. Retrieval injection | Before the next task, Retriever recalls context from Skill, Trace/Episode, and World Model tiers. | Local memory context injected into the agent |

## Quick Start

### Step 1: Install or Upgrade with One Command

Installation and upgrades use the same command. The current installer targets macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh | bash
```

The installer auto-detects whether OpenClaw and/or Hermes are installed. In an interactive terminal, it asks which agent to install for; in non-interactive environments, it installs for the detected agent(s). It deploys plugin code, installs production dependencies, and restarts the target runtime when needed.

> Do not use direct `npm install` as the primary path. The installer handles agent detection, directory layout, config initialization, and runtime restart.

### Step 2: Open the Memory Viewer

After installation, open the corresponding Memory Viewer:

| Agent | Memory Viewer |
| --- | --- |
| OpenClaw | `http://127.0.0.1:18799` |
| Hermes | `http://127.0.0.1:18800` |

If you install both OpenClaw and Hermes, they use separate Viewers and separate local data directories.

### Step 3: Configure from the Panel

All user-facing configuration is done from the Memory Viewer:

- **Settings → AI Models**: configure Embedding, LLM, Skill Evolver, and use Test to confirm connectivity.
- **Settings → Team Sharing**: enable or disable team sharing, then configure team address and tokens.
- **Settings → General**: configure language, detailed logs, anonymous telemetry, and related options.

After saving, the Viewer restarts the plugin and loads the new settings.

### Step 4: Start the Target Agent

After installation, start the agent you selected as usual. The plugin retrieves local context before the agent builds its prompt, then writes conversations, tool calls, observations, and feedback into local memory after the turn finishes.

| Agent | How to start | Plugin integration |
| --- | --- | --- |
| OpenClaw | Start or restart the OpenClaw gateway normally | TypeScript plugin calls `MemoryCore` in the OpenClaw process |
| Hermes | Run `hermes chat` | Python Provider calls the Node.js memory core over JSON-RPC |

If the Hermes machine cannot run Node.js, the Hermes Provider reports unavailable and falls back to Hermes' own in-memory mode.

### Step 5: Verify Memory

Back in the Memory Viewer, check:

1. **Overview**: confirm core status, version, and event stream.
2. **Memories**: confirm conversations and tool steps are written as Traces.
3. **Tasks / Policies / World Models / Skills**: inspect how experience is induced and crystallized.
4. **Import**: migrate legacy data, import OpenClaw session JSONL, import Hermes `MEMORY.md`, or import/export JSON backups.
5. **Help**: look up field meanings such as `V`, `α`, `R_human`, `η`, support, and gain.

## Agent Differences

| Item | OpenClaw | Hermes |
| --- | --- | --- |
| Integration | TypeScript plugin, in-process calls to `MemoryCore` | Python `MemoryProvider`, stdio JSON-RPC to Node bridge |
| Default Viewer | `http://127.0.0.1:18799` | `http://127.0.0.1:18800` |
| Model configuration | Configure in OpenClaw Viewer Settings → AI Models | Configure in Hermes Viewer Settings → AI Models |
| Data sharing | Isolated from Hermes by default | Isolated from OpenClaw by default |

Even on the same machine, the two agents use separate databases and Viewers. They only share data after you explicitly enable `hub:`.

## Available Tools

OpenClaw and Hermes expose memory tools through their own host interfaces. Common capabilities include:

| Tool | Purpose |
| --- | --- |
| `memory_search` | Search across relevant Skills, Trace/Episodes, and World Models. |
| `memory_get` | Fetch a memory detail. |
| `memory_timeline` | Inspect an episode / task timeline. |
| `skill_list` | List callable Skills. |
| `skill_get` | Fetch a Skill invocation guide. |
| `memory_environment` | Query L3 World Models for project structure, environment behavior, and constraints. |

The plugin also records tool successes and failures for later decision repair.

## Data Management

- **Back up**: export JSON from the Viewer's Import page, or back up the current agent's `~/.<agent>/memos-plugin/` directory.
- **Clear only memory**: after confirming you have a backup, delete `data/` and `skills/` under the runtime home.
- **Clear logs**: delete regular files under `logs/`. Audit logs are gzipped monthly and kept by default.
- **Full reset**: delete the entire `~/.<agent>/memos-plugin/` directory. It will be recreated empty on the next start.

## More

- [MemOS local plugin project](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)
- [Cloud Plugin vs Local Plugin](/openclaw/plugin_compare)
