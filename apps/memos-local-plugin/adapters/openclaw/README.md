# `adapters/openclaw` — MemOS Local OpenClaw Adapter

> Reflect2Evolve V7 memory for [OpenClaw] agents running locally, via a
> TypeScript plugin that imports the shared `memos-local-plugin` core.

[OpenClaw]: https://github.com/memtensor/openclaw

## Overview

OpenClaw hosts load plugins as in-process TypeScript modules. This
adapter exposes a `register(api)` function that wires our
`MemoryCore` into:

- **Turn hooks**: `before_prompt_build` → `onTurnStart`,
  `agent_end` → `onTurnEnd`.
- **Memory tools**: `memory_search`, `memory_get`, `memory_timeline`,
  `skill_list`, `skill_get` — all thin wrappers around `MemoryCore`.
- **Tool-outcome observation**: every tool call's success/failure is
  forwarded to `recordToolOutcome` so decision-repair can react on the
  next turn.

Unlike the Python adapter, OpenClaw runs in-process — no subprocess,
no RPC. All calls are synchronous `MemoryCore` invocations.

## File layout

```
adapters/openclaw/
├── README.md              # ← you are here
├── openclaw-api.ts        # locally re-declared OpenClaw SDK types
│                          # (decouples compile-time from OpenClaw internals)
├── bridge.ts              # flattenMessages, extractTurn, bridgeSessionId,
│                          # renderContextBlock + handleBeforePrompt/handleAgentEnd
├── tools.ts               # TypeBox schemas + tool implementations
└── index.ts               # plugin entry — register(api), bootstrap MemoryCore
```

## Hook wiring

```
┌─────────────────────┐
│ OpenClaw host       │
│                     │   before_prompt_build
│   messages: [...]   │ ───────────────────────▶ handleBeforePrompt
│                     │                               │
│                     │                               ▼
│                     │                         onTurnStart
│                     │◀─── context injected ───     │
│                     │                               │
│   assistant acts    │                               │
│   → tools called    │                               │
│                     │                               ▼
│                     │      agent_end          handleAgentEnd
│                     │ ───────────────────────▶       │
│                     │                                ▼
│                     │                          onTurnEnd
└─────────────────────┘
```

### `handleBeforePrompt` (onTurnStart)

Derives the most recent `user → assistant?` turn from the message
history, opens (or re-uses) a session/episode, and asks the core for
relevant memories. The returned context is rendered via
`renderContextBlock` and inserted into OpenClaw's prompt buffer.

### `handleAgentEnd` (onTurnEnd)

Collects the agent's text response, the list of tool calls it made,
and forwards both to `onTurnEnd`. Each tool call is additionally
replayed through `recordToolOutcome` so decision-repair can aggregate
failure signals per episode.

## Bridge helpers

### `flattenMessages(messages)`

OpenClaw's message format is nested (multi-part content, tool
invocations). `flattenMessages` normalises it to a flat list of
`{role, content}` records that the core's capture layer can ingest
directly.

### `extractTurn(flat)`

Walks backward from the most recent message to find the latest
`user` → `assistant?` pair. Only the latest pair is surfaced — the
rest of the history is left to the core's retrieval layer.

### `bridgeSessionId(agent, sessionKey)`

Hashes `(agent, sessionKey)` into a stable session identifier string.
Ensures the same host session maps to the same `SessionId` for the
lifetime of the OpenClaw process.

### `renderContextBlock(snippets)`

Renders `InjectionSnippet[]` as a markdown block suitable for
inclusion in the prompt. Empty snippet lists yield an empty string
(no marker, so no wasted context window).

## Tool implementations

`tools.ts` defines TypeBox schemas for each memory tool and registers
them with OpenClaw. Each handler:

1. Normalises input (trim strings, clamp limits).
2. Calls the corresponding `MemoryCore` method.
3. Clips output to a reasonable size so tool responses fit in the
   prompt.
4. Wraps the result in JSON-safe shapes (dates → ISO strings, blobs →
   omitted unless requested).

## Config loading

The adapter reads its configuration from
`~/.openclaw/memos-plugin/config.yaml`. On first start, `install.sh`
generates a populated template. All runtime config (embedding
provider, LLM provider, retention policy, sensitive fields) lives
there — there is no `.env` or environment-variable layer.

## Testing

- `tests/unit/adapters/openclaw-bridge.test.ts` — helper + hook tests
  against a real `MemoryCore` with stubbed LLM/embedder.
- `tests/unit/bridge/*.test.ts` — RPC dispatcher + stdio transport
  tests (shared with the Hermes adapter).
