# `core/feedback` — Algorithms

This note anchors the decision-repair implementation to the
Reflect2Evolve V7 spec (§2.4.6 **Decision Repair** and §6.3
**Dual-layer feedback**) and calls out the deviations we took for the
local-plugin runtime. Read alongside `README.md` for the high-level
contract.

---

## 1. Dual-layer feedback triggers

V7 §6.3 specifies two orthogonal feedback surfaces:

* **Tool feedback** — every tool call succeeds or fails, producing a
  step-level signal. Deterministic, no LLM required.
* **User feedback** — free-text messages the user sends, which we need
  to classify before they can act as guidance.

`attachFeedbackSubscriber` wires both to `runRepair`:

```
Tool layer:
  adapter.toolCall(ok)      ─▶ signals.recordSuccess(toolId, ctx, step)
  adapter.toolCall(err)     ─▶ signals.recordFailure(rec)
                                   │
                                   ▼ burst?                (§6.3 eq. 3)
                                subscriber.triggerFromBurst(burst)
                                   │
                                   ▼
                                runRepair({ trigger: "failure-burst", … })

User layer:
  adapter.userMessage("no, use apt-get")
      ─▶ subscriber.submitUserFeedback({ text, sessionId })
          ├─ classifyFeedback(text) ─▶ { shape, prefer, avoid }
          └─ runRepair({ trigger: "user.negative" | "user.preference", … })
```

A third entry `runOnce` exists for the viewer's **"Trigger repair"**
button and for periodic sweeps from the pipeline orchestrator. Triggers
are tagged on every event so downstream consumers can tell a human-
driven repair from an automated one.

---

## 2. Failure signalling

### 2.1 Rolling window

`createFailureSignals({ config })` keeps, for every
`(toolId, context)` pair, a tiny state:

```ts
{
  firstSeen, lastSeen,            // EpochMs
  windowStart,                    // most recent minStep
  occurrences: FailureRecord[],   // trimmed every call
}
```

On `recordFailure(rec)`:

```
minStep = rec.step - config.failureWindow + 1
pruned  = state.occurrences.filter(o => o.step >= minStep)
pruned.push(rec)
```

This is the "failure within the last N tool calls" metric from §6.3,
implemented as a step-window rather than a wall-clock one because the
agent's clock is deterministic but time-between-calls is not.

### 2.2 Burst condition

A `FailureBurst` fires **iff**:

```
  pruned.length              >=  config.failureThreshold   (default 3)
  AND  successes.get(key)    <   state.windowStart          (no success in window)
```

The "no success in window" clause is the anti-flapping guard from the
spec: an intermittent tool (works 4 times, fails 1) must not trigger a
repair.

### 2.3 Context hashing

```
contextHashOf(toolId, context) =
    sha1(`${toolId}\n${context}`).slice(0, 16)
```

A short SHA-1 is enough for the dedup/cooldown lookup (we have at most
a few thousand contexts in-memory) and is stable across restarts, so
the `cooldownMs` guard survives a reboot via `decision_repairs.ts`
queries.

### 2.4 Lifecycle

On a successful repair the subscriber calls `signals.clear(contextHash)`,
which removes the `FailureState` and the associated success marker.
A failed repair (thrown during DB write, etc.) does **not** clear —
the next failure naturally re-arms the counter.

On `dispose()` all state is cleared.

---

## 3. Feedback classification

### 3.1 Shapes

```
shape ∈ { positive, negative, preference, instruction, unknown }
```

Only `negative` and `preference` trigger repair. The others are
reported to the caller (for UI rendering + event emission) but do not
touch the database.

### 3.2 Rule order

The classifier tries, in order:

1. **Preference extraction** (`PREFERENCE_PATTERNS` in `classifier.ts`).
   English:
   - `use X instead of Y`
   - `prefer X over Y`
   - `X instead of Y`
   - `next time: X`

   Chinese:
   - `用 X 代替 Y`
   - `用 X 而不是 Y`
   - `别/不要 Y，(要)用 X`

   The first match wins. Capture groups yield `prefer` / `avoid` with
   punctuation stripped. Soft signals ("prefer …", "改用 …") without
   `avoid` still return `{ shape: "preference", confidence: 0.55 }`.

2. **Negative patterns** — `wrong`, `not right/correct/what/that`,
   `don't do`, `no(,.!?space)`, `不对`, `错了`, `不要这样`, `别这样`.

3. **Positive patterns** — `great`, `thanks`, `yes/ok/okay/sure`,
   `好的`, `完美`, `搞定`.

4. **Instruction heuristic** — starts with an imperative verb (`run`,
   `delete`, `install`, `创建`, `安装`, …) or contains a
   `then|also|next (run|delete|create|install|try|use|call)` bigram.

