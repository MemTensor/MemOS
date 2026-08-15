# @memtensor/memos-local-plugin

> Reflect2Evolve memory plugin for AI agents.
> One algorithm core, with adapters for OpenClaw, Hermes Agent, and DeepSeek
> Harness.

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
├── adapters/deepseek-harness/ # In-process Cordis bundle for DSH
├── templates/           # config.yaml templates copied to the user's home on install
├── viewer/              # Runtime viewer (Vite, served by server/)
├── docs/                # Developer-facing docs (algorithm, data model, prompts, …)
├── scripts/             # Build / packaging / release helpers
└── tests/               # unit / integration / e2e (vitest)
```

For the full structural breakdown read [ARCHITECTURE.md](./ARCHITECTURE.md).

## Where data lives

Runtime code and user state stay separate. `install.sh` creates the OpenClaw
and Hermes homes; DSH installs the package into a profile with `dsh plugin`
and initializes its runtime home on first boot:


| Agent | Code installed to | Runtime data + config in |
| --- | --- | --- |
| OpenClaw | `~/.openclaw/plugins/memos-local-plugin/` | `~/.openclaw/memos-plugin/` |
| Hermes | `~/.hermes/plugins/memos-local-plugin/` | `~/.hermes/memos-plugin/` |
| DeepSeek Harness | Profile dependency managed by `dsh plugin` | `$DSH_HOME/memos-plugin/` (default `~/.dsh/memos-plugin/`) |


Inside the runtime folder:

```
config.yaml      # MemOS core config (includes API keys; chmod 600 when written)
data/memos.db    # SQLite (L1/L2/L3/Skill/Episode/Feedback/…)
skills/          # crystallized skill packages
logs/            # rotating logs (memos.log, error.log, audit.log, llm.jsonl, perf.jsonl, events.jsonl)
daemon/          # bridge pid/port files
```

An adapter creates only the directories it uses. DSH runs `MemoryCore` and the
existing HTTP/SSE Viewer in the DSH Node.js process, without a JSON-RPC bridge
or sidecar daemon. The Viewer listens on `http://127.0.0.1:18801` by default;
set `viewerEnabled: false` in the DSH Cordis row to run without that listener.
DSH still leaves MemOS file logging to the host, so its normal runtime surface
is an optional `config.yaml`, `data/`, and `skills/` when skills are produced.

Uninstalling the plugin does not delete `data/`, `skills/`, `logs/`, or
`config.yaml`. Startup after an upgrade may migrate the SQLite schema, so back
up the runtime directory before upgrading.

## Quick start

> [!IMPORTANT]
> **Do not run `npm install -g @memtensor/memos-local-plugin`.**
> This is an agent plugin package, not a standalone CLI. A global
> npm install only downloads the published tarball into your `node_modules`
> tree; it does not wire OpenClaw, Hermes, or DSH. The tarball ships the built
> runtime plus the source and metadata required by the agent installers; the
> `viewer/` source, `website/`, tests, and other development-only files remain
> in this repository.
> Use `install.sh` / `install.ps1` for OpenClaw or Hermes. For DeepSeek
> Harness, use the Unix installer's `--agent dsh` target or DSH's
> lower-level `dsh plugin` command.

For OpenClaw and Hermes, the installer downloads the package from npm, deploys
it to the right agent directory, installs production dependencies, writes the
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

On Windows, run `install.ps1` from PowerShell instead of `install.sh` for
OpenClaw or Hermes. The DSH one-command target currently supports macOS/Linux;
Windows users can use DSH's lower-level `dsh plugin` flow.

### DeepSeek Harness

DSH support is an out-of-tree Cordis bundle. The one-command installer keeps
DSH in control of its profile while handling pnpm's reviewed native dependency
build policy non-interactively. If `pnpm` is not already on `PATH`, it prepares
an isolated `pnpm@11.7.0` for that installer run without changing the user's
global package-manager setup:

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh \
  | bash -s -- --agent dsh --profile web --version 2.0.16
