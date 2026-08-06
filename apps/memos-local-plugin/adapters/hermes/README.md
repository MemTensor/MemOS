# `adapters/hermes` — MemOS Local Hermes Adapter

> Reflect2Evolve V7 memory for
> [`hermes-agent`](https://github.com/MemTensor/hermes-agent) via the shared
> `memos-local-plugin` core.

## Overview

Hermes is a Python-based agent. The core of `memos-local-plugin` is written
in TypeScript and runs on Node.js. This adapter bridges the two:

```
┌────────────────────────────────────┐     stdio JSON-RPC 2.0     ┌─────────────────────┐
│ Hermes Python process              │                            │ one Node bridge     │
│                                    │                            │                     │
│ Provider(session A) ─┐             │                            │ MemoryCore (core/) │
│ Provider(session B) ─┼─ shared ────┼───────────────────────────▶│                     │
│ Provider(session C) ─┘ runtime     │◀── events / host LLM RPC ─│                     │
└────────────────────────────────────┘                            └─────────────────────┘
```

Each Python provider owns its logical session/episode/turn state. The
process-scoped `SharedBridgeRuntime` owns the physical Node subprocess,
keepalive, reconnect generation, and host callback dispatch. All algorithm
logic (L1/L2/L3, skills, retrieval, feedback, decision repair) remains in the
shared TypeScript core.

## Protocol surface

The adapter calls the following methods on the bridge:

| Hermes hook                  | JSON-RPC method        | Purpose                                           |
| ---------------------------- | ---------------------- | ------------------------------------------------- |
| `initialize(session_id)`     | `session.open`         | Open one logical session in the shared core.      |
| `prefetch(query)`            | `turn.start`           | Retrieve context for injection before model call. |
| `sync_turn(user, assistant)` | `turn.end`             | Persist a completed turn synchronously.           |
| `handle_tool_call("memory_*")` | `memory.search`,      | Explicit memory tools exposed to the model.       |
|                              | `memory.timeline`      |                                                   |
| `submit_feedback(...)`       | `feedback.submit`      | Record explicit user feedback.                    |
| `on_session_end`             | `session.close`        | Close only this logical session.                  |
| `shutdown`                   | (lease release)        | Release this provider without killing the bridge. |

## File layout

```
adapters/hermes/
├── plugin.yaml                 # hermes-agent plugin manifest
├── README.md                   # ← you are here
└── memos_provider/
    ├── __init__.py             # MemTensorProvider — the MemoryProvider impl
    ├── bridge_client.py        # JSON-RPC 2.0 stdio client + thread-safe dispatch
    ├── shared_bridge_runtime.py # Process-scoped ownership, reconnect, hook routing
    └── daemon_manager.py       # Spawn lifecycle + probe for Node availability
```

## Running the bridge

`ensure_bridge_running(probe_only=True)` is called during plugin
startup. If Node.js is unavailable the provider reports
`is_available() == False` and Hermes silently falls back to its in-memory
provider. No deployment artifacts from this adapter are required on
machines that can't run Node.

Otherwise the first provider in a Hermes process starts the packaged bridge
(`dist/bridge.mjs` when available) with `--agent=hermes --no-viewer`.
Subsequent providers acquire leases on the same bridge. The bridge stays alive
until process exit, while each provider independently opens and closes its
logical `sessionId`.

The runtime uses one keepalive loop and a generation-checked reconnect lock.
After a bridge restart, a provider lazily reopens its own logical session before
issuing its next request. Long-running in-flight capture/retrieval calls suppress
keepalive probes so a health timeout cannot kill healthy work.

For emergency rollback, set:

```sh
MEMOS_HERMES_BRIDGE_MODE=legacy
```

This restores the old per-provider lifecycle and should be used only for
diagnosis because it is unsafe when several Hermes sessions coexist.

## Why a subprocess instead of a long-lived daemon?

Earlier prototypes used a persistent HTTP daemon on a well-known port.
That approach required:

- port negotiation and collision handling,
- a stale-process reaper,
- authentication between Python and Node,
- and duplicate log pipelines.

The stdio model gets each of those for free from the OS process model. Sharing
one stdio bridge inside each Hermes process also prevents separate providers
from repeatedly replacing each other's subprocesses while preserving the
reverse `host.llm.complete` callback.

This is process-scoped, not machine-scoped. A future daemon transport can share
one MemoryCore across multiple Hermes OS processes, but it must retain a
bidirectional callback channel before replacing stdio.

## Testing

Python unit tests live under
`apps/memos-local-plugin/tests/python/`. They run against a mocked bridge
(no Node subprocess) to exercise the Hermes-side state machine. Integration
tests that exercise the full stack boot a real bridge subprocess; see
`tests/python/test_shared_bridge_runtime.py` and the Hermes protocol/persistence
tests under `tests/unit/adapters/`.
