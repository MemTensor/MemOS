# Logging

The `core/logger/` directory implements **all** logging for the plugin. This
document explains how it's wired, what each channel means, what each sink
holds, and how retention works.

## Quick mental model

```
emit() → channel-level filter → redactor → fan-out to N sinks → transports → file/console/SSE/buffer
```

- One `LogRecord` shape for everything (`agent-contract/log-record.ts`).
- Three orthogonal axes: **level** (trace…fatal), **kind** (app/audit/llm/perf/events/error), **channel** (`core.l2.cross-task` …).
- Sinks select on `kind`; transports do not. Channel-level filtering happens at
  emit time so every transport in the same sink gets the same set.

## Files on disk

```
~/.<agent>/memos-plugin/logs/
├── memos.log               human-readable main log (rotates by size + day, gzipped)
├── error.log               WARN/ERROR/FATAL across every channel
├── audit.log               永不删除 — monthly gzip rotation only
├── llm.jsonl               every LLM call: provider, model, op, latency, tokens, status
├── perf.jsonl              every `logger.timer(...)` close
├── events.jsonl            every CoreEvent (also broadcast over SSE)
└── self-check.log          startup probe results (tiny)
```

## Retention policy

| Sink   | Rotation             | Retention                           |
|--------|----------------------|--------------------------------------|
| `app`  | size + day, gzip     | last `logging.file.retentionDays` (default 30) |
| `error`| size + day, gzip     | same as `app`                       |
| `audit`| month, gzip          | **永不删除**                          |
| `llm`  | day, gzip            | **forever** (cheap; line-format)    |
| `perf` | day, gzip            | **forever**                         |
| `events`| day, gzip           | **forever**                         |

Audit/LLM/perf/events being kept forever is intentional: those streams enable
post-hoc debugging and compliance. They're append-only JSONL, gzipped after
each rotation, so disk cost stays modest.

## Levels

`trace < debug < info < warn < error < fatal`. Set the global default in
`logging.level`; override per channel in `logging.channels`:

```yaml
logging:
  level: info
  channels:
    "core.l2": debug
    "core.l2.cross-task": trace      # longer prefix wins
    "llm.openai": info
```

## Channels

The full canonical list lives in `core/logger/channels.ts`. Quick reference:

| Prefix              | Owner module(s) |
|---------------------|-----------------|
| `core.session.*`    | `core/session/` |
| `core.capture`, `core.capture.extractor`, `core.capture.reflection`, `core.capture.alpha`, `core.capture.embed` | `core/capture/` |
| `core.reward`, `core.reward.task-summary`, `core.reward.r-human`, `core.reward.alpha`, `core.reward.backprop`, `core.reward.priority` | `core/reward/`  |
| `core.memory.l1.*`  | `core/memory/l1/` |
| `core.memory.l2`, `core.memory.l2.associate`, `core.memory.l2.candidate`, `core.memory.l2.induce`, `core.memory.l2.gain`, `core.memory.l2.events` | `core/memory/l2/` |
| `core.memory.l3`, `core.memory.l3.cluster`, `core.memory.l3.abstract`, `core.memory.l3.merge`, `core.memory.l3.confidence`, `core.memory.l3.feedback`, `core.memory.l3.events` | `core/memory/l3/` |
| `core.episode.*`    | `core/episode/` |
| `core.feedback`, `core.feedback.signals`, `core.feedback.evidence`, `core.feedback.synthesize`, `core.feedback.subscriber`, `core.feedback.events` | `core/feedback/` |
| `core.skill`, `core.skill.crystallize`, `core.skill.verifier`, `core.skill.packager`, `core.skill.subscriber`, `core.skill.events` | `core/skill/`   |
| `core.retrieval`, `core.retrieval.tier1`, `core.retrieval.tier2`, `core.retrieval.tier3`, `core.retrieval.ranker`, `core.retrieval.injector`, `core.retrieval.events` | `core/retrieval/` |
| `core.pipeline.*`   | `core/pipeline/` |
| `core.hub.*`        | `core/hub/`     |
| `core.telemetry`    | `core/telemetry/` |
| `core.update-check` | `core/update-check/` |
| `config`            | `core/config/`  |
| `logger.*`          | `core/logger/`  |
| `storage`, `storage.migration`, `storage.repos`, `storage.vector` | `core/storage/` |
| `embedding`, `embedding.*` | `core/embedding/` |
| `llm`, `llm.*`      | `core/llm/`     |
| `server`, `server.*` (incl. `server.migrate`) | `server/`     |
| `bridge`, `bridge.*` | `bridge/`     |
| `adapter.openclaw`  | `adapters/openclaw/` |
| `adapter.hermes`    | `adapters/hermes/` (Python forwards through bridge) |
| `system.*`          | startup/shutdown/self-check |

When you introduce a new channel, add it to `channels.ts` AND this table in
the same commit.

## Redaction

`core/logger/redact.ts` runs **before** any transport. Defaults catch:

- Object keys: `api_key`, `secret`, `token`, `password`, `authorization`,
  `auth`, `cookie`, `session_token`, `access_token`, `refresh_token`.
- Value patterns: Bearer tokens, `sk-…` keys, JWTs, emails, phone numbers.

Extend in `config.yaml`:

```yaml
logging:
  redact:
    extraKeys: ["my_super_secret"]
    extraPatterns: ["INTERNAL-[A-Z]{8}-[0-9]{4}"]
```

## Performance

`logger.timer("op")` returns a disposable span. Use as:

```ts
{
  using span = log.timer("retrieval.tier1");
  await doTier1();
}
```

Sample rate (`logging.perfLog.sampleRate`, default 1.0) only controls whether
the perf record is emitted; the timer math always runs.

## SSE broadcast

Every record (post-redaction) is also pushed to a `SseBroadcastTransport` that
`server/sse.ts` subscribes to. The viewer's *Logs* tab consumes that stream.
Filtering happens client-side over the firehose.

## Adding a new sink

1. Subclass `Sink` in `core/logger/sinks/`.
2. Wire the sink in `initLogger` (`core/logger/index.ts`).
3. Add a row to the *Files on disk* table above.
4. Add a row to `core/logger/retention.ts`.
5. Update `tests/unit/logger/`.

## Hermes / Python forwarding

`adapters/hermes/memos_provider/log_forwarder.py` serializes each Python
`logging.LogRecord` into our `LogRecord` shape and sends it through the bridge
(`logs.forward` notification — see `agent-contract/jsonrpc.ts`). The bridge
calls `rootLogger.forward(record)` which bypasses the level gate (Python has
already filtered) but still passes through redaction.
