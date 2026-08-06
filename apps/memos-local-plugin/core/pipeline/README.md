# `core/pipeline` — Orchestrator + MemoryCore façade (V7 §0.2, §0.3, §0.5)

This is the *only* module that adapters ever import. It ties together
every algorithm subscriber (capture → reward → L2 → L3 → skill →
feedback) and every event bus into a single long-lived object with a
stable, JSON-friendly public contract.

Two layers live here:

1. **`createPipeline(deps)`** — builds the dependency graph, wires the
   buses, and exposes the *rich* orchestrator interface
   (`PipelineHandle`). Server, tests, and anyone who needs direct
   access to subscribers or runners talks to this.

2. **`createMemoryCore(handle, home, version)`** — implements the
   adapter-facing façade defined in
   [`agent-contract/memory-core.ts`](../../agent-contract/memory-core.ts).
   It translates DTOs ↔ core rows, enforces the `init → shutdown`
   lifecycle, and maps every error to a stable `MemosError` code.
   This is what every adapter (TypeScript, JSON-RPC, TCP) depends on.

A third helper, **`bootstrapMemoryCore({agent, home?, config?})`**,
opens storage, runs migrations, spins up the embedder + LLM, calls
`createPipeline`, and returns an already-wired `MemoryCore`. Most
adapter entry points can call this one function and be done.

## Module layout

```
pipeline/
  ├── types.ts             — PipelineDeps, PipelineHandle, config slices
  ├── deps.ts              — graph builder (buses + sessions + subscribers)
  ├── event-bridge.ts      — aggregate all internal buses → CoreEvent
  ├── retrieval-repos.ts   — Repos → RetrievalRepos adapter
  ├── orchestrator.ts      — createPipeline(): PipelineHandle
  ├── memory-core.ts       — createMemoryCore + bootstrapMemoryCore
  └── index.ts             — public re-exports
```

## Pipeline dataflow

```
                   ┌──────────────────────────────┐
        adapter ──▶│ MemoryCore façade            │──▶ DTO response
                   │ (memory-core.ts)             │
                   └──────────┬───────────────────┘
                              │
                              ▼
                   ┌──────────────────────────────┐
                   │ PipelineHandle               │
                   │ (orchestrator.ts)            │
                   └───┬─────────┬────────────┬───┘
                       │         │            │
                       ▼         ▼            ▼
                 sessionBus   retrieval   feedback.signals
                       │         │            │
                       ▼         ▼            ▼
   captureSub → captureBus → rewardSub → rewardBus
                                            │
                                            ▼
                                     ┌──────┴──────┐
                                     ▼             ▼
                                  l2Sub         l3Sub
                                     │             │
                                     ▼             ▼
                                 l2Bus ─────▶ skillSub
                                                   │
                                                   ▼
                                                skillBus
                                                   │
                                                   ▼
                                             EventBridge
                                                   │
                                                   ▼
                                             CoreEvent
                                                 stream
```

Every arrow is a `void` fire-and-forget so adapters never block on the
learning path. `pipeline.flush()` drains the full chain (used by tests
and viewer snapshots).

## The orchestrator (`createPipeline`)

### Inputs (`PipelineDeps`)

```ts
{
  agent:      "openclaw" | "hermes",
  home:       ResolvedHome,
  config:     ResolvedConfig,
  db:         StorageDb,
  repos:      Repos,
  llm:        LlmClient | null,
  embedder:   Embedder   | null,
  log:        Logger,
  now?:       () => number,
}
```

`llm` / `embedder` are `null`-able so the core runs in degraded mode
without a network. `now` is a clock injection for deterministic tests.

### Outputs (`PipelineHandle`)

* `sessionManager`, `episodeManager`, `intent` — session lifecycle.
* `captureRunner`, `rewardRunner` — imperative algorithm runners for
  direct calls (useful in tests & manual re-runs).
* `l2`, `l3`, `skills`, `feedback` — subscriber handles.
* `buses` — every internal `EventBus` (session, capture, reward, L2,
  L3, skill, feedback, retrieval).
* `subscribeEvents(h)` — bridged `CoreEvent` stream.
* `subscribeLogs(h)` — live `LogRecord` stream (replays last 64 from
  the memory ring buffer for late subscribers).
