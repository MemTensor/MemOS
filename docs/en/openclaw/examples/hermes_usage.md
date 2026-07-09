---
title: Local Plugin Usage
desc: Basic usage, memory tools, team sharing, and multi-agent examples for the MemOS local plugin in OpenClaw and Hermes.
---

## Basic Usage

`@memtensor/memos-local-plugin` supports both OpenClaw and Hermes. After installation, start the agent you use as usual. The plugin injects local memory context before each task and writes Trace, Policy, World Model, and Skill data after the task finishes.

| Agent | How to start | Viewer |
| --- | --- | --- |
| OpenClaw | Start or restart the OpenClaw gateway normally | `http://127.0.0.1:18799` |
| Hermes | `hermes chat` | `http://127.0.0.1:18800` |

### Verify Memory is Working

1. Have a conversation with OpenClaw or Hermes.
2. Open the corresponding Memory Viewer and confirm the conversation appears in **Memories** / **Tasks**.
3. In a new conversation, ask the agent to recall what you discussed:

```text
You: Do you remember what I asked you to help me with before?
Agent: (Calls memory_search) Yes, we previously discussed...
```

---

## Memory Tools

The local plugin exposes memory tools through each agent host. Exact tool presentation may differ by host, but the core capabilities are shared.

| Tool | Purpose |
| --- | --- |
| `memory_search` | Search across Skill, Trace/Episode, and World Model tiers. |
| `memory_get` | Fetch a memory detail. |
| `memory_timeline` | Inspect an episode / task timeline. |
| `skill_list` | List currently available Skills. |
| `skill_get` | Fetch a Skill invocation guide. |
| `memory_environment` | Query L3 World Models for project structure, environment behavior, and constraints. |

### Call Examples

```text
Agent call:
  memory_search("Nginx deployment config")
  → Returns relevant Skills, Trace snippets, and environment knowledge

Agent call:
  skill_get("nginx-proxy")
  → Returns executable steps, applicability, and caveats
```

The plugin also records tool successes and failures for later decision repair.

---

## Team Sharing

By default, OpenClaw and Hermes use separate local databases. For collaboration, enable Team Sharing from the Memory Viewer to share locally crystallized Skills and optional trace excerpts with other instances on the same LAN / VPN.

### How to Configure

Open the Memory Viewer for the target agent, go to **Settings → Team Sharing**, fill in the team address and tokens as prompted, then save. The Viewer restarts the plugin and loads the new settings.

### Expected Results

- Private local data stays in the current agent's runtime home by default.
- Explicitly shared Skills can be discovered and reused by other instances.
- Hub is not on the algorithm critical path. If sharing fails, local writes, retrieval, and Skill lookup continue to work.

---

## Multi-Agent Scenarios

When OpenClaw and Hermes are installed on the same machine, their ports and data are isolated:

| Resource | OpenClaw | Hermes |
| --- | --- | --- |
| Viewer | `18799` | `18800` |
| Data directory | `~/.openclaw/memos-plugin/` | `~/.hermes/memos-plugin/` |
| Config entry | Viewer → Settings | Viewer → Settings |

```text
OpenClaw:
  memory_search("deploy config")
  → prioritizes OpenClaw's local experience

Hermes:
  memory_search("deploy config")
  → prioritizes Hermes' local experience

With Hub enabled:
  both can explicitly reuse team-shared Skills
```

---

## Viewer Management

The Memory Viewer provides these common entry points:

| Page | Purpose |
| --- | --- |
| Overview | Inspect core status, version, event stream, and health. |
| Memories | Inspect L1 Traces and raw execution records. |
| Tasks | Inspect conversations and execution results grouped by task. |
| Policies | Inspect strategies induced from multiple Traces. |
| World Models | Inspect environment knowledge and constraints. |
| Skills | Inspect, search, or retire crystallized Skills. |
| Import | Import legacy plugin data, OpenClaw session JSONL, Hermes `MEMORY.md`, or import/export JSON backups. |
| Settings | Configure models, team sharing, logs, and telemetry. |
| Help | Look up field meanings such as `V`, `α`, `R_human`, `η`, support, and gain. |