5. **Fallback** — `{ shape: "unknown", confidence: 0.3 }`.

### 3.3 Why no LLM

The classifier runs **inside the synchronous part of
`submitUserFeedback`** — we want a shape + confidence before we decide
to enqueue `runRepair`. Keeping it deterministic also means:

* Unit tests are stable on strings.
* Degraded-mode (no network / no API key) still delivers the full
  user-feedback loop.
* We avoid the "the LLM hallucinated `shape: preference` for a
  positive message" failure mode.

V7 §6.3 allows LLM-assisted classification; we leave that as a future
enhancement on top of the deterministic pass (reorder: rule first,
LLM only if `shape === "unknown"`).

---

## 4. Evidence gathering

### 4.1 Two-pass filter

`gatherRepairEvidence({ sessionId, keyword, limit }, deps)` selects
candidate traces and splits them into `highValue` / `lowValue`:

```
recent = repos.traces.list({ sessionId, limit: max(cap*6, 24) })

first  = partition(recent, cap, keyword)
if first.both_empty:
    second = partition(recent, cap, "")   // relaxed
    return second
else:
    return first
```

`partition(traces, cap, needle)`:

```
for trace in traces:
    if needle and not traceContains(trace, needle): continue
    if trace.value > 0:      push → highValue (up to cap)
    elif trace.value < 0 or isFailureLike(trace): push → lowValue (up to cap)
    if both lists are full: break
```

* `traceContains(t, needle)` — substring match on
  `userText + "\n" + agentText + "\n" + reflection` lowercased.
* `isFailureLike(t)` — regex on the agent-side text
  (`error|failed|failure|exception|traceback|timeout|retry`) OR any
  `toolCall.errorCode` set.

The **two-pass** design is subtle:

* In the **user-feedback path** the keyword is usually the classifier-
  extracted `prefer` / `avoid` — natural language, so the first pass
  is informative.
* In the **failure-burst path** the keyword is the normalized
  `toolId` ("pip.install"). This rarely appears verbatim in the
  natural-language trace text ("pip install cryptography"), so the
  first pass commonly yields nothing on both sides → relax → scan all
  recent traces.

We only relax when **both** lists are empty. If at least one side
matches the keyword we keep that — the synthesizer can template a
one-sided draft from a single `highValue` (pure preference) or single
`lowValue` (pure anti-pattern).

### 4.2 Trace capping

`capTrace(trace, maxChars)` truncates `userText`, `agentText`, and
`reflection` each to `maxChars` characters, **preserving the tail**:

```
if s.length <= n: return s
return "..." + s.slice(s.length - n)
```

The tail is where error messages, stack traces, and
`MODULE_NOT_FOUND`-style markers live — they are what the decision-
repair prompt actually needs.

---

## 5. Synthesis

### 5.1 Inputs

```ts
{
  trigger, contextHash,
  highValue: TraceRow[],  // up to evidenceLimit
  lowValue:  TraceRow[],
  classifiedFeedback?,    // present when trigger is user-driven
  toolId?,
  candidatePolicies?,     // sourceEpisodeId ∩ evidence.episodeId
}
```

### 5.2 Decision tree

```
if both lists empty:
    return { ok: false, reason: "insufficient-evidence" }

if !config.useLlm or !llm:
    draft = templateDraft(input, policyIds)
    return draft ? { ok: true, draft } : { insufficient-evidence }

try:
    res = await llm.completeJson(packPrompt(...))
    if !isLlmRepairResponse(res.value):
        fallback = templateDraft(...)
        return fallback ? { ok: true, draft: fallback } : { llm-failed "invalid_response" }
    return { ok: true, draft: normalizeDraft(input, res.value, policyIds) }

catch err:
    fallback = templateDraft(...)
    return fallback ? { ok: true, draft: fallback } : { llm-failed }
```

The LLM path is **never trusted blindly**: a malformed JSON reply or
an exception both fall back to the template. We only surface
`ok: false, reason: "llm-failed"` when even the template can't find a
non-empty preference / anti-pattern.

### 5.3 LLM prompt

`packPrompt(input, prefer, avoid, traceCharCap)` produces a two-
message chat:

* **system** — [`DECISION_REPAIR_PROMPT.system`](../llm/prompts/decision-repair.ts).
  Instructs the model to return the exact JSON shape below and to
  ground every sentence in the evidence:

  ```json
  {
    "preference":  "...",
    "anti_pattern": "...",
    "severity":    "info" | "warn",
    "confidence":  number  // 0..1
  }
  ```

* **user** — contains `CURRENT_CONTEXT`, `FAILURE_HISTORY`, and
  `SIMILAR_SUCCESS` sections. Each trace is serialised as:

  ```
  trace <id>
  value: <signed float>
  user:  <capped userText>
  agent: <capped agentText>
  reflection: <capped reflection>
  ```

  All separated by `---`.

