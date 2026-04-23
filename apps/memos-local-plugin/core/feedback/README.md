# `core/feedback` — Decision Repair (V7 §2.4.6, §6.3)

Implements the **closed feedback loop** of Reflect2Evolve V7: the module
that watches the running agent for signs of *getting stuck*, classifies
human corrections, and persists short, context-scoped guidance so the
next turn doesn't repeat the same mistake.

Two input channels converge into one pipeline:

```
recordToolFailure ─┐
recordToolSuccess ─┤    signals     ─burst─▶  runRepair
                   │  (step window)
submitUserFeedback ┤  classifier   ─text──▶  runRepair
                   │  (regex rules)
runOnce ───────────┘    manual     ────────▶  runRepair
```

Each call to `runRepair` gathers recent trace evidence, synthesizes a
preference + anti-pattern pair (LLM when available, deterministic
template otherwise), writes a `decision_repairs` row, and — when
enabled — attaches the pair onto the source L2 policies' guidance
metadata so the skill crystallizer and Tier-1 retrieval pick it up on
the next cycle.

The full algorithm — signals, classifier, evidence filter, synthesizer,
policy attachment — is described in [`ALGORITHMS.md`](./ALGORITHMS.md).

## Pipeline

```
signals.recordFailure(rec)                classifier.classifyFeedback(text)
       │                                          │
       ▼ burst?                                   ▼ negative/preference?
subscriber.triggerFromBurst(burst) ─▶ runRepair ◀──┘
                                     │
                                     ├─ isOnCooldown(contextHash) ? skip
                                     ├─ sessionKnown? ── no ─▶ skip
                                     ├─ gatherRepairEvidence()
                                     │    ├─ filter by keyword (toolId | prefer | avoid)
                                     │    └─ relax if first pass is empty
                                     ├─ computeValueDiff(high, low)
                                     │    └─ < valueDelta && no classified ? skip
                                     ├─ synthesizeDraft()
                                     │    ├─ useLlm && llm: LLM → LlmRepairResponse
                                     │    └─ fallback: templateDraft() (deterministic)
                                     ├─ decisionRepairs.insert(row) ─▶ "repair.persisted"
                                     └─ attachRepairToPolicies(draft)?
                                          └─ policy.boundary gets an @repair block
```

Every stage emits an event on the typed `FeedbackEventBus` (see
[`events.ts`](./events.ts)), so viewers / UI can show live repair
activity and downstream modules (skill, pipeline) can react.

## Key concepts

### Failure signals (`signals.ts`)

A small in-memory rolling window per `(toolId, context)`. We raise a
`FailureBurst` when **both** conditions hold inside the last
`failureWindow` tool calls:

