# `adapters/hermes` — MemOS Local Hermes Adapter

> Reflect2Evolve V7 memory for
> [`hermes-agent`](https://github.com/MemTensor/hermes-agent) via the shared
> `memos-local-plugin` core.

## Overview

Hermes is a Python-based agent. The core of `memos-local-plugin` is written
in TypeScript and runs on Node.js. This adapter bridges the two:

```
┌──────────────────────────┐       stdio JSON-RPC 2.0       ┌─────────────────────┐
│  Hermes Python process   │ ─────────────────────────────▶ │  node bridge.cts    │
│                          │                                │                     │
│  MemTensorProvider ──────┼───── turn.start / turn.end ───▶│  MemoryCore (core/) │
│                          │◀──── events.notify ───────────│                     │
│                          │◀──── logs.forward ────────────│                     │
└──────────────────────────┘                                └─────────────────────┘
```

The Python side is **stateless** — every `MemoryProvider` method is a thin
proxy that translates to a JSON-RPC call. All algorithm logic (L1/L2/L3,
skills, retrieval, feedback, decision repair) lives in the shared TS core.

## Protocol surface

The adapter calls the following methods on the bridge:

| Hermes hook                  | JSON-RPC method        | Purpose                                           |
| ---------------------------- | ---------------------- | ------------------------------------------------- |
| `initialize(session_id)`     | `session.open`,        | Open a session + default episode in core.         |
|                              | `episode.open`         |                                                   |
| `prefetch(query)`            | `turn.start`           | Retrieve context for injection before model call. |
| `sync_turn(user, assistant)` | `turn.end` (deferred)  | Persist a completed turn — flushed async.         |
| `handle_tool_call("memory_*")`| `memory.search`,       | Explicit memory tools exposed to the model.       |
|                              | `memory.timeline`      |                                                   |
| `submit_feedback(...)`       | `feedback.submit`      | Record explicit user feedback.                    |
| `on_session_end`             | `episode.close`,       | Close the session and flush pending data.         |
|                              | `session.close`        |                                                   |
| `shutdown`                   | (transport close)      | Kill the subprocess cleanly.                      |

## File layout

```
adapters/hermes/
├── plugin.yaml                 # hermes-agent plugin manifest
├── README.md                   # ← you are here
└── memos_provider/
    ├── __init__.py             # MemTensorProvider — the MemoryProvider impl
    ├── bridge_client.py        # JSON-RPC 2.0 stdio client + thread-safe dispatch
    └── daemon_manager.py       # Spawn lifecycle + probe for Node availability
```

## Running the bridge

`ensure_bridge_running(probe_only=True)` is called during plugin
startup. If Node.js is unavailable the provider reports
`is_available() == False` and Hermes silently falls back to its in-memory
provider. No deployment artifacts from this adapter are required on
machines that can't run Node.

Otherwise the provider spawns `node --experimental-strip-types
bridge.cts --agent=hermes` as a subprocess during `initialize()` and
communicates over its stdin/stdout pipes. The subprocess exits when the
provider's stdin closes (on `shutdown()`), yielding clean lifecycle
semantics.

### Docker / Manual Daemon Startup

When running inside Docker, the bridge may be started by the container's
entrypoint instead of being lazily spawned by the Python adapter. In this
case, pass `--home=<path>` to tell the bridge where its runtime home is:

```bash
node --experimental-strip-types bridge.cts \
  --agent=hermes \
  --daemon \
  --home=/opt/data/home/.hermes/memos-plugin
```

Alternatively, set the `MEMOS_HOME` environment variable. See
[docs/DOCKER.md](../../docs/DOCKER.md) for the full Docker deployment guide.

## Why a subprocess instead of a long-lived daemon?

Earlier prototypes used a persistent HTTP daemon on a well-known port.
That approach required:

- port negotiation and collision handling,
- a stale-process reaper,
- authentication between Python and Node,
- and duplicate log pipelines.

The stdio model gets each of those for free from the OS process model.
Hermes' session lifetime is already bounded, so the cost of one
`node`-spawn per Hermes session is negligible in practice.

## Testing

Python unit tests live under
`apps/memos-local-plugin/tests/python/`. They run against a mocked bridge
(no Node subprocess) to exercise the Hermes-side state machine. Integration
tests that exercise the full stack boot a real bridge subprocess; see
`tests/python/integration/test_hermes_roundtrip.py`.
