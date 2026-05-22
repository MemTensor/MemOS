# @memtensor/memos-local-plugin

> Reflect2Evolve memory plugin for AI agents.
> One algorithm core, multiple agent adapters (OpenClaw, Hermes Agent).

## What it is

A local-first, file-backed memory system that gives an agent four cooperating
layers of memory and a feedback-driven self-evolution loop:

- **L1 trace** — step-level grounded records (action + observation + reflection + value).
- **L2 policy** — sub-task strategies induced across many traces.
- **L3 world model** — compressed environmental cognition derived from L2 + L1.
- **Skill** — callable, crystallized capabilities the agent can invoke directly.

The plugin learns continuously from two feedback channels:

- **Step-level** — model ↔ environment (tool result, observation deltas).
- **Task-level** — human ↔ model (explicit ratings + implicit signals).

Reflection-weighted reward is back-propagated along each trace, and high-value
patterns crystallize into reusable Skills. At inference time, a three-tier
retriever (Skill → trace/episode → world model) injects the right context at
the right time.

## Layout (high-level)

```
apps/memos-local-plugin/
├── agent-contract/      # Stable types + JSON-RPC protocol shared with adapters
├── core/                # Agent-agnostic algorithm (memory, reward, retrieval, skill, hub, …)
├── server/              # HTTP + SSE server (powers the viewer)
├── bridge.cts + bridge/ # JSON-RPC bridge (used by Hermes Python adapter)
├── adapters/openclaw/   # In-process TS adapter for OpenClaw
├── adapters/hermes/     # Python adapter that talks to bridge.cts
├── templates/           # config.yaml templates copied to the user's home on install
├── viewer/              # Runtime viewer (Vite, served by server/)
├── docs/                # Developer-facing docs (algorithm, data model, prompts, …)
├── scripts/             # Build / packaging / release helpers
└── tests/               # unit / integration / e2e (vitest)
```

For the full structural breakdown read `[ARCHITECTURE.md](./ARCHITECTURE.md)`.

## Where data lives

The source code never writes to the user's home directly. At install time,
`install.sh` creates a per-agent home folder for runtime state:


| Agent    | Code installed to                         | Runtime data + config in    |
| -------- | ----------------------------------------- | --------------------------- |
| OpenClaw | `~/.openclaw/plugins/memos-local-plugin/` | `~/.openclaw/memos-plugin/` |
| Hermes   | `~/.hermes/plugins/memos-local-plugin/`   | `~/.hermes/memos-plugin/`   |


Inside the runtime folder:

```
config.yaml      # the only config file (includes API keys; chmod 600)
data/memos.db    # SQLite (L1/L2/L3/Skill/Episode/Feedback/…)
skills/          # crystallized skill packages
logs/            # rotating logs (memos.log, error.log, audit.log, llm.jsonl, perf.jsonl, events.jsonl)
daemon/          # bridge pid/port files
```

Upgrading or uninstalling the plugin **never** touches `data/`, `skills/`,
`logs/`, or `config.yaml`.

## Quick start

Use the installer script to deploy or upgrade the plugin. Do not install the
package directly with `npm install`; the script downloads the package, deploys it
to the right agent directory, installs production dependencies, writes the
initial `config.yaml`, and restarts the agent runtime when needed.

From this repository:

```bash
cd apps/memos-local-plugin
bash install.sh --version 2.0.0
```

Or run against the latest published package:

```bash
bash install.sh
```

The installer auto-detects OpenClaw and Hermes. In an interactive terminal it
asks which agent to install for; in non-interactive environments it installs for
the detected agent(s). To test a local package before publishing, pass the
tarball path instead of a registry version:

```bash
npm pack
bash install.sh --version ./memtensor-memos-local-plugin-1.0.0-beta.1.tgz
```

