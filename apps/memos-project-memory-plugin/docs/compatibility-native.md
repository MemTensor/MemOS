# Native adapter verification

Six native extensions and two native Skill integrations. Compiled extension entry points are under `dist/adapters/<id>/extension/index.js`. Prime Agent and Doubao Work invoke their own `dist/adapters/<id>/skill-runner.js` for project-memory queries.

| Adapter | Protocol baseline (not a live compatibility certification) | Session / user turn | Delivery / capture |
|---|---|---|---|
| OpenCode v1 | `opencode-ai` 1.19.5 | `sessionID` / `chat.message.output.message.id` | async system transform mounts cached overview + current IDs on every model request; event stream + tool result + SDK session replay |
| OpenCode v2 | plugin 2.0.26, commit `4617210822bdbb31e5749751afbfb4584ccedac8` | prompt hook `sessionID` / `messageID` | promise `session.hook('prompt'/'context')`, async iterable event subscription, cleanup disposes both registrations |
| Kilo CLI | 7.8.27 API research baseline | its own `sessionID` / user message ID | documented `{id, server}` module, OpenCode-style Hooks; own product/config profile |
| Cline CLI | 3.0.74 research baseline; source inspected at `146894b6a42a7a554c6ff37f7bb33fe5122cc33d` | setup core `sessionId` / beforeRun `snapshot.runId` | native AgentPlugin capabilities/hooks; beforeRun appendContext persists; afterModel/afterTool/onEvent and final messages captured |
| Pi | 1.5.2 | sessionManager ID / accepted input boundary UUID | before_agent_start persistent custom message; final idle replay uses agent_settled; message and tool events retain raw data |
| Prime Agent | Rust 0.10.5 | `RLM_SESSION_ID` / parent-linked native user entry | native Skills resolve current identity; local capture reads JSONL and requires `prime-agent list --all --json` to confirm completion |
| Doubao Work | macOS 2.38.3 | `MCP_VM_CONVERSATION_ID` and `DOUBAO_OFFICE_ANSWER_MESSAGE_ID` from the current local shell tool | the service checks the exact native turn and workspace for search and observes `on_message_session_end` for capture |
| DeepSeek Harness | `dsh-v0.2.2-rc.3` research baseline; local `0.2.2-rc.4` previously inspected | session.id / identified source.kind=user message ID | blocking pre-step prepares IDs for a named runtime context; host admission refresh materializes the current snapshot; initial overview commits separately to history |

History hosts acknowledge first overview delivery using `/api/context-delivery`; later user rounds carry current identifiers only. Request-view hosts remount cached context without repeating cloud calls. Local service owns persisted session/turn mapping, upload, retries, and search.

## Installation and startup

For native extensions, the installer writes a small host-specific loader plus the shared Skill and its reference document. Content hashes protect unrelated/user-edited files. OpenCode v1/v2 profiles are mutually exclusive. Cline discovers a `.ts` loader; Pi/OpenCode/Kilo use native extension discovery.

Prime: install or update its integration in Viewer, then restart the host or run `/reload`. Use the normal terminal TUI with the local plugin service running. Five Skills provide search, creation, binding, space listing and unbinding; background capture verifies complete native rounds. The old controlled RPC runner has been removed. Prime requires its native daemon to confirm session completion; a quiet file or a closed terminal alone is insufficient.

For Doubao Work, install the integration in Viewer and bind the selected project to a Space. Restart the desktop app and use `memos-doubao-project-memory` inside the project conversation. The installed file is `~/DoubaoWork/skills/memos-doubao-project-memory/SKILL.md`. Its command takes one shell-quoted question. The local service matches the tool's conversation and answer IDs against host records. Keep the service running for background capture. The host identity probe ran in Doubao's local tool on macOS 2.38.3. Automated upload verification uses a mock cloud endpoint. Live acceptance still includes the app invoking the installed Skill and retrieval and upload against a real Space.

