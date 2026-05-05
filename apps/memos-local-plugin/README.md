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
├── web/                 # Runtime viewer (Vite, served by server/)
├── site/                # Local-only marketing site + docs + release notes
├── docs/                # Developer-facing docs (algorithm, data model, prompts, …)
├── scripts/             # Build / packaging / release helpers
└── tests/               # unit / integration / e2e (vitest)
```

For the full structural breakdown read [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Where data lives

The source code never writes to the user's home directly. At install time,
`install.sh` creates a per-agent home folder for runtime state:

| Agent    | Code installed to                              | Runtime data + config in                     |
|----------|------------------------------------------------|----------------------------------------------|
| OpenClaw | `~/.openclaw/plugins/memos-local-plugin/`      | `~/.openclaw/memos-plugin/`                  |
| Hermes   | `~/.hermes/plugins/memos-local-plugin/`        | `~/.hermes/memos-plugin/`                    |

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

## Configuration Discovery

The bridge locates its runtime home (and `config.yaml`) using this priority:

1. **`--home=<path>` CLI flag** — passed to `bridge.cts` directly
2. **`MEMOS_HOME` env var** — overrides the runtime home directory
3. **`MEMOS_CONFIG_FILE` env var** — overrides only the config file path
4. **Built-in default** — `~/.<agent>/memos-plugin/` (e.g. `~/.hermes/memos-plugin/`)

When running inside Docker (where the daemon is started by the container's
entrypoint rather than the Python adapter), use `--home` or `MEMOS_HOME` to
ensure the bridge finds its config. See [**Docker Deployment**](./docs/DOCKER.md)
for the full guide.

## Quick start

```bash
# 1) Install the npm package
npm install -g @memtensor/memos-local-plugin

# 2) Run the install script for your agent
memos-local-plugin install openclaw      # or: hermes
# (this is a thin wrapper around install.sh)

# 3) Edit your config (optional)
$EDITOR ~/.openclaw/memos-plugin/config.yaml

# 4) Open the viewer (started automatically by the agent on first turn)
open http://127.0.0.1:18910/
```

For the full hands-on walkthrough see [`site/content/docs/getting-started.md`](./site/content/docs/getting-started.md).

## Validating end-to-end

Once everything is up, follow the scripted checklist in
[`docs/FRONTEND-VALIDATION.md`](./docs/FRONTEND-VALIDATION.md): each line is
"say X to the agent, expect Y on the viewer". Use it to convince yourself the
loop (capture → reward → induce → crystallize → retrieve) is actually working.

## Local development

```bash
# 1) Install workspace deps
npm install

# 2) Run unit tests
npm test

# 3) Develop the viewer
npm run web:dev

# 4) Develop the marketing/docs site (local preview only)
npm run site:dev

# 5) Type-check the whole core
npm run lint
```

## Releasing

Every published version must ship with a release-note markdown:

```bash
npm run release:new -- 2.0.0-beta.2
# edits site/content/releases/2.0.0-beta.2.md
npm run release:index            # regenerates site/content/releases/index.json
npm run release:check            # CI: package.json version <-> release md
npm publish
```

See [`docs/RELEASE-PROCESS.md`](./docs/RELEASE-PROCESS.md).

## License

MIT
