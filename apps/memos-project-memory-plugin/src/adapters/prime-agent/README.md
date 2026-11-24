# Prime Agent 0.10.5 (Rust)

The native terminal integration installs `memos-project-memory/SKILL.md` and its
`search.mjs` helper under the host's skills directory. The legacy controlled RPC runner has been removed. Update the integration
in Viewer and restart Prime Agent or run `/reload` to use the native Skills.
The installer removes unchanged legacy files that it previously owned.

## Discovery

`sessions.ts` uses the current user's `.prime/agent/sessions` or the official
`PRIME_AGENT_CODING_AGENT_DIR` / `PRIME_AGENT_SESSION_DIR` environment overrides
(including `~/` expansion). `projects.ts` returns one project for each normalized
absolute `cwd` found in a native session header. Session IDs never become project
IDs. Explicit test homes are isolated from the process environment.

The plugin service must inherit the same directory overrides as Prime. An
arbitrary per-launch `--session-dir` outside these locations is not discovered.

## Skill

The helper runs inside the host tool environment. `RLM_SESSION_ID` is the durable
native session ID exported by Prime's kernel. The helper reads that exact file;
the service verifies its header, current parent-linked user entry, project
binding and activation window before providing local context and search results.
It never chooses the most recent session in a directory. Missing context fails
closed. Project overview and memory are fetched on demand; there is no claim of
automatic pre-prompt injection without a native lifecycle hook.

## Capture and upload

`capture.ts` runs in the plugin's existing sync cycle. A native user entry owns a
round; subsequent assistant reasoning, tool calls, tool results and final answer
are retained. Native entry IDs provide stable deduplication. System/metadata rows
and injected context are excluded by the existing normalization pipeline.

Completion requires both complete newline-terminated records with all known tool
results and `prime-agent list --all --json` proving the exact session is idle,
not generating/compacting/active, and has no unfinished or queued actions. This
also handles `rlm.end_turn()` ending on a tool result. Closing the terminal alone
does not prove completion because Prime can continue in the background.

If the native daemon is unavailable, capture waits and retries on the next sync;
it does not infer completion from a quiet file. Daemonless `--print` alone cannot
provide this status. The ordinary terminal TUI starts the native daemon.

Only rounds admitted after the current Agent/project binding are automatically
captured. Completed rounds use the existing batch queue, per-Space delivery
receipts and upload retry rules. Unfinished or unreadable rounds are not uploaded;
unbinding or uninstalling stops further collection. Existing history is scanned
separately and uploaded only through the explicit history action. The local
plugin service must be running for background collection.

Relevant upstream contracts (pinned to the supported release):

- [Paths](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.5/crates/pa-daemon/src/paths.rs)
- [Kernel identity](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.5/crates/pa-core/src/session_engine/runtime_wiring.rs)
- [Persisted events](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.5/crates/pa-core/src/session_engine/mod.rs)
- [Native roster](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.5/crates/pa-cli/src/daemon_session_list.rs)
