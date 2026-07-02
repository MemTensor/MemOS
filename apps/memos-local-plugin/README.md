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

> [!IMPORTANT]
> **Do not run `npm install -g @memtensor/memos-local-plugin`.**
> This package is a Hermes / OpenClaw plugin, not a standalone CLI. A global
> npm install only downloads the published tarball into your `node_modules`
> tree; it does not deploy the plugin to the agent home (`~/.hermes/plugins/`
> or `~/.openclaw/plugins/`), does not write `config.yaml`, and does not start
> the bridge / viewer. The tarball also intentionally ships **built artifacts
> only** (`dist/` + `viewer/dist/`) — the `viewer/` source, `vite.config.ts`,
> `website/`, tests, etc. live in this repository, not in the npm package.
> Use the `install.sh` / `install.ps1` installer below; it is the only
> supported install path.

The installer downloads the package from npm, deploys it to the right agent
directory, installs production dependencies, writes the initial `config.yaml`,
and restarts the agent runtime when needed.

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

On Windows, run `install.ps1` from PowerShell instead of `install.sh`; the
flags and behavior match.

### Troubleshooting

**`npm install -g @memtensor/memos-local-plugin` says "not found" or "404".**
You are likely on an old version of this README, or trying to install the
package as if it were a standalone CLI. The package is published under the
`@memtensor` scope on the public npm registry, but it is intended to be pulled
in by `install.sh`, not installed globally. Use `bash install.sh` as shown
above.

**I cloned this repo and the `web/` or `site/` directory only contains a
README.md (no `src/`, no `vite.config.ts`, no `index.html`).**
Those directory names are stale. The runtime viewer source lives in `viewer/`
(formerly `web/`), and the unfinished marketing-site scaffolding at `site/`
has been removed entirely. If you see a `web/` or `site/` directory with only
a README, you are looking at a published npm tarball (which only ships
`viewer/dist/`), not a fresh `git clone` of this repository. Clone the repo
to get the full source tree, or just run `install.sh` to deploy the prebuilt
viewer.

## Configuration

The plugin reads its configuration from `config.yaml` in the runtime directory. The location is resolved in the following priority order:

1. **`MEMOS_HOME` environment variable** — points to the runtime root directory (e.g., `/opt/data/.hermes/memos-plugin`)
2. **`MEMOS_CONFIG_FILE` environment variable** — points directly to the config file (e.g., `/opt/data/.hermes/memos-plugin/config.yaml`)
3. **`--home` CLI flag** (bridge.cts only) — specifies the runtime root directory
4. **Default path** — `~/.hermes/memos-plugin/` or `~/.openclaw/memos-plugin/` based on the agent

### Docker Deployment

When running the daemon in a Docker container, you must explicitly specify the config location if it differs from the default path. There are three ways to do this:

#### Option 1: Environment Variable (Recommended)

Set `MEMOS_HOME` to point to the runtime directory:

```dockerfile
ENV MEMOS_HOME=/opt/data/home/.hermes/memos-plugin
CMD ["node", "bridge.cts", "--agent=hermes", "--daemon"]
```

#### Option 2: CLI Flag

Pass `--home` directly to the bridge command:

```dockerfile
CMD ["node", "bridge.cts", "--agent=hermes", "--daemon", "--home=/opt/data/home/.hermes/memos-plugin"]
```

#### Option 3: Config File Path

Set `MEMOS_CONFIG_FILE` to point directly to the config file:

```dockerfile
ENV MEMOS_CONFIG_FILE=/opt/data/home/.hermes/memos-plugin/config.yaml
CMD ["node", "bridge.cts", "--agent=hermes", "--daemon"]
```

### Example Docker Deployment

For the Hermes Agent Docker image:

```dockerfile
FROM nousresearch/hermes-agent:latest

# Install memos-local-plugin
RUN bash -c "$(curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh)"

# Set the config location
ENV MEMOS_HOME=/opt/data/.hermes/memos-plugin

# Start daemon in background, then run Hermes
CMD node /opt/data/.hermes/plugins/memos-local-plugin/bridge.cts --agent=hermes --daemon && hermes chat
```

### Troubleshooting

If you see warnings like:

```
config file not found at /opt/data/.hermes/memos-plugin/config.yaml; using defaults
```

This means the bridge process is looking in the wrong location. Check:

1. Verify your `config.yaml` exists: `ls -la ~/.hermes/memos-plugin/config.yaml`
2. Set `MEMOS_HOME` or use `--home` to point to the correct directory
3. Ensure the path matches the location where `install.sh` created the config

When config is missing, the plugin falls back to defaults (local embedding, no LLM provider), which will break summarization and reflection features.

