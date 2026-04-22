# core/logger/

Structured, channelled, durable logging for the whole plugin.

> Goal: anyone reading `~/.<agent>/memos-plugin/logs/` should be able to
> reconstruct what happened, why, and how long it took — without ever opening
> the source code.

## Highlights

- **Always structured.** Every emit produces a `LogRecord` (typed in
  `agent-contract/log-record.ts`). Files and SSE both consume the same shape.
- **Channels, not just levels.** Each business module declares a channel like
  `core.l2.cross-task` or `llm.openai`. You can raise/lower the level per
  channel in `config.yaml`.
- **Six sinks, one logger.**
  - `app-log.ts` → `logs/memos.log`
  - `error-log.ts` → `logs/error.log`
  - `audit-log.ts` → `logs/audit.log` (永不删除：monthly gzip rotation only)
  - `llm-log.ts` → `logs/llm.jsonl`
  - `perf-log.ts` → `logs/perf.jsonl`
  - `events-log.ts` → `logs/events.jsonl`
- **Context auto-injection.** `AsyncLocalStorage` carries
  `traceId / sessionId / episodeId / turnId / agent / userId` through the call
  graph; `logger.info(...)` includes it without you typing it.
- **Redaction first.** Every record passes through `redact.ts` before hitting
  any sink, file, or SSE consumer. Defaults cover api keys, tokens, emails,
  phone numbers, Bearer tokens, JWTs.
- **Rotation.** App/error/perf/llm/events use size+date rotation with gzip and
  configurable retention. Audit uses monthly gzip rotation with **永不删除**
  semantics.
- **SSE broadcast.** Logs (post-redaction) and events stream out through
  `transports/sse-broadcast.ts` so the viewer's *Logs* and *Overview* tabs
  show real-time activity.
- **Memory ring buffer.** The last N entries are kept in-process so
  `/api/logs/tail?live=false` can return immediately.
- **Self-check.** On startup we write a probe record, read it back, and assert
  permissions. Failures fall back to console-only logging instead of crashing.

## Public API

```ts
import { rootLogger } from "./index.js";

const log = rootLogger.child({ channel: "core.l2.cross-task" });

log.info("induce.start", { episodes: ids.length });
{
  using span = log.timer("induce");          // logs to perf.jsonl on close
  await doInduce();
}
log.audit("policy.promoted", { policyId });   // → audit.log (永不删)
log.llm({ provider, model, prompt, completion, tokens, ms });  // → llm.jsonl
log.error("induce.failed", { err });          // → error.log + memos.log
```

The `Logger` interface is in `types.ts`. The factory in `index.ts` builds the
root logger from a `ResolvedConfig + ResolvedHome`, wires sinks, and exports
`rootLogger`.

## Channels (canonical names)

See [`docs/LOGGING.md`](../../docs/LOGGING.md) for the full taxonomy and
per-channel notes. Example prefixes:

| Prefix         | Modules                                                              |
|----------------|----------------------------------------------------------------------|
| `core.session` | `core/session/*`                                                     |
| `core.capture` | `core/capture/*`                                                     |
| `core.reward`  | `core/reward/*`                                                      |
| `core.memory.l1`/`l2`/`l3` | corresponding `core/memory/<lN>/*`                       |
| `core.feedback`| `core/feedback/*`                                                    |
| `core.skill`   | `core/skill/*`                                                       |
| `core.retrieval`| `core/retrieval/*`                                                  |
| `core.pipeline`| `core/pipeline/*`                                                    |
| `core.hub`     | `core/hub/*`                                                         |
| `storage`      | `core/storage/*`                                                     |
| `embedding`    | `core/embedding/*` (per-provider sub-channels possible)              |
| `llm`          | `core/llm/*`                                                         |
| `server`       | `server/*`                                                           |
| `bridge`       | `bridge/*`                                                           |
| `adapter.openclaw` / `adapter.hermes` | corresponding `adapters/*`                    |
| `system`       | startup/shutdown/self-check                                          |

## Edge cases

- **Disk full / permission denied** — file transports degrade to console only
  and emit one error to the in-memory ring buffer (also surfaced via SSE).
- **Process abort** — every transport `flushSync()`s on `beforeExit` and
  `SIGINT`/`SIGTERM`.
- **Audit retention** — never deletes. If you really need to free space, gzip
  archives can be moved out of `logs/` manually.
- **Redaction is best-effort** — exotic key names won't be caught. If you have
  a domain-specific secret, add a rule via `logging.redact.extraKeys` /
  `extraPatterns` in `config.yaml`.

## Testing

- `tests/unit/logger/` covers redaction, rotation, channel filtering, and
  context propagation.
- `tests/helpers/tmp-home.ts` builds a clean logs dir per test.
- `transports/null.ts` lets tests run silently while still exercising the
  full pipeline.