```

The installer delegates package ownership and bundle reconciliation to
`dsh plugin`. If pnpm reports the reviewed build-script set, it enables
`better-sqlite3`, `esbuild`, `onnxruntime-node`, and `sharp`, explicitly
disables the unnecessary `protobufjs` and MemOS hint scripts, retries the same
package spec, and verifies the composed `memos-local-memory` row. Any unknown
build-script package fails closed for manual review; the installer never uses
`approve-builds --all`.

The temporary pnpm is removed when the installer exits. It is not needed for
normal `dsh --profile ...` runtime use. Users who later run lower-level
`dsh plugin` commands directly still need pnpm on `PATH`; install the DSH-pinned
version persistently with `npm install -g pnpm@11.7.0` if desired.

To develop from a local checkout instead, build it and add it to the desired
DSH profile directly:

```bash
cd /path/to/MemOS/apps/memos-local-plugin
npm install
npm run build:package
dsh plugin --profile web add .
```

The adapter reuses the provider/model and credentials already configured in
DSH for MemOS auxiliary LLM calls by default; no second API key is required.
For bounded structured helper calls it uses a model-advertised `off` reasoning
effort when available, without changing the agent conversation's selection.
An explicit MemOS LLM provider remains available as an override.

Every accepted, non-empty direct-user DSH turn performs one automatic recall,
including greetings; there is no greeting or intent-classification exception,
and re-entry in the same logical turn is de-duplicated. The query is ordered
before the source-labeled `memos-local-memory` context, although other DSH
context contributions can appear between them. Restored sessions and forks
follow the same per-turn rule, while plugin and tool messages do not
trigger automatic recall. The model can additionally call `memos_search` for a
shorter or reformulated lookup.

Automatic recall and explicit `memos_search` share one absolute deadline:
`min(recallTimeoutMs, 3000)` ms. The default is 3,000 ms, and configuration may
shorten but cannot extend this DSH foreground bound. DSH retrieval
filtering does not retry malformed JSON; malformed output, provider failure,
or a cancellable timeout falls back to the mechanical
`safeCutoff` over ranked candidates. With no ranked candidates, automatic
recall injects nothing and the tool returns an empty result. A completely
non-cancellable provider hits the hard guard at the same effective deadline;
automatic recall preserves the original query path, while `memos_search`
returns an empty result marked `timedOut: true`. DSH awaits `agent/pre-step`,
so a query bubble can still appear only after that turn's bounded recall, but the
final order remains query then context. Capture, relation, intent, summaries,
and embeddings remain background work, and the next turn never waits for the
previous turn's queue. These DSH-specific policies do not change OpenClaw or
Hermes behavior.

After the DSH profile starts, open the existing MemOS Viewer at
`http://127.0.0.1:18801`. The server shares the adapter's in-process
`MemoryCore`; it is not a second memory runtime or a sidecar process. The
Cordis fields `viewerEnabled` and `viewerPort` control whether it starts and
which port it uses; the shared `config.yaml` field `viewer.bindHost` defaults
the bind interface to `127.0.0.1`. The DSH Viewer is currently supported for
local-machine use only and accepts only `localhost` or an IPv4 `127.*`
loopback address. A normal one-`Ctrl+C`/`SIGINT` or `SIGTERM` restart needs no
MemOS-specific stop command or port wait: active Viewer SSE streams are closed,
and a transient busy Viewer port retries in the background.

See the [DeepSeek Harness adapter guide](./adapters/deepseek-harness/README.md)
for exact Node compatibility, `DSH_HOME`, restart/uninstall steps, and the
reviewed pnpm approval flow for native/transitive dependency install scripts,
Viewer lifecycle, and port-conflict behavior.

### Troubleshooting

**`npm install -g @memtensor/memos-local-plugin` says "not found" or "404".**
You are likely on an old version of this README, or trying to install the
package as if it were a standalone CLI. The package is published under the
`@memtensor` scope on the public npm registry, but it is intended to be pulled
in by an agent-specific installer, not installed globally. Use
`bash install.sh` for OpenClaw/Hermes or `dsh plugin` for DSH as shown above.

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

The shared MemOS core reads `config.yaml` from the runtime directory. DSH host
controls such as `viewerEnabled` and `viewerPort` live in the profile's Cordis
row; shared Viewer settings such as `viewer.bindHost` remain in `config.yaml`.
The runtime/config location is resolved in the following priority order:

1. **`MEMOS_HOME` environment variable** — points to the runtime root directory (e.g., `/opt/data/.hermes/memos-plugin`)
2. **`MEMOS_CONFIG_FILE` environment variable** — points directly to the config file (e.g., `/opt/data/.hermes/memos-plugin/config.yaml`)
3. **Adapter-specific explicit home** — the DSH Cordis `home` field or the `--home` bridge flag
4. **`DSH_HOME`** (DSH only) — defaults the DSH memory root to `$DSH_HOME/memos-plugin/`
5. **Default path** — `~/.hermes/memos-plugin/`, `~/.openclaw/memos-plugin/`, or `~/.dsh/memos-plugin/` based on the agent

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

When config is missing, the plugin falls back to defaults (local embedding,
no LLM provider). Lightweight trace memory still works; LLM-dependent
reflection and evolution are skipped or degraded until a provider is
configured.
