# Hook adapters: implementation and evidence

Implementation date: 2026-11-17. Native profile IDs and cloud agent IDs are explicit in each `profile.ts`. No Memmy code was copied; implementation uses Node built-ins. The package does not import Memmy's L1/L2/L3 behavior.

`versions` records the concrete implementation target/version evidence below. It is **not** a promise that all later versions work. `listAgents()` runs the native executable's `--version`, reports `version-matched`, `unverified`, or `not-detected`; none means end-to-end certified. Unknown versions remain unverified. Desktop binaries may not expose CLI version output.

| Profile | Target evidence | Identity / trace | Context delivery | Remaining verification |
| --- | --- | --- | --- | --- |
| claude-code | 2.1.325 | session_id; prompt hook boundary; transcript_path JSONL | SessionStart/UserPromptSubmit additionalContext | Real host run |
| codex-cli | 0.149.0 locally observed in design research | session_id; prompt hook boundary; rollout response_item/event_msg | additionalContext | Native /hooks trust; rollout version fixture |
| cursor-cli | 2026.10.22 | conversation_id + generation_id; CURSOR_TRANSCRIPT_PATH | sessionStart additional_context | PreToolUse Shell input rewrite binds current IDs for search; **sessionStart remains asynchronous**. Native env output alone is not assumed visible to shell tools |
| copilot-cli | 1.0.112 anchor; 2026-11-17 rolling hook schema | sessionId; transformed-prompt timestamp boundary; transcriptPath | sessionStart additionalContext; userPromptTransformed modifiedTransformedPrompt | New transformed event must be checked against actual installed version; cannot infer release availability from rolling docs |
| grok-build | 1.0.77 anchor; source 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8 | sessionId + promptId; ACP updates.jsonl | PostToolUse additionalContext | PreToolUse terminal input rewrite binds current IDs for search; **no first-token initial injection**. Source crate version 1.0.45 is not release 1.0.77 certification |
| qwen-code | 0.27.4 | session_id + prompt_id; transcript_path; cumulative MessageDisplay versions preserved | additionalContext | Real host run; prompt prefers submitted_prompt |
| kimi-code | 2.6.2 | session_id; prompt boundary; session_index.jsonl exact session ID lookup, wire.jsonl | UserPromptSubmit plain text | Wire context.append_message and tool result records retained; remote shell bridge not implemented |
| factory-droid | 1.12.0 | session_id; prompt boundary; transcript_path | additionalContext | Real host run |
| zcode | 3.18.2 desktop | session_id; prompt boundary; temporary transcript read before returning | structured additionalContext | Real desktop run; no project-level hook deployment |
| trae | CN desktop, no exact build | session_id; prompt boundary; hook payload | additionalContext | **Full transcript path and build unavailable**. Does not implement TRAE CLI |
| antigravity-cli | 1.5.7 | conversationId; native turn ID or exact transcript user-record identity; no turn inferred from model invocation number | SessionStart systemMessage; PreInvocation ephemeralMessage | Actual transcript schema must expose a stable user ID or Hook native turn ID; otherwise current-turn creation identity deliberately absent |
| devin-cli | 3000.12.57 | session_id + prompt_id; hook payload | additionalContext | **Full transcript source not established** |
| deepagents-dcode | 0.2.8 Hooks v2 | session_id; prompt boundary; JSONL projection snapshot identity | additionalContext | Real host run and projection fixture |
| workbuddy | macOS desktop 5.3.14 + bundled engine 2.115.0, locally inspected | session_id + generation_id from session.messageId; SessionStore JSONL path | SessionStart/UserPromptSubmit additionalContext -> hookContexts -> input system reminder | Local source verified, real model end-to-end pending |
| codebuddy-cli | 2.184.0 | session_id + generation_id; transcript_path | additionalContext | Real host run; Windows requires Git Bash |

The bold gaps block the requested complete 22-host acceptance. Fixture tests and successful installation do not resolve them. WorkBuddy support is scoped to the locally inspected desktop/engine combination; other builds remain unverified.

## Runtime and installation

