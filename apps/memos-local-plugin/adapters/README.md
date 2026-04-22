# `adapters/` — Agent adapters

The `core/` package implements the Reflect2Evolve V7 algorithm as a
single agent-agnostic library. Adapters translate between a specific
agent host (OpenClaw, Hermes, potentially others) and the public
`MemoryCore` facade defined in `agent-contract/memory-core.ts`.

Each adapter owns:

1. **Protocol binding** — how a host event (hook, RPC, webhook) is
   translated into a `MemoryCore` method call.
2. **DTO shape conversion** — the host's payload schemas are converted
   to the canonical DTOs in `agent-contract/dto.ts`. Any
   host-proprietary types stay inside the adapter.
3. **Transport** — TypeScript adapters import `MemoryCore` directly;
   non-TypeScript adapters (e.g. Python) go over JSON-RPC 2.0 via the
   shared bridge (`bridge.cts`, `bridge/methods.ts`, `bridge/stdio.ts`).
4. **Lifecycle** — register / unregister, graceful shutdown.

## Layout

```
adapters/
├── README.md                 # ← you are here
├── openclaw/                 # OpenClaw plugin (TypeScript, in-process)
│   ├── README.md
│   ├── openclaw-api.ts       # locally re-declared OpenClaw SDK types
│   ├── bridge.ts             # OpenClaw events ↔ MemoryCore DTOs
│   ├── tools.ts              # memory_search, memory_get, … tool registrations
│   └── index.ts              # register(api) — plugin entry point
└── hermes/                   # hermes-agent plugin (Python, out-of-process)
    ├── README.md
    ├── plugin.yaml
    └── memos_provider/
        ├── __init__.py       # MemTensorProvider — MemoryProvider impl
        ├── bridge_client.py  # JSON-RPC stdio client
        └── daemon_manager.py # Node.js availability probe
```

## Bridge architecture

Adapters speak to `MemoryCore` in one of two ways:

### In-process (TypeScript)

```
┌──────────────────────┐   direct call   ┌──────────────────────┐
│  OpenClaw plugin     │ ──────────────▶ │  MemoryCore          │
│  (adapters/openclaw) │                 │  (core/pipeline)     │
└──────────────────────┘                 └──────────────────────┘
```

The OpenClaw adapter runs inside the OpenClaw host's Node process, so
it imports the `MemoryCore` implementation and invokes it synchronously.

### Out-of-process (Python)

```
┌──────────────────────┐   stdio JSON-RPC   ┌──────────────────────┐
│  Hermes plugin       │ ─────────────────▶ │  node bridge.cts     │
│  (adapters/hermes)   │                    │  → MemoryCore        │
└──────────────────────┘                    └──────────────────────┘
```

The Python adapter spawns `node --experimental-strip-types bridge.cts
--agent=hermes` as a child process and communicates via its stdin/stdout
pipes using line-delimited JSON-RPC 2.0 messages.

## Adding a new adapter

1. Add a folder under `adapters/<your-agent>/`.
2. Decide in-process (TS import) vs. out-of-process (JSON-RPC).
3. Translate your host's turn-start / turn-end hooks to `MemoryCore.onTurnStart`
   and `MemoryCore.onTurnEnd`. Keep `userText` and `agentText` verbatim.
4. Wire any tool invocations the host exposes (memory search, timeline,
   etc.) to the corresponding `searchMemory` / `timeline` methods.
5. Propagate explicit feedback via `submitFeedback` and tool failures via
   `recordToolOutcome`.
6. Close sessions and episodes on host shutdown.
7. Add per-adapter unit tests under `tests/unit/adapters/<your-agent>-*.test.ts`.

## See also

- [`adapters/openclaw/README.md`](./openclaw/README.md)
- [`adapters/hermes/README.md`](./hermes/README.md)
- [`ALGORITHMS.md`](./ALGORITHMS.md) — invariants enforced by the adapter layer
