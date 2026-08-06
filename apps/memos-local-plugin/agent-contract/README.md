# agent-contract/

The **only** thing both `core/` and `adapters/<agent>/` are allowed to import
from each other.

## Why this layer exists

`core/` is the algorithm. It must not know what an "OpenClaw conversation
turn" is, and it must not know that Hermes is written in Python.

Adapters live closer to a specific agent runtime. They know about
`onConversationTurn` callbacks, Python provider interfaces, etc.

This directory is the formal contract between the two: a small set of types
with **zero runtime dependencies**, so it can be:

- imported by every TypeScript adapter,
- mirrored to Python (Hermes) without losing fidelity,
- type-checked at the JSON-RPC boundary (`bridge.cts`).

## What lives here

| File              | Purpose                                                         |
|-------------------|-----------------------------------------------------------------|
| `memory-core.ts`  | The `MemoryCore` interface — every method an adapter can call.  |
| `events.ts`       | Every `CoreEventType` literal.                                  |
| `errors.ts`       | Stable error codes + `MemosError` class.                        |
| `dto.ts`          | Wire-shaped DTOs (no methods, no classes).                      |
| `jsonrpc.ts`      | JSON-RPC envelope + canonical method name constants.            |
| `log-record.ts`   | Shape of one log line — Python forwards through the same shape. |

## Compatibility rules

1. **Backwards compatible within a minor version.**
   New optional fields and new event literals are fine; renames or removals are
   breaking and require a major bump + a `BREAKING:` entry in the release note.
2. **No runtime imports.**
   This file should never `import` from `node:*`, `core/*`, `server/*`, or any
   third-party package. If you need `crypto.randomUUID()` etc., do it in `core/`.
3. **Doc keeps up.**
   `docs/EVENTS.md`, `docs/BRIDGE-PROTOCOL.md`, and `docs/ADAPTER-AUTHORING.md`
   reflect the contents of this directory. Update them in the same commit.
