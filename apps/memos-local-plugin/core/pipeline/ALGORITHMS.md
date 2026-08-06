# `core/pipeline` — Orchestration algorithms

This document complements [`README.md`](./README.md). Where the README
covers the public shape, here we write down the **invariants**,
**timing guarantees**, and **failure-mode decisions** the orchestrator
enforces. These are the rules tests rely on and the rules every
downstream module can assume.

## Invariants enforced by the orchestrator

### I1 — "One open episode per session"

After `onTurnStart` returns, the session has exactly one open episode.
After `onTurnEnd`, that episode is **closed** and the in-memory
`openEpisodeBySession` map is cleared.

* If the session had no open episode, we open one via
  `sessionManager.startEpisode`.
* If a *different* episode is already open (drift) we reuse it when
  `status === "open"`, otherwise we drop the stale entry from the index
  and open a new one.
* `onTurnEnd` always reads a fresh `EpisodeSnapshot` from the session
  manager *after* `finalizeEpisode` so `episode.status` is `"closed"`
  in the response shape (tests depend on this).

This is a deliberate simplification of V7 §0.2.2 (revision vs. new
task). The full classifier-driven decision will land in a later patch
and only changes the open/close logic — the rest of the contract stays
stable.

### I2 — "Capture/reward never blocks the turn"

The capture → reward → L2 → L3 → skill chain is entirely event-driven.
`onTurnEnd` *returns* the moment `sessionManager.finalizeEpisode`
completes; every subscriber down-stream runs on its own microtask
queue.

The orchestrator exposes `flush()` for callers that need a synchronous
barrier (tests, viewer snapshots). `flush()`:

1. Awaits `captureSubscription.drain()`.
2. Yields via `setImmediate` to let reward's `schedule`-based runner
   pick up the just-emitted `capture.done` event.
3. Awaits `rewardSubscription.drain()`.
4. Runs four more `setImmediate` ticks to let L2/L3/skill subscribers
   process their cascaded events.
5. Awaits `skills.flush()` and `feedback.flush()`.

Tick counting here is intentionally cheap and deterministic. Were we
to introduce cross-module backpressure later, each subscriber would
grow its own `drain()` and this function would compose them instead of
counting ticks.

### I3 — "Every event reaches the unified CoreEvent stream"

The `event-bridge.ts` module subscribes to every internal bus and
re-emits on a single listener list. Guarantees:

* Mapping is **purely additive** — we never drop or mutate payload
  fields other than to wrap them in a `CoreEvent { type, ts, seq,
  correlationId, payload }` envelope.
* Unknown internal event kinds are skipped instead of thrown.
* Listener errors are caught per-listener so one broken subscriber
  can't crash the orchestrator (surfaced via `event.listener_threw`
  warnings on `core.pipeline`).

### I4 — "Retrieval is idempotent with respect to bus events"

Each retrieval entry point (`turnStartRetrieve`, `toolDrivenRetrieve`,
`skillInvokeRetrieve`, `subAgentRetrieve`, `repairRetrieve`) emits its
own `retrieval.started` / `retrieval.done` pair. The pipeline-level
entry points are thin wrappers that:

1. Build the correct `RetrievalCtx` from the DTO.
2. Call the retrieval function with shared `retrievalDeps` (built once
   via `buildRetrievalDeps` and cached on the handle).
3. Return the resulting `InjectionPacket` (never the stats object;
   callers that need stats use `handle.retrievalDeps()` directly).

The pipeline never caches retrieval results itself — each V7 trigger
runs its own scan. The LLM cache and embedder cache already handle
cost.

### I5 — "Tool outcomes are synchronous"

`recordToolOutcome` is a *non-awaitable* push. It writes the record
into the feedback subscriber's `failureSignals` tracker and returns.
If a burst is detected the subscriber enqueues a `runRepair` job on a
microtask queue; the pipeline never blocks.

The contract hash that anchors cooldown lookups is derived from
`outcome.context ?? lastUserTextBySession.get(sessionId) ?? sessionId`.
We record the last user text per session on every `onTurnStart` so
failures attributed to a tool still land in the right bucket even when
the adapter doesn't pass `context` explicitly.

### I6 — "Shutdown is idempotent"

Calling `shutdown()` twice is safe:

* First call: `flush()` → `stop()`/`detach()` every subscription →
  dispose bridge + log subscriber → `sessionManager.shutdown()` →
  `onShutdown()` callback.
* Second call: `if (shutDown) return;` at the façade level. The
  orchestrator doesn't expose a "re-open" API — a new pipeline must be
  built for a new lifecycle.

`MemoryCore.openSession` after shutdown throws
`MemosError("already_shut_down")` (tested).

## Session → episode flow