* `onTurnStart(input)` / `onTurnEnd(result)` — turn lifecycle.
* `recordToolOutcome(input)` — forward tool signals to feedback.
* `retrieveTurnStart` / `retrieveToolDriven` / `retrieveSkillInvoke` /
  `retrieveSubAgent` / `retrieveRepair` — V7 injection triggers.
* `flush()` — wait for capture → reward → L2/L3/skill to drain.
* `shutdown(reason?)` — finalize the pipeline, detach subscribers,
  stop the session manager, and emit `pipeline.shutdown.done`.

### Turn lifecycle (V7 §0.2)

```
onTurnStart(TurnInputDTO)
  ├─ ensureSession(agent, sessionId)              (auto-opens if missing)
  ├─ openEpisodeIfNeeded(sessionId, userText)     (one episode per user query, V1)
  ├─ retrieveTurnStart(input)                      → InjectionPacket
  └─ log turn.started { latency, tiers }

onTurnEnd(TurnResultDTO)
  ├─ sessionManager.addTurn(episodeId, assistantTurn)
  ├─ sessionManager.finalizeEpisode(episodeId)    — triggers capture chain
  ├─ log turn.ended
  └─ return { traceCount, episodeId, episode, episodeFinalized, asyncWorkScheduled }
```

The episode boundary policy today is simple: **one episode per user
query**. A future iteration may call the intent classifier to decide
between "continue" / "revise" / "new task" (V7 §0.2.2) — the
`IntentClassifier` is already wired, we just don't branch on its output
yet.

### Tool outcomes → decision repair

```ts
pipeline.recordToolOutcome({
  sessionId, episodeId, tool: "pip.install",
  step: 5, success: false, errorCode: "MISSING_LIB",
});
```

Failures feed the `failureSignals` tracker inside the feedback
subscriber; bursts enqueue a `runRepair` on a microtask (see
[`core/feedback/README.md`](../feedback/README.md)). Successes also
flow through so bursts self-heal when the tool starts working again.

## The façade (`createMemoryCore`)

Implements the adapter contract 1:1. A few translation details:

| Contract call          | Facade behaviour                                                       |
|------------------------|------------------------------------------------------------------------|
| `init()`               | No-op flag flip. Stays idempotent for adapters that re-arm the core.   |
| `shutdown()`           | Drains the pipeline, closes the DB (if `onShutdown` provided).         |
| `openSession`          | Delegates to `sessionManager.openSession`.                             |
| `closeSession`         | Throws `session_not_found` when missing.                               |
| `openEpisode`          | Calls `startEpisode(sessionId, userMessage="")`.                       |
| `closeEpisode`         | Idempotent; returns silently if already closed.                        |
| `onTurnStart`          | Wraps the orchestrator's `InjectionPacket` into a `RetrievalResultDTO`.|
| `onTurnEnd`            | Returns the last trace id the episode snapshot reports.                |
| `submitFeedback`       | Writes to `feedback` repo, returns the DTO with a fresh UUID + `ts`.   |
| `searchMemory`         | Synthetic `turn_start`-style retrieval.                                |
| `getTrace` / `getSkill`| Repo read + DTO mapping. Nulls pass through.                           |
| `retireSkill`          | Sets `status="retired"`, emits `skill.status.changed` + `skill.retired`.|
| `subscribeEvents`      | Forwards the pipeline's bridged `CoreEvent` stream unchanged.          |
| `subscribeLogs`        | Bundle of memory-buffer replay + live `onBroadcastLog` subscription.   |
| `forwardLog`           | Sends external `LogRecord`s into our sinks via `rootLogger.forward`.   |

Every public call guards on `ensureLive()` and throws
`MemosError("already_shut_down")` after `shutdown()`.

### Bootstrap

```ts
const core = await bootstrapMemoryCore({
  agent: "openclaw",
  pkgVersion: pkg.version,
});
await core.init();
```

Optional overrides:

* `home`    — pre-resolved `ResolvedHome` (useful for tmp dirs in tests).
* `config`  — pre-resolved `ResolvedConfig` (skip the YAML read).
* `now`     — clock injection forwarded to the pipeline.

Bootstrap *closes the DB* on shutdown. Direct `createMemoryCore` users
manage storage themselves.

