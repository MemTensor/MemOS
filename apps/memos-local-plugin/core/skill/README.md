# `core/skill` — Skill crystallizer + lifecycle (V7 §2.5)

Implements the **callable skill layer** of Reflect2Evolve V7. Where L1
stores individual traces, L2 stores "how to solve this recurring
sub-problem", and L3 stores the shape of the environment, the skill
layer answers: **"what are the agent-callable tools we have earned the
right to surface in prompts?"**

A `Skill` is an immutable, named, structured procedure with an
accompanying invocation guide. It is what we hand back to OpenClaw /
Hermes via Tier-1 retrieval — a distilled, resonance-verified, trial-
tested "mini-tool" grown out of real episodes.

Formally:

```
Skill = (name, invocationGuide, procedure, parameters, examples,
         η, trialsAttempted, trialsPassed, sourcePolicyIds, status)
```

* `η ∈ [0, 1]` — the **reliability** score. Drives both retrieval
  filtering (`minEtaForRetrieval`) and lifecycle transitions
  (`retireEta`).
* `status ∈ {probationary, active, retired}` — visible to retrieval;
  only `active` (and, in some code paths, `probationary`) skills are
  surfaced.

The full algorithm — eligibility, crystallization, verification,
packaging, lifecycle — is described in [`ALGORITHMS.md`](./ALGORITHMS.md).

## Pipeline

```
l2.policy.induced        ┐
l2.policy.updated (active) ├─ attachSkillSubscriber ─▶  runSkill(input, deps)
reward.updated           ┘
                                        │
                                        ▼
                       1. gatherPolicies(input)
                       2. evaluateEligibility(policies) per V7 §2.5.1
                       3. for each crystallize | rebuild decision:
                             a. gatherEvidence(policy)   — L1 trace slice
                             b. crystallizeDraft(...)    — LLM draft
                             c. verifyDraft(draft)       — coverage + resonance
                             d. buildSkillRow(draft)     — packager + embedder
                             e. repos.skills.upsert(row) — always probationary
                             f. emit skill.crystallized / skill.rebuilt
                       4. emit skill.eligibility.checked (rollup)
```

Nothing here blocks the reward or L2 pipeline: the subscriber is
event-driven and every triggered run is fully async. Listener errors
are captured so a bad downstream consumer can never break the
orchestrator.

## Key concepts

### Eligibility

A policy becomes a crystallization candidate when **all** hold:

* `policy.status === "active"`
* `policy.gain ≥ minGain`
* `policy.support ≥ minSupport`
* The policy has no non-retired skill citing it, **or** the existing
  skill's `updatedAt` is strictly older than the policy's
  `updatedAt` (→ rebuild).

See [`eligibility.ts`](./eligibility.ts) for the full verdict structure.

### Evidence gathering

`gatherEvidence` (see [`evidence.ts`](./evidence.ts)) pulls the traces
referenced by `policy.sourceEpisodeIds`, filters out redacted content,
scores each trace with a blend of trace `value` and cosine to the
policy vector, and caps it at `evidenceLimit` × `traceCharCap`
characters. Evidence is what the LLM sees and what the heuristic
verifier uses to detect hallucinated tool names or out-of-scope steps.

### LLM crystallization

`crystallizeDraft` runs the `skill.crystallize` prompt
([`core/llm/prompts/skill-crystallize.ts`](../llm/prompts/)). The
prompt packs the policy, its evidence, and the set of existing skill
names so the LLM stays deterministic-ish:

* names must be unique (`existing` → avoid clashes).
* steps must draw from the evidence tool calls.
* parameters must be typed JSON.
* `tags` are free-form domain hints.

The draft is then normalized into a `SkillCrystallizationDraft`
(see [`types.ts`](./types.ts)) and passed to the validator.

### Heuristic verification

`verifyDraft` (see [`verifier.ts`](./verifier.ts)) runs two purely
deterministic checks:

1. **Consistency coverage** — every command-like token in the draft
   (`` `apk add` ``, `docker.build`, `rg`, …) must appear in at least
   one evidence trace's action text. ≥ 50 % coverage required.
2. **Evidence resonance** — ≥ `minResonance` (default `0.5`) of evidence
   traces must overlap ≥ 2 tokens with the skill's summary + steps.

Verification **never** promotes a skill to `active` on its own —
freshly verified skills always enter `probationary` and must earn
their way up via trials.

### Packaging

`buildSkillRow` (see [`packager.ts`](./packager.ts)) shapes the draft
into a `SkillRow`:

* `procedureJson` — structured steps, parameters, examples,
  preconditions.
* `invocationGuide` — a terse markdown prompt-ready block that the
  agent adapter drops into the system prompt when Tier-1 retrieval
  picks this skill.
* `eta` — seeded from the policy's gain (for fresh mints) or carried
  forward and rescaled (for rebuilds).
* `vec` — an embedding of the skill's summary + trigger for Tier-1
  cosine retrieval.
* `sourcePolicyIds` — set-union with any existing skill's entries.

### Lifecycle

`applyFeedback` (see [`lifecycle.ts`](./lifecycle.ts)) is the single
state-transition function; `applySkillFeedback` is its orchestrator
wrapper that persists + emits events. It handles:

