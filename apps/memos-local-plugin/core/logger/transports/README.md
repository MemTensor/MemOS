# core/logger/transports/

Low-level outputs. Each transport accepts a redacted `LogRecord` and writes
it somewhere. Transports MUST NOT throw on write — failures are caught and
surfaced via the `memory-buffer` ring (which the SSE broadcaster picks up).

| Transport            | Output                                          |
|----------------------|-------------------------------------------------|
| `console.ts`         | Process stdout/stderr (pretty or json/compact). |
| `file-rotating.ts`   | Rotating file with size + date + gzip.          |
| `jsonl-events.ts`    | Append-only JSON Lines (no rotation, just gzip on Sundays). |
| `sse-broadcast.ts`   | In-process EventEmitter consumed by `server/sse.ts`. |
| `memory-buffer.ts`   | Bounded ring buffer for `/api/logs/tail?live=false`. |
| `null.ts`            | Silent (used in tests).                         |
