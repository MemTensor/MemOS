# Changelog

Notable changes to `@memtensor/memos-local-plugin`. Maintained by hand;
for the full per-commit history use `git log` or the GitHub releases page.

## Index

- `2.0.16` (unreleased) — Add the out-of-tree DeepSeek Harness Cordis
  bundle with capture, six memory tools, DSH profile-aware storage, and one
  automatic recall for every accepted, non-empty direct-user turn. Same-turn
  re-entry is de-duplicated, while greetings and restored-session turns receive
  the same recall treatment as any other direct query. The bridge returns the
  query before its source-labeled `memos-local-memory` context, although other
  DSH context may appear between them. Automatic recall and explicit
  `memos_search` share one absolute deadline (`min(recallTimeoutMs, 3000)` ms;
  3,000 ms by default), and DSH retrieval filtering does not retry malformed
  JSON. Malformed output, provider failure, or a cancellable timeout returns
  the mechanical `safeCutoff` when ranked candidates exist; without candidates,
  recall injects nothing and the tool returns an empty result. A wholly
  non-cancellable provider hits the hard guard at the same effective budget:
  recall preserves the pre-step decision and `memos_search` returns an empty
  result marked `timedOut: true`. Relation/intent/episode routing followed by
  capture (including summary and embedding writes) runs in a per-session serial
  background queue. The next turn and `session/flush` never join prior
  background work, while session
  disposal detaches without joining; committed output becomes visible to later
  automatic recalls and tool calls. These policies are DSH-specific and leave
  OpenClaw and Hermes behavior unchanged. Clean Cordis disposal stops new
  memory work, closes the same-process
  Viewer/SSE server, attempts a bounded
  best-effort drain, and exits the plugin and Viewer with DSH; a second signal,
  crash, or expired shutdown budget can leave an unreplayed capture gap. The
  release also adds fail-open lifecycle handling, per-turn delegation to DSH's
  active model without duplicate credentials, capability-checked no-reasoning
  helper calls for bounded structured output, the existing MemOS HTTP/SSE
  Viewer on configurable port `18801` with enforced localhost/IPv4 loopback
  binding, fail-open Viewer startup with bounded recovery from a transient busy
  port, DSH-opted-in bounded Viewer SSE shutdown,
  Transformers.js 4.2 / ONNX Runtime 1.24.3 for crash-free macOS process exit,
  one-command temporary bootstrap of DSH's pinned `pnpm@11.7.0` when pnpm is
  absent without modifying the user's global package-manager installation,
  and [local installation guidance](./adapters/deepseek-harness/README.md).
- `2.0.6` (unreleased) — Documentation fix: clarify install path and stale
  directory names (#1540).
- `2.0.0-beta.1` — Complete end-to-end implementation: L1/L2/L3/Skill layers,
  three-tier retrieval, decision repair, crystallization, dual adapters,
  HTTP/SSE server, Vite viewer.
- `2.0.0-alpha.1` — Project skeleton, agent-contract layer, install.sh
  entrypoint, viewer directory layout.
