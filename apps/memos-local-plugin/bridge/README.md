# `bridge/`

> **JSON-RPC 2.0 dispatcher + stdio transport** for non-TypeScript adapters.

Hermes' Python `memos_provider` spawns `bridge.cts` as a subprocess and
speaks JSON-RPC to it over stdin/stdout. In-process TypeScript adapters
(OpenClaw) call `MemoryCore` directly and don't need the bridge at all.

## Files

| File        | Responsibility                                                       |
| ----------- | -------------------------------------------------------------------- |
| `methods.ts` | The `Dispatcher`: maps RPC method names → `MemoryCore` calls, validates params, translates errors into `MemosError.toJSON()`. |
| `stdio.ts`   | Line-delimited JSON-RPC transport. Reads from stdin, writes to stdout, forwards `CoreEvent` + `LogRecord` as notifications. |

The CommonJS entrypoint `../bridge.cts` wires these two together,
bootstraps `MemoryCore`, and starts the stdio loop.

## Method catalogue

All method names are defined in `agent-contract/jsonrpc.ts::RPC_METHODS`
and are stable across plugin versions (additive only).

| Method                | Maps to `MemoryCore.*`                     |
| --------------------- | ------------------------------------------ |
| `core.health`         | `health()`                                 |
| `session.open`        | `openSession({ agent, sessionId? })`       |
| `session.close`       | `closeSession(sessionId)`                  |
| `episode.open`        | `openEpisode({ sessionId, episodeId? })`   |
| `episode.close`       | `closeEpisode(episodeId)`                  |
| `turn.start`          | `onTurnStart(turn)`                        |
| `turn.end`            | `onTurnEnd(result)`                        |
| `feedback.submit`     | `submitFeedback(payload)`                  |
| `memory.search`       | `searchMemory(query)`                      |
| `memory.get`          | `getTrace / getPolicy / getWorldModel`     |
| `memory.timeline`     | `timeline({ episodeId })`                  |
| `skill.list` / `.get` / `.retire` | corresponding `listSkills / getSkill / retireSkill` |
| `subagent.record`     | Record a subagent delegation outcome       |
| `events.subscribe`    | Stream `CoreEvent`s as notifications        |
| `logs.subscribe`      | Stream `LogRecord`s as notifications        |

## Error surface

Every error response uses the standard JSON-RPC envelope. The `data`
field always carries `MemosError.toJSON()` (stable `code` + `message` +
optional `details`), so clients can pattern-match on `error.data.code`
without parsing `error.message`.

## Transport invariants

- **Line-delimited**: each JSON payload is terminated by `\n`.
  Mid-payload newlines are not supported (which is fine — JSON.stringify
  never emits them by default).
- **Single-flight**: the dispatcher processes one request at a time, so
  `MemoryCore` sees RPCs serialised. Concurrent clients must open their
  own bridge processes (Hermes' `daemon_manager.py` enforces one bridge
  per user).
- **Notifications**: events and logs are sent as JSON-RPC *notifications*
  (no `id` field), so clients can drop them without tracking them.

## Tests

- `tests/unit/bridge/methods.test.ts` — dispatcher routing + param
  validation + error normalisation.
- `tests/unit/bridge/stdio.test.ts` — line-framing, request/response,
  notification forwarding, client-hangup handling.
- `tests/unit/adapters/hermes-protocol.test.ts` — TypeScript-side of
  the full Hermes round-trip against a mocked `MemoryCore`.
- `tests/python/test_bridge_client.py` — Python client, mocked subprocess.
