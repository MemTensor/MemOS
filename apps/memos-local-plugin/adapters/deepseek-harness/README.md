# MemOS local memory for DeepSeek Harness

This adapter loads `@memtensor/memos-local-plugin` as an out-of-tree
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle. It
adds one bounded automatic recall for every accepted direct-user turn,
background capture, and on-demand memory tools to a DSH profile without
modifying the DSH repository.

> [!IMPORTANT]
> DeepSeek Harness is currently a developer preview. The initial compatibility
> target for this adapter is DSH `0.1.0-rc.5`; record the exact DSH version in
> every release's validation because later preview releases may require adapter
> changes. Unit compilation and contract tests currently use the published DSH
> `0.1.0-rc.6` packages; the end-to-end host below is the rc.5 source checkout.

## How it works

The npm package declares a `dsh.bundle.patch`. When `dsh plugin` installs the
package into a profile, DSH adds that patch to the profile's bundle stack and
mounts the compiled adapter as a native Cordis plugin.

```text
DSH profile
  └─ Cordis row: memos-local-memory
       ├─ each accepted user turn ── bounded recall ──> MemoryCore
       ├─ session/event ── enqueue route/classify → capture in background
       ├─ dsh-llm ── auxiliary MemOS calls ──> active DSH provider/model
       ├─ http/sse ── existing MemOS Viewer ──> 127.0.0.1:18801 (default)
       ├─ session/flush ── no MemOS capture barrier
       ├─ session/disposed ── detach without awaiting background work
       ├─ Cordis dispose ── bounded best-effort drain and shutdown
       └─ dsh-tools ── six explicit memory tools
```

Every accepted, non-empty direct-user DSH turn performs one automatic recall.
The same logical turn is de-duplicated if DSH re-enters `agent/pre-step`, but
there is no session-level bootstrap gate and no greeting or intent exception:
`hello` is recalled exactly like any other non-empty direct-user query.
Restored sessions and forks therefore recall for their next accepted turn
regardless of prior direct-user history. Plugin-generated and tool messages do
not trigger automatic recall. The static system-prompt guidance additionally
lets the model call `memos_search` when a shorter or reformulated lookup would
help.

The foreground path performs only the retrieval needed to assemble recalled
context. Automatic recall and explicit `memos_search` share one absolute
deadline: `min(recallTimeoutMs, 3000)` ms. The default is 3,000 ms, and the
configuration may shorten but cannot extend the DSH foreground bound. The DSH
retrieval filter does not retry malformed JSON; a malformed
response, provider failure, or deadline abort falls back to the mechanical
`safeCutoff` over the already-ranked candidates. If no ranked candidate exists,
automatic recall injects no context and `memos_search` returns an empty result.
If a provider ignores cancellation entirely, the adapter's hard guard uses the
same effective budget instead of extending foreground work indefinitely;
automatic recall keeps the original pre-step decision, while `memos_search`
returns `hits: []`, `timedOut: true`, and
`text: "No relevant memories found."`. This path never joins any pending capture,
summary, embedding write, relation classification, intent classification, or
episode routing. Non-empty recall is capped, wrapped in `<memos_context>`, and
appended after the direct query as a DSH user message whose source is
`plugin/memos-local-memory/recall`. The resulting order is therefore query
first, then the source-labeled MemOS context; adjacency is not guaranteed, and
other DSH context contributions may appear between them in the UI.
Plugin-generated messages are excluded from
the query, so recall cannot recursively recall itself. The accompanying
system-prompt guidance marks the block as untrusted historical data rather than
instructions or authority.

DSH awaits `agent/pre-step` before publishing its canonical user event, so each
accepted query can wait for its own bounded recall before its bubble is
rendered. The adapter controls the eventual query-before-context message order,
not that host-side optimistic rendering behavior. No query waits for a prior
turn's capture, relation, intent, summary, or embedding work; the next turn
starts its own recall immediately against the latest committed state.

The adapter then aggregates DSH's structured assistant, native-tool, and
code-dispatch events. At `turn/end` it puts relation/intent/episode routing and
the following `MemoryCore.onTurnEnd()` capture in the same per-session serial
background queue. Their committed results become available to later automatic
recalls and explicit memory-tool calls. The immediately following turn never
waits for that queue; if its own recall or tool search runs before those jobs
commit, it sees the older committed state. DSH's awaited `session/flush` hook is deliberately
not used as a MemOS capture barrier, and session disposal also does not join the
queue. Only Cordis plugin disposal stops accepting new memory work and attempts
a bounded, best-effort drain before shutting down the core.