* `occurrences.length >= failureThreshold`
* and no success in the same window (if the tool is intermittently
  succeeding, we don't call it stuck)

The signals store is process-local on purpose: decision repair is
always a "what should the *next* turn do" decision, so we start fresh
on restart. A stable `contextHash = sha1("${toolId}\n${context}").slice(0,16)`
is used everywhere downstream (cooldown lookups, persisted rows).

### User feedback classifier (`classifier.ts`)

A deterministic, rule-based mapper from raw user text to one of five
shapes:

| Shape         | Example utterances                                 | Triggers repair? |
| ------------- | -------------------------------------------------- | ---------------- |
| `positive`    | "great", "that works", "好的"                      | no               |
| `negative`    | "no", "wrong", "don't do that", "不对"             | yes              |
| `preference`  | "use X instead of Y", "下次用 X", "改用 X"         | yes              |
| `instruction` | "then run the tests", "also install pnpm"          | no               |
| `unknown`     | anything that matches no rule                      | no               |

When the shape is `preference`, the classifier also extracts `prefer`
and `avoid` strings via capture groups. These feed the evidence
keyword filter and the template fallback.

The classifier is **LLM-free by design** — keeps the feedback pipeline
runnable in degraded mode and the unit tests stable.

### Evidence gathering (`evidence.ts`)

`gatherRepairEvidence(input, deps)` pulls a window of recent traces
from the session, then splits them into:

* **highValue**: `trace.value > 0` — the behavior we want to amplify.
* **lowValue**: `trace.value < 0` OR explicit failure markers in
  `agentText`/`reflection` OR any `toolCall.errorCode` — the behavior
  we want to avoid.

Filtering by a `keyword` (normally `toolId`, falling back to
`classified.prefer` or `classified.avoid`) narrows the window. If the
first pass yields nothing on **both** sides we **relax** and re-scan
without the keyword — this is the guard-rail for normalized tool IDs
like `pip.install` that never appear verbatim in agent text.

Each surviving trace is truncated to `traceCharCap` characters via
`capTrace`, preserving the tail where error messages live.

### Synthesizer (`synthesize.ts`)

Given `{highValue, lowValue, classifiedFeedback, toolId,
candidatePolicies}`, produces a `DecisionRepairDraft`:

```ts
{
  contextHash, preference, antiPattern,
  severity: "info" | "warn",
  confidence: [0, 1],
  highValueTraceIds, lowValueTraceIds,
  attachToPolicyIds,
}
```

Two code paths:

1. **LLM path** (`useLlm === true` and `deps.llm` provided)
   - Packs evidence + classifier hints into the `decision.repair`
     prompt (see [`core/llm/prompts/decision-repair.ts`](../llm/prompts/)).
   - Validates the JSON reply via `isLlmRepairResponse`.
   - Falls back to the template if the reply is malformed.

2. **Template path** (LLM disabled, missing, or failed)
   - `preference` — best high-value trace's reflection / agentText,
     prefixed with `Prefer: …`.
   - `antiPattern` — worst low-value trace's reflection / agentText,
     prefixed with `Avoid: …`.
   - If the caller supplied `classifiedFeedback.prefer` or `.avoid`,
     those win over the trace excerpts.
   - Confidence is `hint?.confidence ?? (best && worst ? 0.6 : 0.4)`.

`confidence` is always clamped to `[0, 1]`. If **no** preference *and*
anti-pattern line can be produced, we skip with `insufficient-evidence`
instead of fabricating lines.

### Orchestrator (`feedback.ts`)

`runRepair(input, deps)` — the only entry point that writes to the
database. Responsibilities:

* **Cooldown guard** — if `decisionRepairs.recentForContext(contextHash)`
  is younger than `cooldownMs`, emit `repair.skipped { reason: "cooldown" }`
  and return without writing.
* **Session guard** — `runRepair` does nothing without a known session.
* **Value-delta guard** — if we have high-value AND low-value evidence
  but `|mean(high.value) - mean(low.value)| < valueDelta` AND there is
  no explicit user signal, we skip with `value-delta-low`. A user-
  triggered repair (negative / preference) bypasses this guard — the
  human already did the classification for us.
* **Policy attachment** — when `attachToPolicy === true`, call
  `attachRepairToPolicies(draft, deps)` which embeds a compact
  `@repair {json}` block into each candidate policy's `boundary`.
  Duplicate lines are de-duped (set-union on normalized text) and the
  function returns a policy-id list the bus emits as
  `repair.attached`.

Every path emits exactly one terminal event: `repair.persisted` on
success, `repair.skipped` on any skip.

### Subscriber (`subscriber.ts`)

Event-driven facade the adapter calls on every tool step:

```ts
const sub = attachFeedbackSubscriber({ repos, llm, embedder, bus, config });

sub.recordToolFailure({ toolId, context, step, reason, sessionId });
sub.recordToolSuccess({ toolId, context, step, sessionId });

await sub.submitUserFeedback({ text: "use apt-get instead", sessionId });
await sub.runOnce({ trigger: "manual", contextHash, sessionId });

await sub.flush(); // await any queued repair jobs
sub.dispose();
```

A **microtask queue** serialises `runRepair` calls so two rapid bursts
never race on the same `decision_repairs` row. Any error inside a job
is caught and logged as `repair.job.failed`; subsequent queued jobs
still run. `signals.clear(burst.contextHash)` is called after a
successful repair so the burst counter resets and a new window can
fire.

## Events

Emitted via a dedicated `FeedbackEventBus`:

| Kind                   | When                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `repair.triggered`     | After cooldown / session / evidence pre-checks pass.          |
| `repair.persisted`     | A new row was inserted into `decision_repairs`.               |
| `repair.skipped`       | Any short-circuit (cooldown / no-session / insufficient / …). |
| `repair.attached`      | Guidance merged into 1+ policy `boundary` fields.             |
| `feedback.classified`  | For UI: every time the classifier runs on user text.          |

Listener errors are swallowed per-listener so a broken downstream
consumer can't crash the orchestrator.

## Public API

```ts
import {
  attachFeedbackSubscriber,
  runRepair,
  classifyFeedback,
  contextHashOf,
  createFailureSignals,
  gatherRepairEvidence,
  synthesizeDraft,
  attachRepairToPolicies,
  createFeedbackEventBus,
  type FeedbackConfig,
  type FeedbackEvent,
  type DecisionRepairDraft,
  type RepairInput,
  type RepairResult,
} from "@memtensor/memos-local-plugin/core/feedback";
```

* `attachFeedbackSubscriber(deps)` — wire up the four input channels.
* `runRepair(input, deps)` — imperative entry (used by the subscriber
  and the pipeline's periodic sweeps).
* `classifyFeedback(text)` — standalone classifier (UI uses it for
  inline previews).
* `createFailureSignals({ config })` — the rolling-window tracker, also
  reusable from tests.

## Persistence

* `decision_repairs` — the primary table; see
  [`../storage/repos/decision-repairs.ts`](../storage/repos/decision-repairs.ts).
  * `context_hash` — anchor for cooldown lookups and retrieval.
  * `preference`, `anti_pattern` — the guidance the agent will see.
  * `high_value_trace_ids`, `low_value_trace_ids` — evidence JSON
    arrays (keeps the audit trail even after traces age out).
  * `validated` — the UI thumbs-up gate; false by default.

Policies carry the guidance inline via a compact `@repair {json}` tag
inside `policy.boundary`. The skill packager picks this up the next
time the policy is crystallized / rebuilt (see
[`core/skill/packager.ts`](../skill/packager.ts)).

## Configuration

See `algorithm.feedback` in
[`docs/CONFIG-ADVANCED.md`](../../docs/CONFIG-ADVANCED.md#algorithmfeedback).

| Key                | Default     | Purpose                                                      |
| ------------------ | ----------- | ------------------------------------------------------------ |
| `failureThreshold` | `3`         | Failures needed inside `failureWindow` to raise a burst.     |
| `failureWindow`    | `5`         | Rolling step window (tool calls) per `(toolId, context)`.    |
| `valueDelta`       | `0.5`       | Min `|mean(high) - mean(low)|` before repair fires.          |
| `useLlm`           | `true`      | Toggle the LLM path off (tests / degraded mode).             |
| `attachToPolicy`   | `true`      | Merge the draft into `policy.boundary` via `@repair`.        |
| `cooldownMs`       | `60_000`    | Debounce between repeat repairs for the same `contextHash`.  |
| `traceCharCap`     | `500`       | Char cap per evidence trace in the decision-repair prompt.   |
| `evidenceLimit`    | `4`         | Max high-value / low-value traces fed to the synthesizer.    |

## Logging

All feedback work logs on dedicated channels (see
[`../../docs/LOGGING.md`](../../docs/LOGGING.md)):

* `core.feedback.signals` — burst detection + rolling window.
* `core.feedback.evidence` — evidence partitioning (debug only).
* `core.feedback.synthesize` — LLM call outcome + template fallback.
* `core.feedback` — orchestrator (`repair.run.start`, `repair.persisted`,
  `repair.skipped`, `repair.cooldown`).
* `core.feedback.subscriber` — queue + dispatcher; also `repair.job.failed`.
* `core.feedback.events` — listener dispatch errors.

Because a repair directly changes what the agent sees on its next
turn, `repair.persisted` and `repair.attached` are also routed to the
**audit** log (`logs/audit.jsonl`, never deleted) via the `feedback`
channel.

## Tests

* `tests/unit/feedback/signals.test.ts` — threshold / window / reset.
* `tests/unit/feedback/classifier.test.ts` — shapes + preference extraction.
* `tests/unit/feedback/evidence.test.ts` — high/low split, keyword
  relax, `capTrace` tail preservation.
* `tests/unit/feedback/synthesize.test.ts` — LLM path, invalid JSON,
  transport failure, template fallback, confidence clamping.
* `tests/unit/feedback/events.test.ts` — bus contract + listener
  isolation.
* `tests/unit/feedback/feedback.integration.test.ts` — end-to-end
  `runRepair` against real SQLite; cooldown / skip / attach paths.
* `tests/unit/feedback/subscriber.test.ts` — burst → queued run,
  user feedback, concurrent-burst serialisation, job-throws resilience.

Run the whole feedback suite with
`npm test -- tests/unit/feedback`.
