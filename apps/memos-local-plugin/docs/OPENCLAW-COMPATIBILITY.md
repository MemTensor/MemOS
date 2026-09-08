# OpenClaw installation and automatic-memory compatibility

Verified on 2026-09-08 against `main` commit `78a372a4`, using MemOS Local
2.0.16-beta.1. The npm `latest` tag resolved to OpenClaw **2026.9.2**.

## Changes

- The shell installer no longer writes MemOS records into `plugins.installs`,
  which 2026.9.1/2026.9.2 reject. It removes only MemOS-owned legacy records;
  unrelated older records are preserved. Modern installation indexes remain
  managed by OpenClaw.
- Both installers detect noninteractive `gateway stop --force` support, validate
  configuration, and accept capabilities through the host CLI when supported.
  The shell installer additionally detects launchd `--disable`. Plugin help is
  probed with plugins disabled to avoid bootstrapping a runtime from old CLIs.
  The shell restart fallback now requires successful gateway health, rather
  than treating any process listening on the gateway port as healthy.
- Multiple full plugin registries in one process share one MemOS runtime, even
  when the module is reloaded. Each registry gets conversation hooks and tools;
  only the original service owns startup/shutdown. `tool-discovery` gets tool
  factories without starting another runtime or registering conversation hooks.
  The filesystem lock still prevents separate processes owning the same data.

Automatic recall runs through `before_prompt_build` and logs
`memos.onTurnStart`; capture runs through `agent_end` and logs
`memos.agent_end.received` followed by `memos.onTurnEnd`. These are automatic
hooks, not tool calls named `memory_search` or `memory_add`.

## Verified behavior

macOS tests used Node 22.23.1/npm 10.9.8; Windows x64 tests used Node 24.19.0,
npm 11.17.0 and PowerShell 5.1.26100.8875. Separate host versions used isolated
configurations, workspaces and databases. Gateways ran sequentially because
MemOS uses port 18799. Normal services were restored and verified afterward.

| Platform / OpenClaw | Config, startup, tool invocation | Automatic capture and cross-session recall |
| --- | --- | --- |
| macOS 2026.4.24 | Pass | Gateway path passes with client-only workaround; standard agent CLI fails (see below) |
| macOS 2026.7.1-2 | Pass | Pass without workaround |
| macOS 2026.9.1 | Pass | Pass |
| macOS 2026.9.2 | Pass | Not independently exercised on macOS |
| Windows 2026.4.24 | Config passes; gateway readiness times out | Not reached |
| Windows 2026.7.1-2 | Pass | Pass without workaround |
| Windows 2026.9.2 | Pass | Pass |

The full shell installer completed on macOS 2026.9.1. The full patched
PowerShell installer completed on Windows 2026.9.2; the previous PowerShell
installer failed because stopping the gateway required `--force`.

For older-host conversation tests, a local OpenAI-compatible model fixture
returned fixed text without tools. Two different session IDs were used. The
second prompt omitted the first session's unique test code; verification checked
that the code appeared in the second model request. Successful runs produced:

```text
model_requests: 2
traces: 2
distinct_trace_sessions: 2
cross_session_memory_in_model_prompt: true
turn_start_count: 2
turn_end_count: 2
bootstrap_count: 1
tool_ok: true
duplicate_runtime_error: false
```

macOS 2026.9.1 and Windows 2026.9.2 also completed synthetic conversations with
their configured models. SQLite contained the test traces; subsequent recall
logged `hits=1` and `injected=yes` without requiring model tool calls.

## Known limits

- **2026.4.24 macOS agent CLI:** the CLI preloads a full plugin registry in a
  separate process (`ensureCliPluginRegistryLoaded`). With the gateway running,
  this triggers `DuplicateOpenClawRuntimeError` before sending the turn. A
  diagnostic client configuration with plugins disabled let the unchanged
  gateway complete capture/recall, but the standard CLI remains incompatible.
- **2026.4.24 Windows startup:** the initial health RPC timed out after 10 seconds.
  A fresh isolated retry exhausted 120 readiness attempts (about four minutes).
  Sampling showed synchronous filesystem work in OpenClaw's
  `prepareBundledPluginRuntimeDistMirror` / `writeRuntimeModuleWrapper`. Neither
  attempt reached a conversation. This does not establish hook compatibility.
- **Raw archive installation:** on 2026.9.1 and 2026.9.2,
  `openclaw plugins install ./package.tgz --force` failed with npm `ERESOLVE`:
  DSH development dependencies at rc.6 conflict with a transitive rc.8 peer.
  `npm-pack:./package.tgz` installation succeeded but did not build native
  SQLite. Use the MemOS installer, which installs production dependencies and
  rebuilds native modules. This patch does not repair every host installation
  path or change DSH dependencies.
- Windows host upgrades can separately require migration of retired OpenClaw
  configuration and Scheduled Task ownership repair. The plugin installer does
  not rewrite unrelated host settings. One test stop failed its ownership check;
  that run was discarded, the actual gateway process was verified and stopped,
  and tests restarted only after ports were free. A task-start acknowledgement
  alone is not a readiness check.

No claim is made for every intervening or historical OpenClaw release.

## Reproduction and regression checks

```bash
cd apps/memos-local-plugin
npm run lint
npm test
npm pack
bash install.sh --agent openclaw --version ./memtensor-memos-local-plugin-2.0.16-beta.1.tgz
```

On Windows, install the built package through `install.ps1`. The standalone
PowerShell harness extracts the actual installer helpers and tests old/new CLI
flags, native exit codes, capability consent and temporary-environment cleanup:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/powershell/openclaw-install-compat.ps1
```

For host verification, use an isolated state and MemOS home, wait for both the
actual gateway and MemOS health endpoint, invoke `memos_skill_list` through the
authenticated `/tools/invoke` API, then send two different sessions through
`openclaw agent --session-id`. Verify SQLite and the second model request, not
only command exit codes. Do not use `--deliver` for synthetic tests.

Recorded automated results: **184 Vitest files passed, 1569 tests passed,
3 skipped**; lifecycle/lock subset **17 passed**; real PowerShell harness
**7 scenarios passed**. Type checking, package build and `git diff --check`
passed. No Python library code changed. Project formatting used the declared
Ruff version:

```bash
uv tool run --from poetry --with ruff==0.11.8 poetry run make format
```

Output: `All checks passed!` and `624 files left unchanged`.
