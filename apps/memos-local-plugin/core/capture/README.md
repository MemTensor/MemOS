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
captureRunner.runReflect({ episode, closedBy })
    ↓
INSERT INTO traces ... (×N)  /  UPDATE traces SET reflection, alpha
    ↓
captureBus.emit({ kind: "capture.done", result })
```

- Per-turn `runLite` writes trace rows with `reflection=null` /
  `alpha=0` immediately, so the viewer sees the memory card.
- Topic-end `runReflect` re-runs the windowed binary scorer over the
  whole (now-closed) episode and patches each existing row.
- Abandoned episodes go through the same pipeline; Phase 7 still
  assigns `R_task = −1`.

## 2. Data flow

```
episode.turns  ──►  step-extractor             one StepCandidate per decision point
                        │
                        ▼
                    normalizer                 truncate / dedup / drop empty
                        │
                        ▼
            batch-scorer (windowed binary)     primary {batch=20, overlap=3, 1 retry}
                        │                      ↓ on any failed window
                        │                      degrade {batch=9, overlap=3, 2 retries}
                        │                      ↓ on any failed window
                        │                      episode-wide RELATED_DEFAULT fallback
                        ▼
                    merge by global_idx        1-over-0; missing window → RELATED_DEFAULT
                        │
                        ▼
                    embedder                   vec_summary + vec_action (Phase 3)
                        │
                        ▼
                  tracesRepo.insert /          + episodesRepo.updateTraceIds
                  tracesRepo.updateReflection
```

`traces.reflection` is always one of `RELATED | IRRELEVANT |
RELATED_DEFAULT` after `runReflect`. There is no natural-language
reflection text; downstream consumers use `reflectionAsText` (exported
from `core/capture/types.ts`) to filter the fixed labels out of prompts
and keyword blobs.

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
  llm,                // main LLM, used by the summariser
  reflectLlm,         // dedicated reflect LLM; falls back to `llm`
  bus: captureBus,
  cfg: {
    maxTextChars: 4000,
    maxToolOutputChars: 2000,
    embedTraces: true,
    llmConcurrency: 4,
    // Windowed binary reflection is the only supported mode.
    batchMode: "windowed",
    // alphaScoring / synthReflections / batchThreshold /
    // reflectionContextMode / longEpisodeReflectMode are retained for
    // backward config compatibility but ignored by the windowed
    // pipeline.
    alphaScoring: true,
    synthReflections: false,
    batchThreshold: 12,
  },
});

const sub = attachCaptureSubscriber(sessionManager.bus, runner);

// ...on shutdown...
sub.stop();
await sub.drain();
```

You can also call `runner.runLite(...)` / `runner.runReflect(...)`
directly (tests and integration tests do this).

## 4. Step extraction rules (V7 §3.2.1)

- **Split on `user` turns.** Each segment ending with at least one
  `assistant` turn becomes a step.
- **Merge tool turns** into the assistant step that preceded them within
  the same segment. `tool` turns emit `ToolCallDTO` entries with inputs,
  outputs, errors, and timing.
- **Sub-agent depth**: passed through from `turn.meta.depth` /
  `turn.meta.isSubagent`. The extractor doesn't create new episodes for
  sub-agents — they are extra traces under the same episode with
  `isSubagent=true`.
- **Synthetic fallback**: an episode with a user turn but no assistant
  turn still produces one skeletal trace so Phase 7 has somewhere to
  assign R_task.

## 5. Windowed binary reflection (V7 §3.2)

Per-step reflection / α scoring was replaced by a path-relevance
judgement. See [ALGORITHMS.md](./ALGORITHMS.md) for the full derivation;
the highlights:

- Each window is `≤ batch_size` consecutive steps, sliced with a fixed
  `overlap` so seam steps appear in two windows.
- The batch scorer returns `{ alpha: 0|1, relevance: "RELATED" |
  "IRRELEVANT" }` per step. Validator rejects any other shape.
- Overlap merge: any window calling a step `RELATED` (`alpha=1`) wins.
- If a step has no window result after both passes, it is written as
  `RELATED_DEFAULT` (the safe default).