- Entries are `src/adapters/<id>/index.ts`, compiled to `dist/adapters/<id>/index.js`; they parse actual stdin JSON, persist records through `/api/events`, and emit the host-specific output schema.
- History-retaining hosts emit the overview once, acknowledged to SQLite only after writing hook stdout. Kimi observation-only SessionStart never acknowledges; Antigravity request views attach cached context on each model request.
- Cursor/Grok search commands receive current local IDs via native PreToolUse tool-input rewriting, using static host Skill instructions without per-turn shared files.
- Space creation additionally uses `memos-pm create`: Cursor/Grok's installed creation Skill references `$MEMOS_PM_CREATE_CONTEXT`, and PreToolUse binds that variable even while the project is unbound. Grok's first shell call therefore does not require an earlier PostToolUse injection.
- Antigravity creation uses an explicit PreInvocation native turn ID when present; otherwise it streams only user role/ID/source-time metadata from the exact Hook transcript path. It never normalizes or sends transcript bodies for identity registration, never substitutes a model invocation counter or a content hash for a native user ID, and invalidates a prior candidate when a newer genuine user entry lacks an ID. Missing/conflicting/unreadable metadata leaves creation unavailable. Fixture coverage does not replace verification of the installed host's actual transcript schema.
- The installer only touches the selected profile. It preserves other hooks/settings, records owned entries, and removes exact owned entries on uninstall. It does not bypass native trust settings.
- Factory uses a direct event map. Antigravity uses a named hook map. ZCode uses `hooks.events` and `type: process`. Copilot uses `exec` plus `args`. Kimi uses a delimited `[[hooks]]` TOML block; unrelated TOML is retained.
- `CODEX_HOME`, `COPILOT_HOME`, `KIMI_CODE_HOME`, `CODEBUDDY_CONFIG_DIR`, and `WORKBUDDY_CONFIG_DIR` are respected in actual user installs. Explicit `home` in tests isolates all writes.
- Shared Skill source is `skills/project-memory`. Installing Codex and dcode to their common `.agents/skills` directory leaves the Skill until both are uninstalled.
- Subagent transcript requests use the child native ID when both the ID and separate transcript path are present; the parent ID is retained separately.
- Capture, parser caches, SQLite and the Viewer retain full Skill tool calls, arguments, result bodies and execution status. Upload projection alone excludes verified MemOS-owned Skill call/result pairs, including all output from the same mixed shell call; independent search calls and results remain. Other recognized Skills use the existing upload-only summary and completeness checks. Filtering precedes upload validation, size checks and batching. Binding-operation controls retain their existing capture policy. Source namespaces bind to host/session, not ephemeral transcript filenames. Final incomplete JSONL writes are retried on the next read.
- Previously redacted Skill records and caches can be restored from verified native logs; missing logs cannot be reconstructed. Local restoration never rewrites sent snapshots or receipts and never triggers reupload.
- Transcripts are reread and source IDs deduplicated by SQLite. This avoids unstable byte cursors for rewritten projections; large append-only logs still need a measured incremental-reader optimization.
- Hosts that auto-import Claude hooks can execute the same global hook in another product. Disable that native compatibility import when using a separate selected host integration; do not count duplicate imported entry execution as separate validated support.

## Verification performed

`node --test tests/adapters/hooks.test.ts` exercises real subprocess stdin/HTTP/stdout, 15 installation profiles, non-destructive uninstall, exact tool return retention, distinct equal prompts, Antigravity model-loop identity and Qwen cumulative final updates. All temporary-home writes remain outside real host configuration. Native host/model execution and real MemOS cloud acceptance are separate, unperformed checks. WorkBuddy bundled CLI `--version` was executed read-only and returned 2.115.0.

## Primary references checked

- [Claude hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference) — `userPromptSubmitted` config output ignored, **`userPromptTransformed` output can replace model-facing text and is preserved on resume**.
- [Grok source envelope](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-hooks/src/event.rs); local matching source inspected.
- [Qwen hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/)
- [Kimi hooks](https://moonshotai.github.io/kimi-code/en/customization/hooks), [data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
- [Factory hooks](https://docs.factory.com/harness/hooks)
- [ZCode hooks](https://zcode.z.ai/en/docs/hooks)
- [TRAE CN hooks](https://docs.trae.cn/ide_hook-configuration-reference)
- [Antigravity hooks](https://antigravity.google/docs/hooks?tab=cli)
- [Devin hooks](https://docs.devin.ai/cli/extensibility/hooks/overview)
- [Deep Agents hooks](https://docs.langchain.com/oss/deepagents/code/hooks)
- [CodeBuddy hooks](https://www.codebuddy.ai/docs/cli/hooks) (live fetch returned 502; implementation uses previously captured official research in the design workspace).

## Local WorkBuddy evidence (no source copied)

- `/Applications/WorkBuddy.app/Contents/Info.plist`: CFBundleShortVersionString 5.3.14.
- `app.asar/main/app-instance.js`: `configureElectronApp` sets both CODEBUDDY_CONFIG_DIR and WORKBUDDY_CONFIG_DIR to its desktop config directory.
- `app.asar/main/cli-prewarm-pool.js`: passes both config-directory variables to its bundled CLI.
- `app.asar.unpacked/cli/dist/codebuddy.js`: HookManager.getHooks reads settingsManager.get("hooks"); PathUtils.getSettingsFilePath(USER) resolves home/settings.json using CODEBUDDY_CONFIG_DIR; generation-context processor supplies generation_id=session.messageId.
- SessionHookManager.getHookTranscriptPath uses SessionStore.getSessionFilePath(storeId, parentSessionId). UserPromptSubmit/SessionStart accept additionalContext, and the message processor inserts those contexts into input system-reminder blocks.
- Bundled CLI version command returns 2.115.0; package.json's 0.0.0 is a packaging placeholder and is not used as version evidence.
