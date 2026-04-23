# core/capture

The Phase 6 "reflection & trace extraction" stage. Converts a finalized
`EpisodeSnapshot` (from Phase 5) into L1 trace rows that Phase 7+ will
backprop rewards onto and Phase 9+ will induct policies from.

## 1. When it runs

```
sessionBus.on("episode.finalized")
    ↓
attachCaptureSubscriber(...)   ← this module
    ↓
createCaptureRunner.run({ episode, closedBy })
    ↓
INSERT INTO traces ... (×N)
    ↓
sessionBus.emit({ kind: "capture.done", result })
```

- One episode → 0..N trace rows (one per agent step).
- Abandoned episodes are captured too (V7 treats them as R_task=−1, which
  Phase 7 assigns). Toggle with `captureAbandoned: false` if you need to.
- Fire-and-forget by default; tests call `drain()` to await all pending.

## 2. Data flow

```
episode.turns  ──►  step-extractor         one StepCandidate per decision point
                        │
                        ▼
                    normalizer             truncate / dedup / drop empty
                        │
                        ▼
               reflection-extractor        prefer adapter-provided; else regex
                        │ ←─ (optional) reflection-synth (LLM)
                        ▼
                  alpha-scorer             REFLECTION_SCORE_PROMPT → α ∈ [0,1]
                        │                  usable=false ⇒ α = 0
                        ▼
                    embedder               vec_summary + vec_action (Phase 3)
                        │
                        ▼
                  tracesRepo.insert        + episodesRepo.updateTraceIds
```

## 3. Public API

```ts
import {
  createCaptureRunner,
  attachCaptureSubscriber,
} from "@memos/core";

const captureBus = createCaptureEventBus();
const runner = createCaptureRunner({
  tracesRepo,
  episodesRepo,
  embedder,           // nullable (then vec is null)
  llm,                // nullable (then α stays neutral 0.5 if reflection exists)
  bus: captureBus,
  cfg: {
    maxTextChars: 4000,
    maxToolOutputChars: 2000,
    embedTraces: true,
    alphaScoring: true,
    synthReflections: false,
    llmConcurrency: 4,
    // V7 §3.2 batched variant — one LLM call per episode. See §6a.
    batchMode: "auto",
    batchThreshold: 12,
  },
});

const sub = attachCaptureSubscriber(sessionManager.bus, runner);

// ...on shutdown...
sub.stop();
await sub.drain();
```

You can also call `runner.run({episode, closedBy})` synchronously (tests
and integration tests do this).

## 4. Step extraction rules (V7 §3.2.1)

- **Split on `user` turns.** Each segment ending with at least one
  `assistant` turn becomes a step.
- **Merge tool turns** into the assistant step that preceded them within
  the same segment. `tool` turns emit `ToolCallDTO` entries with inputs,
  outputs, errors, and timing.
- **Sub-agent depth**: passed through from `turn.meta.depth` / `turn.meta.isSubagent`.
  The extractor doesn't create new episodes for sub-agents — they are
  extra traces under the same episode with `isSubagent=true`.
- **Synthetic fallback**: an episode with a user turn but no assistant
  turn still produces one skeletal trace so Phase 7 has somewhere to
  assign R_task.

## 5. Reflection resolution

Order (highest-precedence first):

1. `step.rawReflection` (from `turn.meta.reflection`, set by the adapter
   when the host agent emits self-reflections natively). Source: `adapter`.
2. `extractReflection(step)` — regex over `agentText` for Markdown
   `### Reasoning:` blocks, `<reflection>...</reflection>` tags, and a
   small Chinese/English heuristic set. Source: `extracted`.
3. `synthesizeReflection(llm, step)` — only when
   `config.capture.synthReflections=true`. Source: `synth`.
4. Otherwise `reflection.text = null`, `alpha = 0`, `usable = false`.
   Source: `none`.

## 6. α scoring (V7 §3.2.3, eq. 5)

When a reflection exists:

- If `config.capture.alphaScoring=false`: α defaults to `0.5` (neutral),
  `usable=true`. Phase 7 will backprop but weighted half-strength.
- Otherwise: call `REFLECTION_SCORE_PROMPT` with
  `{state, action, outcome, reflection}` and parse JSON `{alpha, usable, reason}`.
  When `usable=false`, we clamp `α=0` before persisting.

LLM failures fall back to neutral α (same as "scoring disabled") plus a
warning in `CaptureResult.warnings`. Capture NEVER throws on LLM failure
alone — only a DB `INSERT` failure is fatal.