- If any window in both passes failed, the whole episode is overwritten
  with `RELATED_DEFAULT`.
- The dispatcher never throws on reflection failure — only a DB
  `INSERT` is fatal.

## 6. α scoring

`α_t ∈ {0, 1}` only. There is no continuous score, no
`alphaScoring=false` neutral path, and no LLM-quality rubric. The
`alphaScoring` config flag is preserved for back-compat but has no
effect.

## 7. Embedding

- When `config.capture.embedTraces=true` and `embedder` is non-null, we
  build two texts per step — "state" (userText) and "action" (agentText +
  tool signatures) — and batch them through `embedder.embedMany(...)`.
- Failures fall back to `vecSummary=null / vecAction=null`. Vector
  search will just skip these rows.

## 8. Priority (V7 §3.3)

Initial `priority = 0.5` for every new trace so retrieval can find it
before reward backprop runs. The formula
`priority(f1) ∝ max(V, 0) · decay(Δt)` activates in Phase 7 after
backprop, when `tracesRepo.updateScore` runs.

## 9. Events

Capture runs on a dedicated `CaptureEventBus` (create via
`createCaptureEventBus()`) so the `SessionEvent` union stays closed and
stable. The orchestrator (Phase 15) bridges session.* and capture.*
into one unified stream for the viewer.

| Event                | Payload                                     | When                                                                  |
|----------------------|---------------------------------------------|-----------------------------------------------------------------------|
| `capture.started`    | `{episodeId, sessionId}`                    | Before stage 1.                                                       |
| `capture.lite.done`  | `{result: CaptureResult}`                   | After each per-turn `runLite` (no reward trigger).                    |
| `capture.done`       | `{result: CaptureResult}`                   | After `runReflect` completes; gates the reward / L2 / Skill cascade.  |
| `capture.failed`     | `{episodeId, sessionId, stage, error}`      | DB insert failed; throws afterwards.                                  |

Subscribers:
- **Phase 7 reward orchestrator** listens for `capture.done` to run
  R_human scoring + backprop.
- **Viewer SSE** forwards all three so the frontend can draw the
  "capture in progress / done" badge on episode cards.

## 10. Errors

- `internal` — DB insert raw throw.
- `llm_unavailable` / `llm_timeout` / `llm_output_malformed` — surfaced
  from the windowed scorer but converted to warnings (non-fatal). The
  episode-wide fallback writes `RELATED_DEFAULT` and the chain
  continues.

## 11. Logging channels

- `core.capture` — top-level run summary, warnings, timings.
- `core.capture.extractor` — extractor debug (segment counts, synthetic fallbacks).
- `core.capture.batch` — per-window batch run summary (steps, model, durationMs).
- `core.capture.summarizer` — per-turn summariser fallbacks.
- `core.capture.embed` — embed failures (1 line per batch).

Top-level events to watch:
- `capture.reflect.scoring.start` — kicks off `runEpisodeBatchScoring`
  for an episode.
- `capture.reflect.trace.scored` — per-trace patch result with final
  alpha + reflection label + reason.
- `capture.reflect.done` / `capture.lite.done` /
  `capture.lightweight.done` — phase completion summaries.
- `reflection_fallback_all_one` — episode-wide fallback was triggered.
  Includes `degraded=true`, `episodeId`, `stepsCount`,
  `failedWindows`.

## 12. Testing

Under `tests/unit/capture/`:
- `step-extractor.test.ts` — split rules, tool merging, sub-agent depth, synthetic fallback.
- `normalizer.test.ts` — truncation, dedup, drop-empty.
- `batch-scorer.test.ts` — binary validator, order-independence, payload shape.
- `embedder.test.ts` — pair interleaving, failure → null vectors.
- `capture.test.ts` (integration) — end-to-end with in-memory repos.
- `capture-batch.test.ts` — end-to-end with the windowed binary scorer.
- `subscriber.test.ts` — finalized→run wiring, abandoned opt-out, drain.

See `ALGORITHMS.md` for V7 formula derivations and prompt fingerprints.