```
onTurnStart(input)
  │
  ▼
ensureSession(agent, sessionId)
  │ missing?          ─yes─▶ sessionManager.openSession(input)
  │                           emits "session.started" → bridge → session.opened
  ▼
openEpisodeIfNeeded(sessionId, userText, meta)
  │ open episode already? ─yes─▶ return snapshot
  │                        ─no──▶ sessionManager.startEpisode({ userMessage })
  │                                emits "episode.begun" → bridge → episode.opened
  ▼
retrieveTurnStart(normalizedInput)
  │ buildQuery + buildRetrievalDeps-scoped call
  │ fires "retrieval.started" → bridge → retrieval.triggered
  │ fires per-tier events (optional) → bridge → retrieval.tier{1,2,3}.hit
  │ emits "retrieval.done" → bridge → retrieval.triggered/empty
  ▼
log("turn.started", { agent, sessionId, episodeId, retrievalTotalMs })
return packet
```

`onTurnEnd` is symmetric:

```
onTurnEnd(result)
  │
  ▼
sessionManager.addTurn(episodeId, { role: "assistant", ... })
  emits "turn.added"
  │
  ▼
sessionManager.finalizeEpisode(episodeId)
  emits "episode.finalized" → capture subscription
                            → bridge → episode.closed
  │ (fire-and-forget capture → reward → L2 → L3 → skill chain)
  ▼
openEpisodeBySession.delete(sessionId)
  │
  ▼
log("turn.ended", { toolCalls, agentChars })
return { traceCount, episodeId, episode, episodeFinalized: true,
         asyncWorkScheduled: true }
```

## Config slice construction (`extractAlgorithmConfig`)

`deps.config.algorithm` contains modules *as authored by config.yaml*;
each subscriber's own config type borrows a subset. The orchestrator
therefore stitches together hybrid shapes:

```
L2Config  = {
  ...deps.config.algorithm.l2Induction,
  gamma:                  deps.config.algorithm.reward.gamma,
  tauSoftmax:             deps.config.algorithm.reward.tauSoftmax,
  inductionTraceCharCap:  deps.config.algorithm.l2Induction.traceCharCap,
}

RetrievalConfig = {
  ...deps.config.algorithm.retrieval,
  decayHalfLifeDays:      deps.config.algorithm.reward.decayHalfLifeDays,
}
```

All other modules (`capture`, `reward`, `l3Abstraction`, `skill`,
`feedback`) pass through 1:1.

## DTO ↔ row mapping (façade)

The façade converts between the JSON-safe adapter DTOs
(`agent-contract/dto.ts`) and the internal rows (`core/types.ts`).
Mapping conventions:

* `null` in rows → `undefined` in DTOs (JSON serialisation drops
  `undefined` keys, which adapters prefer).
* `Date` / `EpochMs` / `Float32Array` never cross the boundary — we
  decode to `number[]` or primitives.
* `reflection: null` in traces is omitted from the DTO.
* `SkillRow.procedureJson` is intentionally *not* forwarded via the
  DTO; it's consumed by the skill subscriber directly. Adapters that
  want raw procedures should fetch the row by id via a future
  `core/skill/packager` public call.

## Error handling

| Surface                   | Failure mode                      | Response                                             |
|---------------------------|-----------------------------------|------------------------------------------------------|
| `bootstrapMemoryCore`     | Migrations fail                   | Throw `MemosError("config_invalid")`; DB closed.     |
| `bootstrapMemoryCore`     | Embedder/LLM throws on init       | Log warn, swap for `null`; pipeline still boots.     |
| `onTurnStart`             | Retrieval throws                  | Log error, return empty `InjectionPacket`.           |
| `onTurnEnd`               | No open episode for session       | Throw `Error("no open episode for session ...")`.    |
| `onTurnEnd`               | Current open episode is closed    | Throw `Error("episode ... is not open")`.            |
| `closeSession`            | Session unknown                   | `MemosError("session_not_found")`.                   |
| `closeEpisode`            | Episode unknown                   | `MemosError("episode_not_found")`.                   |
| `retireSkill`             | Skill unknown                     | `MemosError("skill_not_found")`.                     |
| Post-shutdown calls       | Any method                        | `MemosError("already_shut_down")`.                   |

Retrieval errors never propagate past `onTurnStart` because we'd
rather return zero context than crash the agent's turn. Subscriber
errors are logged on their own channels (`core.capture`,
`core.reward`, …) and never surface through the façade unless the
adapter asks for them via `subscribeEvents`.

## References

* V7 §0.2 — Session/episode boundaries and turn lifecycle
* V7 §0.3 — Event model
* V7 §0.5 — Update rule `(M1, M2, M3, S)_k → (M1, M2, M3, S)_{k+1}`
* V7 §2.6 — Injection triggers: turn start, tool driven, skill
  invoke, sub-agent, decision repair
* V7 §4 — Retrieval tiers and fusion
* [`core/feedback/README.md`](../feedback/README.md) — tool failure
  classification driven by `recordToolOutcome`
* [`agent-contract/memory-core.ts`](../../agent-contract/memory-core.ts) —
  stable interface this module implements