## 6a. Batched ρ+α (V7 §3.2 batched variant)

Per-step calls are expensive on long episodes (2N LLM calls for N steps).
`batch-scorer.ts` collapses synth + α into ONE LLM call covering every
step. Activated by `algorithm.capture.batchMode`:

| value | behavior |
|-------|----------|
| `per_step` | legacy path; one synth + one α call per step (`llmConcurrency` workers in parallel) |
| `per_episode` | always batch; one call per episode |
| `auto` (default) | batch when `stepCount ≤ batchThreshold` (default 12); else fall back to per-step |

Batched mode also gives the LLM access to the **full causal chain** of the
episode in one shot, so reflections it writes can credit-attribute across
steps (V7 §3.2.3 axes `causal_insight` / `transferability` benefit).

Bookkeeping is split across `CaptureResult.llmCalls`:
- `batchedReflection`: 0 or 1 per episode (1 on a clean batched call).
- `reflectionSynth` / `alphaScoring`: only nonzero in per-step mode.

Failures in the batched call (LLM throw, malformed JSON, length mismatch)
are logged as a `stage: "batch"` warning and capture **automatically falls
back** to the per-step path — no traces are lost.

## 7. Embedding

- When `config.capture.embedTraces=true` and `embedder` is non-null, we
  build two texts per step — "state" (userText) and "action" (agentText +
  tool signatures) — and batch them through `embedder.embedMany(...)`.
- Failures fall back to `vecSummary=null / vecAction=null`. Vector search
  will just skip these rows.

## 8. Priority (V7 §3.3)

Initial `priority = 0` for every new trace. The formula
`priority(f1) ∝ max(V, 0) · decay(Δt)` activates in Phase 7 after
backprop, when `tracesRepo.updateScore` runs.

## 9. Events

Capture runs on a dedicated `CaptureEventBus` (create via
`createCaptureEventBus()`) so the `SessionEvent` union stays closed and
stable. The orchestrator (Phase 15) bridges session.* and capture.*
into one unified stream for the viewer.

| Event                | Payload                                     | When                                       |
|----------------------|---------------------------------------------|--------------------------------------------|
| `capture.started`    | `{episodeId, sessionId}`                    | Before stage 1.                            |
| `capture.done`       | `{result: CaptureResult}`                   | After all rows are persisted (happy path). |
| `capture.failed`     | `{episodeId, sessionId, stage, error}`      | DB insert failed; throws afterwards.       |

Subscribers:
- **Phase 7 reward orchestrator** listens for `capture.done` to run
  R_human scoring + backprop.
- **Viewer SSE** forwards all three so the frontend can draw the
  "capture in progress / done" badge on episode cards.

## 10. Errors

- `internal` — DB insert raw throw.
- `llm_unavailable` / `llm_timeout` / `llm_output_malformed` — surfaced
  from alpha / synth stages but converted to warnings (non-fatal).

## 11. Logging channels

- `core.capture` — top-level run summary, warnings, timings.
- `core.capture.extractor` — extractor debug (segment counts, synthetic fallbacks).
- `core.capture.reflection` — extraction/synth details.
- `core.capture.alpha` — α scores per step, model id, reason.
- `core.capture.batch` — batched ρ+α run summary (steps, synthAccepted, model).
- `core.capture.embed` — embed failures (1 line per batch).

## 12. Testing

Under `tests/unit/capture/`:
- `step-extractor.test.ts` — split rules, tool merging, sub-agent depth, synthetic fallback.
- `normalizer.test.ts` — truncation, dedup, drop-empty.
- `reflection-extractor.test.ts` — adapter-priority, regex matches per language, length cap.
- `alpha-scorer.test.ts` — JSON parse, clamp, `usable=false → α=0`, LLM error path.
- `reflection-synth.test.ts` — happy path, `NO_REFLECTION` sentinel, LLM error.
- `batch-scorer.test.ts` — batched ρ+α validator, order-independence, synth-disabled fallback.
- `embedder.test.ts` — pair interleaving, failure → null vectors.
- `capture.test.ts` (integration) — end-to-end with in-memory repos (per-step path).
- `capture-batch.test.ts` — end-to-end with batched ρ+α + auto-mode threshold fallback.
- `subscriber.test.ts` — finalized→run wiring, abandoned opt-out, drain.

See `ALGORITHMS.md` for V7 formula derivations and prompt fingerprints.