On macOS 2.38.3, read-only replay matched the session, answer, question and workspace at both entry and return of two real shell calls, including one executed from `/`. Of 12 retained successful turns, 10 still had complete native traces. Two lacked a verifiable final reply. The integration test uses synthetic host events, an installed Skill and a loopback mock to cover explicitly selected workspaces, concurrent conversations, a delayed old search result, out-of-order completion and delivery deduplication after restart. The real client sample contained no overlapping conversations.

DeepSeek: installer adds a marked `insert` block to `$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`), shared by all profiles. Skill files use the same DSH home. Plugin entry paths are derived at installation time from the current user's home and the installed package location; no developer machine paths are hardcoded. Restart the selected profile normally, for example `dsh web`; no extra launch overlay is required. Repair upgrades the former standalone-overlay installation and removes its unchanged installer-owned overlay. Uninstall removes only the managed block and owned files, preserving other configuration. The shared YAML file is never part of the whole-file deletion manifest. Installation status checks the managed block and owned files; it does not certify a live model/cloud session. The installer preserves existing block-list YAML text (including Cordis tags and comments), supports empty lists, and reports unsupported YAML layouts without rewriting them.

## Local verification and DSH context

Run `npm test` for the current repository regression suite. Tests use isolated data directories and local fixtures; they do not certify every installed host or real MemOS access. Test counts and historical component runs are not release guarantees.

DSH registers `memos-project-memory:call-context` through `systemPrompt.context()`. The provider reads Agent/session-local state; pre-step prepares identity asynchronously, and DSH admission refresh supplies current IDs to the host-owned runtime snapshot. Initial overview is a separate history message, acknowledged only after its matching session/message commit. Revalidate this behavior against the target installed DSH release before shipping.

## Remaining live acceptance

Fixtures and source inspection do not prove live model behavior or MemOS acceptance. Each adapter requires its own host/model run, installation/uninstallation check, current-turn memory query and cloud upload verification before release claims.

Cline normal CLI uses one root core session per process. Its runtime snapshots omit core sessionId; adapter binds runtime agentId to its sole registered setup session. If multiple unbound core sessions share the same module, it rejects ambiguous routing instead of guessing. This is not a claim of multi-session Hub compatibility.

OpenCode v2 event history replay after disconnection, DeepSeek history restoration through nondeprecated persistence APIs, queue/steering/compaction corner cases, and crash-recovery are not implemented preemptively. Existing realtime raw streams are collected. Prime replays persisted entries with record IDs, not file offsets; token updates lost before host persistence cannot be reconstructed.

## Official source evidence

- [OpenCode v1 Hooks](https://github.com/anomalyco/opencode/blob/v1.19.5/packages/plugin/src/index.ts)
- [OpenCode v2 session hooks](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/plugin/src/promise/session.ts), [promise plugin shape](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/plugin/src/promise/plugin.ts), [event iterator](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/client/src/shared-events.ts)
- [Kilo plugin modules](https://kilo.ai/docs/automate/extending/plugins)
- [Cline plugin guide](https://github.com/cline/cline/blob/146894b6a42a7a554c6ff37f7bb33fe5122cc33d/sdk/.cline/skills/plugin.md), [runtime hooks and snapshot](https://github.com/cline/cline/blob/146894b6a42a7a554c6ff37f7bb33fe5122cc33d/sdk/packages/shared/src/agent.ts)
- [Pi extensions](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md)
- [Prime persisted events](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.5/crates/pa-core/src/session_engine/mod.rs), [native session roster](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.10.5/crates/pa-cli/src/daemon_session_list.rs)
- [DeepSeek events and pre-step](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/core/agent/src/runtime-types.ts), [session](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/core/session/src/index.ts), [official patch structure](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/packages/bundle/base/cordis.patch.yml), [profile launch arguments](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.3/apps/cli/src/args.ts)
