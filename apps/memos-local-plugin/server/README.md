# `server/` — HTTP + SSE surface

This module exposes the `MemoryCore` over HTTP. It's used by:

1. the **Vite viewer** (`viewer/`) for rendering the local dashboard;
2. the **bridge** (`bridge.cts`) when hosts opt into HTTP as an
   out-of-process transport instead of JSON-RPC-over-stdio.

## Design intent

- **Zero framework**. The server uses only `node:http` + small hand-
  written helpers. That keeps the attack surface tiny and makes the
  behaviour auditable line-by-line — a property we lean on heavily for
  the loopback default + API-key gate.
- **Loopback-first**. `host` defaults to `127.0.0.1`. A multi-user
  deployment must explicitly opt into `0.0.0.0` *and* set `apiKey`.
- **Thin over core**. No business logic. Every handler calls exactly
  one `MemoryCore` method and serialises the result.

## Layout

```
server/
├── README.md              # ← you are here
├── ALGORITHMS.md          # invariants & failure modes
├── index.ts               # export barrel (startHttpServer, types)
├── http.ts                # listen(), request dispatch, error wrapper
├── types.ts               # ServerOptions / ServerHandle / ServerDeps
├── middleware/
│   ├── io.ts              # body reader + JSON writers
│   ├── auth.ts            # api-key gate (Bearer + X-API-Key)
│   └── static.ts          # safe static-file serving (viewer)
└── routes/
    ├── registry.ts        # flat (method + path) → handler map
    ├── health.ts          # /api/v1/health, /api/v1/ping
    ├── session.ts         # /api/v1/sessions, /api/v1/episodes
    ├── memory.ts          # /api/v1/memory/search|trace|policy|world
    ├── skill.ts           # /api/v1/skills (list|get|retire)
    ├── feedback.ts        # /api/v1/feedback
    ├── events.ts          # /api/v1/events  (SSE — CoreEvent)
    └── logs.ts            # /api/v1/logs    (SSE — LogRecord)
```

## REST API

| Method | Path                                    | Purpose                           |
| ------ | --------------------------------------- | --------------------------------- |
| GET    | `/api/v1/health`                        | Core health snapshot              |
| GET    | `/api/v1/ping`                          | Liveness check                    |
| POST   | `/api/v1/sessions`                      | Open a session                    |
| DELETE | `/api/v1/sessions?sessionId=…`          | Close a session                   |
| POST   | `/api/v1/episodes`                      | Open an episode                   |
| DELETE | `/api/v1/episodes?episodeId=…`          | Close an episode                  |
| GET    | `/api/v1/episodes?sessionId=…&limit=…`  | List episodes                     |
| GET    | `/api/v1/episodes/timeline?episodeId=…` | Ordered traces                    |
| POST   | `/api/v1/memory/search`                 | Three-tier retrieval              |
| GET    | `/api/v1/memory/trace?id=…`             | Fetch a trace by id               |
| GET    | `/api/v1/memory/policy?id=…`            | Fetch a policy by id              |
| GET    | `/api/v1/memory/world?id=…`             | Fetch a world-model entry by id   |
| GET    | `/api/v1/skills?status=…`               | List skills                       |
| GET    | `/api/v1/skills/get?id=…`               | Fetch a skill                     |
| POST   | `/api/v1/skills/retire`                 | Retire a skill                    |
| POST   | `/api/v1/feedback`                      | Submit user feedback              |

## SSE streams

### `GET /api/v1/events`

Streams every `CoreEvent` the algorithm core emits. Each message uses:

```
event: retrieval.started
id: 12345
data: {"type":"retrieval.started", …}
```

Reconnects with `Last-Event-ID` are supported by the browser's
`EventSource` API.

### `GET /api/v1/logs`

Streams every post-redaction `LogRecord`. Initial connection is
pre-populated from the `logTail` provider for instant hydration; the
stream continues live after that.

The server applies a 200 msg/sec rate-limit per connection so a noisy
channel can't saturate the socket.

### `GET /api/v1/logs/tail?n=…`

Plain JSON fallback for clients that can't hold SSE open
(server-rendered pages, curl scripts, tests).

## Auth

A running server is effectively a `MemoryCore` handle — anyone who
can talk to it can read every memory, skill, and event. Two
protections apply:

1. **Default bind = 127.0.0.1.** Only processes on the same machine
   can reach the socket.
2. **Optional `apiKey`.** When set, every `/api/*` request must carry
   `Authorization: Bearer <key>` or `X-API-Key: <key>`. Missing /
   mismatched keys yield `401` (not `403` — we don't confirm whether a
   resource exists before auth passes).

## Static assets

If `staticRoot` is set, the server serves files under that directory
for any non-`/api/*` path. Directory traversal attempts are caught by
resolving the requested path against the root and ensuring
containment. `/` and `/viewer` are both rewritten to `index.html`.

## Testing

- `tests/unit/server/http.test.ts` — REST routes + auth gating (14
  tests).
- `tests/unit/server/sse.test.ts` — SSE event + log streams (3 tests).

Both use `startHttpServer` against a stub `MemoryCore`, so the
entire HTTP stack is exercised end-to-end without touching the real
pipeline.