## Event aggregation (`event-bridge.ts`)

Every internal bus emits its own event type. The bridge maps them to
the stable set in
[`agent-contract/events.ts`](../../agent-contract/events.ts) (`CORE_EVENTS`).
Highlights:

| Internal                        | External (`CoreEventType`)     |
|---------------------------------|--------------------------------|
| `session.started`               | `session.opened`               |
| `session.closed`                | `session.closed`               |
| `episode.begun`                 | `episode.opened`               |
| `episode.finalized`             | `episode.closed`               |
| `capture.done` (per trace)      | `trace.created`                |
| `reward.updated.backprop.updates`| `trace.value_updated` (each)  |
| `reward.scored`                 | `reward.computed`              |
| `l2.policy.associated`          | `l2.associated`                |
| `l2.policy.induced`             | `l2.induced`                   |
| `l2.policy.updated`             | `l2.revised`                   |
| `l3.world_model.abstracted`    | `l3.abstracted`                |
| `l3.world_model.revised`       | `l3.revised`                   |
| `feedback.classified`           | `feedback.classified`          |
| `repair.persisted`              | `decision_repair.generated`    |
| `repair.attached`               | `decision_repair.validated`    |
| `skill.crystallized`            | `skill.crystallized`           |
| `skill.eta.updated`             | `skill.eta_updated`            |
| `skill.status.changed`          | `skill.boundary_updated`       |
| `skill.retired`                 | `skill.retired`                |
| `retrieval.started`             | `retrieval.triggered`          |

Unknown / future internal events are ignored (the bridge is
forward-compatible). The bridge is additive only — it never drops or
mutates payloads beyond wrapping.

## Configuration slice

`extractAlgorithmConfig(deps)` builds a minimal subset from the full
`ResolvedConfig.algorithm`. Notable merges:

* `l2Induction` reuses `reward.gamma`, `reward.tauSoftmax`, and
  `l2Induction.traceCharCap` → `inductionTraceCharCap`.
* `retrieval` reuses `reward.decayHalfLifeDays` (the half-life we
  apply when ranking traces by recency).
* Every subscriber receives only the config it needs; the pipeline
  never leaks embedding keys or sensitive fields into subscriber
  signatures.

## Public API

```ts
import {
  createPipeline,
  createMemoryCore,
  bootstrapMemoryCore,
  bridgeToCoreEvents,
  wrapRetrievalRepos,
  extractAlgorithmConfig,
  buildPipelineBuses,
  buildPipelineSession,
  buildPipelineSubscribers,
  buildRetrievalDeps,
  pipelineLogger,
  type PipelineDeps,
  type PipelineHandle,
  type PipelineBuses,
  type PipelineAlgorithmConfig,
  type RecordToolOutcomeInput,
  type TurnEndResult,
  type BootstrapOptions,
  type CreateMemoryCoreOptions,
} from "@memtensor/memos-local-plugin/core/pipeline";
```

## Logging

Pipeline work logs on:

* `core.pipeline` — orchestrator (`pipeline.ready`, `turn.started`,
  `turn.ended`, `pipeline.shutdown.*`).
* `core.pipeline.bootstrap` — bootstrap phase (storage open, provider
  wiring, first event).
* `core.pipeline.bridge` — event-bridge listener errors.

Because it spans every module, the pipeline channel is deliberately
*noisy*: every turn writes at least `turn.started` + `turn.ended`. We
rely on `core.capture` / `core.reward` / etc. to carry the *per-module*
detail.

## Tests

* `tests/unit/pipeline/orchestrator.test.ts` — session → turn lifecycle,
  unified `CoreEvent` stream, tool outcome routing, empty-injection
  case, graceful shutdown.
* `tests/unit/pipeline/memory-core.test.ts` — `MemoryCore` facade
  contract, `submitFeedback` persistence, `listEpisodes` + `timeline`,
  `subscribeEvents`, `shutdown` idempotency, `bootstrapMemoryCore` on a
  real tmp home + default config.

Run the pipeline suite:

```bash
npm test -- tests/unit/pipeline
```

The end-to-end test matrix in `tests/e2e/` exercises the same entry
points through the bridge + HTTP server; this module is the foundation
both layers share.