| Signal           | Effect on η                                     | Possible status change             |
| ---------------- | ----------------------------------------------- | ---------------------------------- |
| `trial.pass`     | Beta posterior `(passed+1)/(attempts+2)`        | probationary → active (threshold)  |
| `trial.fail`     | Beta posterior                                  | probationary → retired (threshold) |
| `user.positive`  | `η += etaDelta`                                 | retired → probationary (threshold) |
| `user.negative`  | `η -= etaDelta`                                 | any → retired (below retireEta)    |
| `reward.updated` | Blend 0.7·η + 0.3·newGain                       | any → retired (below retireEta)    |

### Events

Emitted via a dedicated `SkillEventBus`:

| Kind                           | When                                                     |
| ------------------------------ | -------------------------------------------------------- |
| `skill.eligibility.checked`    | After `evaluateEligibility` runs (rollup).               |
| `skill.crystallization.started`| Before the LLM call for one policy.                      |
| `skill.verification.passed`    | After the heuristic verifier accepts a draft.            |
| `skill.verification.failed`    | Verifier rejected a draft.                               |
| `skill.crystallized`           | Fresh mint persisted.                                    |
| `skill.rebuilt`                | Existing skill rebuilt after policy drift.               |
| `skill.eta.updated`            | Any `applySkillFeedback` call.                           |
| `skill.status.changed`         | Any lifecycle transition.                                |
| `skill.retired`                | Transitioned to retired.                                 |
| `skill.failed`                 | A single-policy failure (no run-level throw).            |

## Public API

```ts
import {
  attachSkillSubscriber,
  runSkill,
  applySkillFeedback,
  createSkillEventBus,
  type SkillConfig,
  type RunSkillInput,
  type RunSkillResult,
} from "@memtensor/memos-local-plugin/core/skill";
```

* `runSkill(input, deps)` — imperative entry point; also what the
  subscriber calls internally.
* `attachSkillSubscriber(deps)` — wires the skill module to the L2
  and reward buses. Returns a handle with `runOnce`, `applyFeedback`,
  `flush`, `dispose`.
* `applySkillFeedback(skillId, kind, deps, magnitude?)` — apply one
  feedback signal (trial result / user thumbs / reward drift) to a
  single skill.
* `createSkillEventBus()` — typed bus the module emits on.

## Persistence

* `skills` — the primary table; see
  [`../storage/repos/skills.ts`](../storage/repos/skills.ts).
  * `procedure_json` — full structured skill procedure.
  * `invocation_guide` — markdown block.
  * `eta`, `trials_attempted`, `trials_passed` — lifecycle state.
  * `source_policy_ids_json`, `source_world_model_ids_json`.
  * `vec` — `Float32Array` BLOB for Tier-1 retrieval.

Retrieval consumers should filter on `status IN ('probationary','active')`
and `eta >= minEtaForRetrieval` unless they are explicitly debugging.

## Configuration

See `algorithm.skill` in
[`docs/CONFIG-ADVANCED.md`](../../docs/CONFIG-ADVANCED.md#algorithmskill).

| Key                         | Default | Purpose                                               |
| --------------------------- | ------- | ----------------------------------------------------- |
| `minSupport`                | `2`     | Min distinct-episode support to crystallize.          |
| `minGain`                   | `0.02`  | Min policy gain required (paired with the new shrinkage-anchored gain in `core/memory/l2/gain.ts`). |
| `candidateTrials`           | `3`     | Trials required to transition out of `candidate`. NOTE: legacy docs called this `probationaryTrials`; the schema field is `candidateTrials`. |
| `cooldownMs`                | `60000` | Debounce between runs triggered by the same policy.   |
| `traceCharCap`              | `600`   | Char cap per evidence trace in the crystallize prompt.|
| `evidenceLimit`             | `4`     | Max evidence traces per crystallize call.             |
| `useLlm`                    | `true`  | Toggle the LLM off (tests / degraded mode).           |
| `etaDelta`                  | `0.1`   | η step per `user.positive`/`user.negative`.           |
| `retireEta`                 | `0.25`  | η floor; crossing retires.                            |
| `minEtaForRetrieval`        | `0.5`   | η gate for Tier-1 retrieval + auto-promotion.         |

## Logging

All skill work logs on dedicated channels (see
[`../../docs/LOGGING.md`](../../docs/LOGGING.md)):

* `core.skill` — run lifecycle.
* `core.skill.crystallize` — LLM prompt + skipped reasons.
* `core.skill.verifier` — coverage + resonance verdicts.
* `core.skill.packager` — row-shaping + embedder outcomes.
* `core.skill.subscriber` — event-driven triggers.
* `core.skill.events` — listener dispatch errors.

Because skill changes materially affect what the agent sees, every
`skill.crystallized` / `skill.retired` is also routed to the **audit**
log (`logs/audit.jsonl`, never deleted) via the `skill` channel.

## Tests

* `tests/unit/skill/eligibility.test.ts` — skip / crystallize / rebuild verdicts.
* `tests/unit/skill/evidence.test.ts` — trace selection, char capping, redaction.
* `tests/unit/skill/crystallize.test.ts` — LLM draft normalization + failures.
* `tests/unit/skill/verifier.test.ts` — coverage + resonance checks.
* `tests/unit/skill/packager.test.ts` — row shape, invocation guide, embedder failure.
* `tests/unit/skill/lifecycle.test.ts` — trial counter, thumbs, retire on drift.
* `tests/unit/skill/events.test.ts` — bus contract.
* `tests/unit/skill/skill.integration.test.ts` — end-to-end against real SQLite.
* `tests/unit/skill/subscriber.test.ts` — event-driven trigger + runOnce + flush.

Run the whole skill suite with
`npm test -- tests/unit/skill`.