These foreground and retry policies are scoped to the DeepSeek Harness
adapter. The OpenClaw and Hermes adapters retain their existing recall,
ordering, deadline, and malformed-output behavior.

By default, an otherwise-unconfigured MemOS LLM delegates auxiliary summary,
reflection, and evolution calls to DSH's public `llm` service. The adapter
captures the provider/model route for the owning turn and carries it through an
async-local scope, so concurrent sessions cannot overwrite one another's
route. Credentials remain inside DSH's provider adapter: MemOS neither reads
the DSH API key nor asks the user to configure it a second time. An explicit
MemOS `llm.provider` remains authoritative and can still fall back to DSH when
`fallbackToHost` is enabled.

MemOS filters and JSON extractors use deliberately small output caps. Before
each auxiliary call, the bridge asks DSH's registration-bound `prepareCall()`
to validate the branded `off` effort. A supported `off` disables reasoning for
that helper request; an explicit unsupported-effort result is retried without
an effort so the DSH adapter/provider keeps its own default. The returned
prepared stream binds capability validation and dispatch to the same adapter
registration across HMR. This does not change the agent conversation's
selected reasoning level.

This adapter runs `MemoryCore` and the existing MemOS HTTP/SSE Viewer in the
DSH Node.js process. The Viewer is enabled by default at
`http://127.0.0.1:18801` and shares that same core; the adapter does not start
the MemOS JSON-RPC bridge or a sidecar daemon.

## Install

Prerequisites:

- A Node.js version accepted by the DSH release. DSH `0.1.0-rc.5` requires
  Node.js `^22.19.0 || >=24.0.0`; this stricter host requirement takes
  precedence over the MemOS package's standalone `>=20` engine.
- A working DSH installation. The recommended one-command installer prepares
  an isolated `pnpm@11.7.0` for the install when pnpm is absent. Lower-level
  direct `dsh plugin` commands still require pnpm on `PATH`.
- A provider, model, and API credential already configured and verified with a
  normal DSH prompt. Host delegation avoids configuring that credential again
  in MemOS; it does not make an unconfigured DSH model route usable.
- `@memtensor/memos-local-plugin` version `2.0.16` or newer.

For a published package, the recommended macOS/Linux path is the one-command
installer. It delegates to DSH rather than copying files into the profile:

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/MemOS/main/apps/memos-local-plugin/install.sh \
  | bash -s -- --agent dsh --profile web --version 2.0.16
```

The installer prepares an isolated `pnpm@11.7.0` when pnpm is absent, handles
only the reviewed pnpm build-script set described below, retries the same
registry or local-tarball spec, and verifies that DSH composed the bundle. The
temporary pnpm is removed when the installer exits and does not change the
user's global package-manager setup. It fails closed when the dependency graph
introduces an unreviewed script. Restart the selected DSH profile after
installation.

### Install from a local checkout

Build the package, then install its checkout into the DSH profile you use:

```bash
cd /path/to/MemOS/apps/memos-local-plugin
npm install
npm run build:package
dsh plugin --profile web add .
```

`web` is the profile used for the validation below; replace it with the profile
you actually run. `build:package` compiles both the adapter and the Viewer,
while `dsh plugin` invokes
the DSH profile's pnpm-based package installation.

DSH anchors a local path to the directory where the command is invoked, so
`add .` installs this checkout. If you run DSH from its source repository,
use the DSH repository's launcher and an absolute plugin path instead:

```bash
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /absolute/path/to/MemOS/apps/memos-local-plugin
```

You can also test the exact built artifact that would be distributed:

```bash
cd /path/to/MemOS/apps/memos-local-plugin
npm pack
dsh plugin --profile web add /absolute/path/to/memtensor-memos-local-plugin-<version>.tgz
```

The lower-level registry form is:

```bash
dsh plugin --profile web add @memtensor/memos-local-plugin@<version>
```

Because lower-level `dsh plugin` calls do not pass through the MemOS installer,
they require pnpm on `PATH`. To keep DSH's tested version available for those
commands, install it persistently if needed:

```bash
npm install -g pnpm@11.7.0
```

### Review dependency build scripts

The adapter entry point in a packed tarball is already compiled; it does not
need a TypeScript `prepare` build inside the DSH profile. However, MemOS has
native and generated-code dependencies whose own install scripts pnpm 11
blocks until the profile owner approves them. A first tarball or registry
install can therefore stop with `ERR_PNPM_IGNORED_BUILDS` even though the
adapter itself is prebuilt.

Read the package names in pnpm's error, inspect what each script installs, and
approve only the dependencies you trust. `dsh plugin` forwards this command to
`pnpm approve-builds` in the selected profile:

```bash
dsh plugin --profile web approve-builds
```

For the tested `2.0.16-beta.1` package, pnpm reported `better-sqlite3`,
`esbuild`, `onnxruntime-node`, `protobufjs`, `sharp`, and the MemOS package's
own postinstall hint. Review found that the
required set was `better-sqlite3`, `esbuild`, `onnxruntime-node`, and `sharp`;
`protobufjs` and the package's own postinstall hint were not needed. The
equivalent reviewed profile policy was:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  '@memtensor/memos-local-plugin': false
  better-sqlite3: true
  esbuild: true
  onnxruntime-node: true
  protobufjs: false
  sharp: true
```

