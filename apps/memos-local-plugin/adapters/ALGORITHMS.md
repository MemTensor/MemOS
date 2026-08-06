# `adapters/` — Adapter invariants

Where [`README.md`](./README.md) covers layout and transport, this
document pins down the **invariants** adapters must preserve. A failure
to uphold any of these lets the algorithm core return inconsistent
state, so they are non-negotiable.

The core is written against a contract (`agent-contract/memory-core.ts`);
adapters exist to preserve that contract despite host quirks.

## A1 — Exactly-once turn lifecycle

Each user-agent turn **must** produce exactly one pair of calls:

```
onTurnStart({agent, sessionId, userText, ts})
    → (assistant generation) →
onTurnEnd({agent, sessionId, episodeId, agentText, toolCalls, ts})
```

Hosts can fire `before_prompt_build` multiple times per turn (when
tool-use re-plans the prompt). The adapter is responsible for coalescing
those into a *single* `onTurnStart` call — typically by tracking a
per-session "turn is live" flag in the bridge layer.

Why: the orchestrator uses turn lifecycle boundaries to allocate episode
steps and attach retrieval results. Double-firing pollutes the trace.

## A2 — userText and agentText are verbatim

Adapters must pass the user's and agent's exact utterances. Do **not**:

- strip trailing whitespace,
- lowercase,
- truncate to a host-specific prompt limit,
- interpolate tool-call summaries.

Why: the capture layer chunks and embeds `userText`/`agentText` directly;
any mutation breaks reproducibility and invalidates future retrieval.
If the host truncates, either send the untruncated original when
available or annotate with `meta.truncated = true` so the orchestrator
can skip capture for that turn.

## A3 — toolCalls preserve temporal order

The `toolCalls` array in `TurnResultDTO` must be ordered in the sequence
the agent actually invoked the tools. The orchestrator uses this order
to allocate `step` numbers monotonically within the episode.

Reordering (e.g. deduping by tool name) is forbidden. Duplicate
invocations are meaningful signal for decision-repair.

## A4 — recordToolOutcome is non-blocking

`recordToolOutcome` must return immediately. Implementations must never
await I/O or hold a lock. The orchestrator hands the outcome to a queue
and processes it asynchronously.

Adapters are allowed (and encouraged) to fire-and-forget the RPC when
out-of-process.

## A5 — Session scoping is stable

A given `(agent, sessionKey)` tuple must map to the *same* `SessionId`
for the lifetime of the host session. Adapters must not re-open a
session on every turn, nor reset the session on transient errors.

The sessionId is a bridge-managed opaque string; adapters should treat
it as a blob and round-trip it without mutation.

## A6 — Episodes mirror agent scopes

When the host treats a sequence of turns as one task (a browser
automation run, an IDE edit session, a single conversation), a single
episode must span it. New episodes must be opened only when:

- the user starts a distinctly different task (adapters detect via host
  signals — new top-level goal, explicit "new task" action),
- the host explicitly closes the previous episode, or
- the core's intent classifier in `core/session/intent.ts` signals a
  break.

Short-lived side tasks (sub-agents, tool invocations) must **not** open
new episodes.

## A7 — Injected context is advisory

`onTurnStart` returns a `RetrievalResultDTO` whose `injectedContext` is
a pre-rendered context block. Adapters inject it into the host prompt,
but treat it as advisory: the host is free to drop or truncate it if
prompt-size constraints require. The orchestrator records the *intent*
to inject; it does not assume the prompt received it.

## A8 — Shutdown is idempotent

`shutdown()` must be safe to call multiple times. It must:

- flush pending `sync_turn`-style deferred ingests,
- close any open episodes,
- close any open sessions,
- close the transport (kill subprocess for Python, drop listeners for
  TS).

Re-entering `shutdown` after a prior successful call must be a no-op,
and must not throw.

## A9 — Error codes are preserved across the bridge

When an out-of-process adapter (Python/Hermes) relays an error back to
the host, it must preserve the `ErrorCode` (`agent-contract/errors.ts`)
from the JSON-RPC `data.code` field. Hosts rely on these stable codes
to classify errors (retryable / client / server). Stripping or
renaming the code erases that affordance.

## A10 — Log + event forwarding is opt-in

The bridge forwards core logs and events via `logs.forward` and
`events.notify` JSON-RPC notifications. Adapters subscribe explicitly
(via `MemosBridgeClient.on_log` / `on_event`); they must not rely on
this stream being delivered at all.

Why: hosts with their own logging stacks would otherwise get duplicate
entries. Subscription is opt-in per host.

## Summary checklist

Before landing a new adapter, verify by inspection or test that:

- [ ] Exactly one `onTurnStart` + `onTurnEnd` per turn (A1).
- [ ] `userText` and `agentText` are byte-identical to the host
      utterance (A2).
- [ ] `toolCalls` ordering is preserved (A3).
- [ ] `recordToolOutcome` is non-blocking (A4).
- [ ] `(agent, sessionKey)` → `SessionId` is stable for the lifetime of
      the host session (A5).
- [ ] Episode open/close reflects task boundaries, not turn boundaries
      (A6).
- [ ] Injected context is applied to the next prompt but not re-fed to
      the core (A7).
- [ ] `shutdown` is safe to call repeatedly (A8).
- [ ] RPC error codes round-trip to the host (A9).
- [ ] Log + event forwarding is only enabled when the host opts in (A10).