The schema hint (`decision-repair.v1`) is passed to
`completeJson` so the host bridge / provider can choose structured
output mode when available.

### 5.4 Template fallback

```
best  = argmax(highValue, key=value)
worst = argmin(lowValue,  key=value)

preferText = classifiedFeedback.prefer?.trim()
           || firstNonEmpty(best.reflection, best.agentText)
avoidText  = classifiedFeedback.avoid?.trim()
           || firstNonEmpty(worst.reflection, worst.agentText)

if !preferText and !avoidText: return null

draft = {
  preference:  preferText ? `Prefer: ${trim200(preferText)}`  : "Prefer the path that has worked in this context before.",
  antiPattern: avoidText  ? `Avoid:  ${trim200(avoidText)}`   : "Avoid repeating the same failing approach.",
  severity:    worst ? "warn" : "info",
  confidence:  classifiedFeedback?.confidence
            ?? (best && worst ? 0.6 : 0.4),
  …
}
```

`trim200` keeps the draft readable as a single chat-friendly line and
bails out on newlines (we only keep the first).

### 5.5 Normalisation

Both paths feed into `DecisionRepairDraft` with:

* `confidence = clamp01(v.confidence)` — `Infinity` / `NaN` / negative
  round to `0`, >1 round to `1`.
* `highValueTraceIds` / `lowValueTraceIds` — the trace IDs as persisted
  (not the capped bodies).
* `attachToPolicyIds` — `candidatePolicies` with duplicates removed,
  preserving insertion order.

---

## 6. Orchestration (`runRepair`)

```
startedAt = nowMs()
log.info("repair.run.start", { trigger, contextHash, toolId })

if isOnCooldown(repos, contextHash, cfg, startedAt):
    emit repair.skipped(reason: "cooldown"); return skip("cooldown")

if input.userText:
    classified = classifyFeedback(input.userText)
    emit feedback.classified(shape, confidence)

if !input.sessionId:
    emit repair.skipped(reason: "no-session"); return skip("no-session")

evidence  = gatherRepairEvidence({ sessionId, keyword: toolId ?? classified?.prefer ?? classified?.avoid })
valueDiff = (|mean(high.value) - mean(low.value)|) or Infinity if either side empty

if valueDiff < cfg.valueDelta and !classified:
    emit repair.skipped(reason: "value-delta-low"); return skip("value-delta-low")

candidatePolicies = policies where sourceEpisodeIds ∩ evidence.episodeIds ≠ ∅
emit repair.triggered({ trigger, contextHash, failureCount })

synth = await synthesizeDraft({ evidence, classified, toolId, candidatePolicies })
if !synth.ok:
    emit repair.skipped(reason: synth.reason); return skip(synth.reason)

row = persistRepair(repos, synth.draft, startedAt)
emit repair.persisted({ contextHash, repairId, confidence, severity })

if cfg.attachToPolicy and synth.draft.attachToPolicyIds.length > 0:
    attached = attachRepairToPolicies(synth.draft, deps)
    if attached.length > 0:
        emit repair.attached({ repairId, policyIds: attached })

return { repairId, draft, skipped: false, startedAt, completedAt }
```

### 6.1 Cooldown

`isOnCooldown` looks up `decisionRepairs.recentForContext(contextHash)`
— the repo returns rows ordered by `ts desc`. If the newest row is
younger than `cooldownMs`, we skip. `cooldownMs = 0` disables the
guard (used in tests).

### 6.2 Value-delta guard

The spec's §2.4.6 threshold `δ ≈ 0.5` protects against writing a
repair from noise. We only enforce it in the **unsolicited** path
(failure-burst). When the user explicitly said "this is wrong" we
treat that as ground truth and bypass the threshold — the user did the
classification for us.

When either list is empty we return `valueDiff = Infinity` so the
guard passes. This is intentional: a pure preference ("prefer rsync
over cp") produces only `highValue`, and a pure anti-pattern (3 tool
failures, no success) produces only `lowValue`. Both should still
yield a one-sided draft.

### 6.3 Policy attachment

`attachRepairToPolicies(draft, deps)`:

```
for policyId in draft.attachToPolicyIds:
    policy = repos.policies.getById(policyId)
    if !policy: continue
    next = mergePolicyGuidance(policy, draft)
    if next is null: continue    // already contains these lines
    repos.policies.upsert(next)
    push policyId to updated
return updated
```

`mergePolicyGuidance`:

```
existingTag    = parseGuidanceBlock(policy.boundary)
nextPreference = dedupe(existingTag.preference ++ [draft.preference])
nextAntiPattern = dedupe(existingTag.antiPattern ++ [draft.antiPattern])
if both arrays unchanged: return null   // no-op update
without        = stripGuidanceBlock(policy.boundary, "@repair")
next.boundary  = without + "\n\n" + renderGuidanceBlock(...)
next.updatedAt = nowMs()
return next
```

The `@repair {json}` block is deliberately compact so the skill
crystallizer can `JSON.parse` it on the next run. The block lives in
`boundary` (not a dedicated column) to stay schema-compatible with
existing policies — future migrations can move it into a typed column
without breaking the data path.

Dedup is case-sensitive on the trimmed string. This matches how
humans usually write preferences ("Prefer: apt-get install …") — if
the LLM produces a materially different sentence we do keep both.

---

## 7. Events

| Kind                  | Emitted by                    | Payload                                                           |
| --------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `repair.triggered`    | `runRepair` before synth      | `{ contextHash, trigger, failureCount }`                          |
| `repair.persisted`    | `runRepair` after DB insert   | `{ contextHash, repairId, confidence, severity }`                 |
| `repair.skipped`      | `runRepair` on every skip     | `{ contextHash, trigger, reason }`                                |
| `repair.attached`     | `runRepair` after attach      | `{ repairId, policyIds }`                                         |
| `feedback.classified` | `runRepair` (user path only)  | `{ shape, confidence }`                                           |

Dispatch is synchronous; listener errors are caught and logged via
`core.feedback.events` without breaking the bus (see `events.ts`).

---

## 8. Subscriber serialisation

`attachFeedbackSubscriber` defends against races:

```
inflight: Promise<void> | null
queue:    (() => Promise<void>)[]

enqueue(job):
    queue.push(job)
    if inflight: return         // drain is already running
    promise = drain().finally(() => if inflight === promise then inflight = null)
    inflight = promise

drain():
    while queue.length > 0:
        job = queue.shift()
        try: await job()
        catch err: log.error("repair.job.failed", { err: err.message })
```

Key properties:

1. **No parallel writes** — two bursts for the same `contextHash` in
   the same tick both land on the queue; the DB sees them one at a
   time.
2. **`flush()`** — awaits the active drain and all queued jobs. Tests
   use this instead of `setImmediate` to stay deterministic.
3. **Isolated failures** — a throw inside a job logs
   `repair.job.failed` and the next job still runs.
4. **Signal clear happens inside the job**, so if a job throws the
   signals keep their count and the next failure naturally re-arms
   the burst.

---

## 9. Deviations from V7

| V7 §   | Spec intent                                          | Implementation                                               |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| 2.4.6  | LLM produces preference / anti_pattern / severity    | Same, with deterministic template fallback.                  |
| 2.4.6  | `δ ≈ 0.5` threshold on value diff                    | Configurable `valueDelta`; user-driven path bypasses it.     |
| 2.4.6  | Persist to `decision_repairs`                        | Single atomic insert + optional per-policy update.           |
| 6.3    | Failure burst over "a few recent steps"              | Step-window rolling counter with explicit threshold.         |
| 6.3    | User feedback may classify via LLM                   | Deterministic rules only (MVP); LLM path reserved.           |
| 6.3    | Dual-layer feedback propagates to η / reward         | Policy guidance attaches → skill packager picks it up next   |
|        |                                                      | crystallization. Direct η blending happens in `core/skill`.  |
| —      | Cooldown to prevent thrash                           | Not in V7; added for local-plugin reliability.               |
| —      | Two-pass keyword relaxation                          | Not in V7; engineering guard-rail for normalized tool IDs.   |

---

## 10. Failure modes & guard-rails

| Failure                                    | Detection                                          | Behaviour                          |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------- |
| LLM schema mismatch                        | `isLlmRepairResponse(v) === false`                 | Template fallback; log warn.       |
| LLM transport error                        | `catch` in `synthesizeDraft`                       | Template fallback; log warn.       |
| Empty evidence window                      | `gatherRepairEvidence` returns two empty lists     | `insufficient-evidence` skip.      |
| Session not established                    | `!input.sessionId`                                 | `no-session` skip.                 |
| Repeat repair same context                 | Recent row younger than `cooldownMs`               | `cooldown` skip.                   |
| Value diff too small                       | `< cfg.valueDelta` in failure-burst path           | `value-delta-low` skip.            |
| DB write throws                            | `decisionRepairs.insert` throws                    | Caught by `drain`; logged; signal counter stays armed. |
| Two concurrent bursts same context         | Microtask queue serialises jobs                    | Second job runs after first; cooldown typically absorbs it. |
| Listener panics                            | `events.ts` wraps every dispatch in try/catch      | Other listeners still receive event. |

Everything that skips emits `repair.skipped { reason }` so the viewer
has a live "why did the agent not repair?" answer.