Dependency sets can change by package version and platform, so use pnpm's
current output as the source of truth; do not use `approve-builds --all` or
copy this allowlist blindly. Install scripts execute with the current user's
permissions, outside the agent tool sandbox. After approval, rerun the same
`dsh plugin --profile web add ...` command so DSH can finish installation and
reconcile the bundle layer.

The one-command installer automates this exact reviewed policy only when the
pending set contains no other package. Direct `dsh plugin add` users retain the
manual review flow above.

This branch pins Transformers.js to `4.2.0`; the tested lock and DSH profile
resolve Transformers.js 4.2.0 with `onnxruntime-node` 1.24.3. The earlier
Transformers.js 3.x / ONNX Runtime 1.21 combination has a [known macOS destructor
crash](https://github.com/microsoft/onnxruntime/issues/24579), fixed by the
upstream [environment-lifetime
change](https://github.com/microsoft/onnxruntime/pull/26445), when a host calls
`process.exit()` after inference; DSH's graceful signal path does exactly that.
Do not downgrade this dependency in a DSH profile that uses local embeddings.

Verify that DSH composed the bundle before booting it:

```bash
dsh --profile web --dump-config
```

The output should contain a bundle layer for
`@memtensor/memos-local-plugin` and a row with `id: memos-local-memory`.

### Restart requirement

Adding, removing, or updating a bundle changes the profile's installed plugin
set. Use DSH normally: one `Ctrl+C`/`SIGINT` in the foreground, or a normal
`SIGTERM` from a process manager, then start the profile again. No MemOS-only
shutdown command or extra wait is required:

```bash
dsh --profile web
```

When the profile is ready, open `http://127.0.0.1:18801` to inspect and manage
the same memory used by automatic recall, capture, and the `memos_*`
tools.

A running DSH process does not discover a newly installed package. Restart
after rebuilding a linked checkout as well, because imported modules are
cached for the process lifetime. DSH can hot-reload valid edits to a profile's
`cordis.patch.yml`, but restart after changing MemOS `config.yaml` to ensure
the core is rebuilt with the new settings.

## Uninstall

Remove the package from each profile where it was installed, then restart
that profile:

```bash
dsh plugin --profile web remove @memtensor/memos-local-plugin
```

This removes the dependency and bundle layer. It intentionally leaves the
runtime home (`$DSH_HOME/memos-plugin/`, default
`~/.dsh/memos-plugin/`) untouched so memories survive a reinstall. Back up
and remove that directory separately only if you also intend to delete the
stored memory.

## Adapter configuration

The bundle inserts the following Cordis row. To override it for the `web`
profile, place a row with the same `id` in
`$DSH_HOME/profiles/web/cordis.patch.yml` (by default,
`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: memos-local-memory
  config:
    enabled: true
    profileId: default
    home: ''
    recallEnabled: true
    captureEnabled: true
    toolsEnabled: true
    hostLlmEnabled: true
    viewerEnabled: true
    viewerPort: 18801
    recallTimeoutMs: 3000
    contextMaxChars: 6000
    toolResultMaxChars: 1200
    failOnStartupError: false
```

DSH patch layers replace the target row's complete `config` value rather than
deep-merging keys, so keep every field when overriding one.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Mount or disable the adapter. |
| `profileId` | `default` | Fallback namespace; a non-empty session `agentPreset` overrides it consistently for recall, capture, and tools. |
| `home` | `''` | Empty means `$DSH_HOME/memos-plugin` (default `~/.dsh/memos-plugin`); otherwise an absolute or `~`-relative runtime root. |
| `recallEnabled` | `true` | Run one automatic recall for every accepted, non-empty direct-user turn. Re-entry within the same logical turn is de-duplicated; there is no greeting or restored-session exception. |
| `captureEnabled` | `true` | Capture completed DSH turns and tool outcomes. |
| `toolsEnabled` | `true` | Register the six `memos_*` tools. |
| `hostLlmEnabled` | `true` | Reuse the provider/model and credentials already configured in DSH for MemOS LLM work when `llm.provider` is empty; supported helper calls request reasoning `off`, and the bridge also supplies the configured host fallback. |
| `viewerEnabled` | `true` | Serve the existing MemOS Viewer and its HTTP/SSE API in the DSH process. Set to `false` for a headless memory runtime with no Viewer listener. |
| `viewerPort` | `18801` | Integer listener port (`1`–`65535`) for the DSH Viewer. Use a different port when another process or DSH profile already owns `18801`. |
| `recallTimeoutMs` | `3000` | Requested deadline shared by automatic recall, explicit `memos_search`, and the adapter's hard fail-open guard; minimum `100`, with an effective DSH maximum of `3000`. Filter failures use `safeCutoff` when ranked candidates exist. |
| `contextMaxChars` | `6000` | Maximum injected `<memos_context>` size; minimum `256`. |
| `toolResultMaxChars` | `1200` | Maximum body size rendered by memory tools; minimum `128`. |
| `failOnStartupError` | `false` | When `true`, an adapter startup error, including an enabled-Viewer bind failure, fails DSH profile boot. |

### Runtime home and core configuration

Runtime path precedence is:

1. `MEMOS_HOME`
2. `MEMOS_CONFIG_FILE` (its parent becomes the runtime root)
3. the Cordis row's `home`
4. `$DSH_HOME/memos-plugin` when `DSH_HOME` is set
5. `~/.dsh/memos-plugin`

The default layout is:

```text
$DSH_HOME/memos-plugin/            # ~/.dsh/memos-plugin when DSH_HOME is unset
├── config.yaml       # optional MemOS core configuration
├── data/memos.db     # SQLite memory and pipeline state
└── skills/           # crystallized skill packages, when produced
```

On first boot, a missing `config.yaml` produces a warning and uses MemOS
defaults. The default embedder is local; its model may be downloaded on first
use. If that cold work exceeds the current request's deadline (3 seconds by
default), MemOS uses `safeCutoff` when ranked candidates exist; if native work
cannot be cancelled, the adapter continues without the late result while the
load may finish in the background. Later automatic recalls or on-demand
searches can then use the warmed model. Both the local provider and the DSH
adapter enforce this fail-open boundary, so a cold Transformers load cannot
extend the DSH foreground memory boundary beyond the configured
`recallTimeoutMs`.

With `hostLlmEnabled: true`, an empty `llm.provider` is resolved to the DSH host
bridge, so no duplicate MemOS API key is needed after the DSH model route itself
works. The bridge reuses DSH's provider/model route and credential
resolution only; it sends a separate MemOS request and does not inherit the
agent conversation, assembled system prompt, tools, agent reasoning selection,
or agent-loop retry policy. For bounded structured helper calls it requests the
model's declared `off` reasoning effort when available; this avoids spending a
small JSON output budget on hidden reasoning. The agent's own selection is not
modified.
Those auxiliary requests consume the selected provider's normal quota and can
incur cost or rate limits.
The default lightweight pipeline uses that bridge for its summary call. To
enable L2 policy induction, L3 world-model abstraction, and skill
crystallization, set only:

```yaml
algorithm:
  lightweightMemory:
    enabled: false
```

In that opt-in full-memory mode, the adapter disables autonomous startup and
10-minute dirty-episode recovery when the effective MemOS provider is `host`.
Those jobs have no owning DSH request route, and borrowing a route from an
unrelated session would cross a provider/privacy boundary. Turn capture,
session finalization, tool feedback, and explicit memory tools still use the
owning session's captured route. Configure a direct MemOS provider if
autonomous full-memory recovery must perform LLM stages. The default
lightweight mode keeps its local startup cleanup because that path does not run
reward/evolution LLM work.

You can still configure a direct MemOS provider. A non-empty `llm.provider` is
never overwritten; when its `fallbackToHost` is true, eligible provider
failures delegate to the same DSH bridge.

| Adapter/model mode | Result |
| --- | --- |
| `hostLlmEnabled: true`, empty MemOS provider | Use the working DSH route and its credential resolution; no duplicate MemOS key. |
| Explicit MemOS provider | Use that provider and its MemOS-side credential; optionally fall back to DSH. |
| `hostLlmEnabled: false`, empty MemOS provider | Run without an LLM: basic/local memory remains available while model-assisted filtering, summaries, reflection, and evolution skip or use their documented fallback. |

DSH does not currently expose provider-neutral forced JSON/schema output on its
public LLM service. MemOS therefore supplies its JSON contract in the prompt
and parses and validates the returned text locally. For DSH retrieval filtering,
malformed JSON is not retried: the request immediately uses the mechanical safe
cutoff. Other MemOS structured operations and the OpenClaw/Hermes adapters keep
their existing policies. This is best-effort structured output rather than a
provider-enforced schema.

The core configuration schema is shared with the OpenClaw and Hermes adapters;
see [`core/config/README.md`](../../core/config/README.md) and
[`docs/CONFIG-ADVANCED.md`](../../docs/CONFIG-ADVANCED.md). If `config.yaml`
contains credentials, make its permissions owner-only (`0600`).

### Memory Viewer

With `viewerEnabled: true`, the adapter starts the same Viewer and HTTP/SSE
server used by the other MemOS local adapters:

```text
http://127.0.0.1:18801
```

The server is an in-process facade over the adapter's `MemoryCore`. It does
not spawn another Node.js process, open the JSON-RPC bridge, or create a second
database connection owned by a separate memory runtime. Cordis disposal stops
accepting new memory work and Viewer requests, closes active SSE streams, then
gives the bridge only the remaining bounded shutdown window to finish queued
work before shutting down the core. The plugin and Viewer have no independent
daemon: after DSH has exited, neither can remain running. Thus an open Viewer
tab cannot consume DSH's bounded disposal window. This SSE-close policy is an
explicit DSH adapter opt-in; the shared server keeps its existing drain
behavior for OpenClaw and Hermes by default.

Quick Viewer restarts are self-healing. If `viewerPort` is still transiently
busy, recall, capture, and tools become available immediately while the adapter
retries the Viewer bind five times over about 5.75 seconds. A successful retry
restores the panel without another DSH restart.

The bind host comes from the shared MemOS core setting
`viewer.bindHost` and defaults to `127.0.0.1`; the Cordis `viewerPort` field
owns the DSH port instead of `viewer.port` in `config.yaml`. DSH accepts only
`localhost` or an IPv4 `127.*` loopback address for this setting.

> [!WARNING]
> The DSH Viewer currently supports local-machine use only. Keep
> `viewer.bindHost: 127.0.0.1`. The adapter does not wire an HTTP API key into
> the server, and Viewer password protection is off until an `.auth.json`
> exists. A non-loopback value such as `0.0.0.0` or a LAN address is rejected
> instead of exposing the read/write memory API. Do not place the loopback
> listener behind a proxy, tunnel, or port forward.

The Viewer is a standalone MemOS page and is not mounted inside DSH Web at
port `3080`. If several DSH profiles run concurrently, give each enabled
Viewer a distinct `viewerPort`, or leave the Viewer enabled in only one
profile. Profiles that intentionally share a runtime home also share the same
underlying memory, regardless of which profile serves the Viewer.

DSH-specific lifecycle controls are deliberately narrower than OpenClaw and
Hermes. Saving `config.yaml` from Viewer Settings reports that the active DSH
profile must be stopped and restarted manually; the Viewer cannot restart its
parent host. The DSH Viewer hides legacy-database migration and Clear Data.
The server also rejects Clear Data while MemOS is embedded in a running DSH
process, so back up or remove its database only while the profile is stopped.

## Model-facing memory tools

When `toolsEnabled` is true, the adapter registers:

| Tool | Purpose |
| --- | --- |
| `memos_search` | Search skills, traces/policies, and world models; optionally restrict results to the current DSH session. |
| `memos_get` | Fetch bounded details for one `trace`, `policy`, or `world_model` by ID. |
| `memos_timeline` | Reconstruct the ordered traces for an episode. |
| `memos_environment` | List or filter learned world/environment models. |
| `memos_skill_list` | List candidate, active, or archived crystallized skills. |
| `memos_skill_get` | Load one skill and record its use/trial against the active task. |

The model decides when to call these tools. Per-turn automatic recall works
independently of `toolsEnabled`; `memos_search` remains available for a shorter,
rephrased, or explicitly scoped follow-up lookup. Automatic recall and
`memos_search` use the same absolute deadline (`min(recallTimeoutMs, 3000)` ms)
and DSH-specific no-malformed-retry filter policy. When tools
are disabled, the system-prompt guidance omits the tool suggestion. Automatic
recall, capture, and all explicit tools use the same `agentPreset`-aware
namespace resolver.

The default runtime home is shared across DSH profiles and the fallback
`profileId` is `default`. If multiple profiles point at that same home and a
session has no distinct `agentPreset`, they intentionally share a namespace.
Set a unique `profileId` per profile (or a separate `home`) when that sharing is
not desired.

## Failure behavior

Memory is optional to the host agent after Cordis has resolved and loaded the
adapter:

- A MemOS bootstrap failure inside `apply()` logs a warning and leaves DSH
  running without this memory plugin when `failOnStartupError` is false.
- Retrieval-filter failure or timeout returns `safeCutoff` when ranked
  candidates are already available. Without ranked candidates, automatic
  recall injects nothing and explicit `memos_search` returns an empty result.
  If the provider is wholly non-cancellable, the hard guard fires at the same
  effective deadline: automatic recall returns the original DSH pre-step
  decision unchanged, while `memos_search` returns an empty result marked
  `timedOut: true`.
- Capture and tool-observation failures are logged and contained inside the
  per-session write queue.
- A Viewer bind or HTTP-server startup failure is logged and leaves recall,
  capture, and memory tools running when `failOnStartupError` is false. This
  includes a busy port and a non-loopback `viewer.bindHost`. A busy port gets a
  finite background retry window for quick-restart overlap; persistent port
  conflicts and invalid bind settings require correction before a later
  profile restart. When
  `failOnStartupError` is true, the same failure rolls back the MemOS runtime
  and fails DSH profile boot.
- `session/flush` does not wait for MemOS capture or classification work, so a
  slow auxiliary model call cannot delay DSH's durability checkpoint or the
  next agent request.
- Context is bounded and explicitly described as untrusted historical data,
  not instructions or authority. It may also be stale, so
  correctness-sensitive facts should be verified.

Set `failOnStartupError: true` in CI or controlled deployments where silently
running without memory or the configured Viewer is worse than failing the
profile boot. Invalid Cordis configuration, missing modules or peers, schema
validation errors, and failures before `apply()` runs are ordinary DSH load
errors and are not fail-open.

## Privacy and security

- Memory state is stored locally in the configured runtime home. With
  `viewerEnabled: true`, the adapter exposes its read/write memory API and
  Viewer on `127.0.0.1:<viewerPort>` (`18801` by default). Software and users
  on the same machine can reach the listener. Viewer password protection is
  off by default and can be enabled from its Settings page, but the current
  DSH adapter does not support a remote bind. It rejects any `viewer.bindHost`
  other than `localhost` or an IPv4 `127.*` address. Set `viewerEnabled: false`
  when no local UI/API is wanted. No sidecar process is started.
- Captured rows can include direct user text, assistant text and reasoning,
  tool names/arguments/results, code-dispatch output, success/error metadata,
  timestamps, and the session workspace path (`cwd`). Treat the SQLite file as
  sensitive conversation and development data.
- Recalled memory becomes part of the model prompt. It therefore reaches the
  model provider selected by DSH, just like the user's current conversation.
- MemOS auxiliary LLM prompts also reach the provider/model selected for that
  DSH turn when `hostLlmEnabled` is on. The adapter passes a route, messages,
  limits, a capability-checked `off` reasoning effort when available, and an
  abort signal to DSH; it does not access provider credentials or alter the
  agent conversation's reasoning setting.
- Configuring a remote MemOS LLM, embedding provider, or Hub can send data to
  that configured service. Review the core configuration before enabling one.
- The DSH adapter does not construct a MemOS telemetry sender. DSH's own
  telemetry settings remain independent of this plugin. In particular, DSH
  `FULL` telemetry can export projected session events, including message and
  tool data; review or disable DSH telemetry separately.
- An out-of-tree Cordis bundle is trusted Node.js code running inside the DSH
  process, outside the agent tool sandbox. Inspect the source, pin versions or
  commits, and install only artifacts you trust.
- Retrieved memory is historical data, not an instruction authority. Treat it
  as untrusted and potentially stale, especially when it contains copied tool
  output or repository text.

## Known limitations

1. **Developer-preview compatibility.** The initial compatibility target is
   DSH `0.1.0-rc.5`; verify the packaged artifact against that exact host
   before publishing results. Its optional DSH peer range is
   `>=0.1.0-rc.5 <0.2.0`, but that range is not a guarantee across preview
   breaking changes.
2. **Eventual consistency and abrupt-crash replay gap.** Per-turn foreground
   recall never waits for prior capture, relation, or intent work. A completed
   background result is visible to later automatic recalls and explicit tool
   calls only after it commits; the immediately following turn never waits for
   that queue. On a normal `Ctrl+C`/`SIGINT` or `SIGTERM`,
   Cordis disposal attempts a
   best-effort drain within DSH's bounded plugin window (five seconds in
   `0.1.0-rc.5`) and the in-process Viewer and plugin exit with DSH. A second
   signal forces immediate exit. `SIGKILL`, a process crash, terminal-loss
   shutdown without host disposal, or expiry of the budget can leave background
   work unfinished. The OS releases sockets and SQLite recovers its WAL on the
   next open, but a turn can remain uncaptured because restored DSH sessions do
   not currently re-emit the original `session/event` stream and MemOS has no
   durable host receipt to reconcile after restart.
3. **Standalone Viewer only.** DSH serves the existing MemOS Viewer at
   `127.0.0.1:<viewerPort>` by default; it is not embedded into the DSH Web UI
   at port `3080`. Concurrent profiles cannot bind the same Viewer port, so
   configure distinct ports or disable all but one Viewer. Browser cookies on
   the same hostname are shared across ports: Viewers backed by different
   runtime homes still use the same `memos_sess_deepseek-harness` cookie name,
   so logging into one can overwrite the other's session. Prefer one enabled
   DSH Viewer, or isolate them with separate browser profiles.
4. **Best-effort JSON contracts.** DSH's public LLM service has no
   provider-neutral forced JSON/schema option. MemOS validates prompt-guided
   JSON locally and treats truncation, tool calls, empty text, or malformed
   output as failures.
5. **Pre-request route edge.** Each per-turn recall runs before DSH finalizes
   that turn's `agent/request`. It therefore uses the latest persisted request
   route when present, otherwise public agent defaults, and fails open when no
   route exists. Turn-end capture refreshes from the now-persisted current
   route.
6. **Direct-user turns only.** Every accepted, non-empty query whose source kind
   is `user` triggers one automatic recall, including greetings. Re-entry in the
   same logical turn is de-duplicated; plugin and tool messages cannot trigger
   it.
7. **Background recovery has no owning route.** In opt-in full-memory mode,
   startup stale/dirty recovery and the 10-minute dirty-episode rescore run
   outside any DSH request scope. When the effective MemOS provider is `host`,
   the adapter disables those autonomous jobs instead of borrowing an
   unrelated session's route. Configure a direct MemOS provider if this
   recovery must run LLM stages. Normal turn, tool-feedback, explicit-tool,
   and session-close work remains scoped to the owning session. The default
   lightweight mode does not run the LLM-backed reward/evolution recovery path.

中文提示：这是 DSH 的树外 bundle，不修改官方仓库。安装、更新或卸载后需重启
当前 DSH 进程；默认记忆数据保存在 `$DSH_HOME/memos-plugin/`（未设置时为
`~/.dsh/memos-plugin/`），记忆面板默认地址为 `http://127.0.0.1:18801`。
