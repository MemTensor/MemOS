# `core/skill` — Algorithms

This note anchors the skill implementation to the Reflect2Evolve V7
spec (§2.5) and calls out the deviations we took for the local-plugin
runtime. Read alongside `README.md` for the high-level contract.

---

## 1. Triggers & eligibility

`runSkill` is driven by three events (all subscribed to via
`attachSkillSubscriber`):

* `l2.policy.induced` — a brand-new policy exists; first chance to
  crystallize.
* `l2.policy.updated` with `status === "active"` — a policy re-entered
  the active cohort after hitting the support/gain thresholds.
* `reward.updated` — every policy referenced by that episode is
  re-evaluated; allows existing skills to pick up η drift from human
  scores.

For every candidate policy, `evaluateEligibility` (see
[`eligibility.ts`](./eligibility.ts)) emits one of three verdicts:

```
verdict = {
  "skip"        // policy.status ≠ active OR gain < θ OR support < σ
                //                OR existing skill is fresher than policy
  "crystallize" // no non-retired skill cites this policy yet
  "rebuild"     // existing active/probationary skill, but the policy
                //   has drifted since (policy.updatedAt > skill.updatedAt)
}
```

A **retired** skill does not block crystallization: we treat it as if
the policy has no existing skill, so the module can fully replace an
abandoned skill line. We still attach the retired row to
`existingSkill` so downstream logging records the transition.

---

## 2. Evidence gathering

`gatherEvidence` (see [`evidence.ts`](./evidence.ts)) receives the
candidate policy, walks `policy.sourceEpisodeIds`, and pulls the
associated L1 traces from `traces`.

For each candidate trace we compute a blended score:

```
score(trace) = 0.7 · trace.value + 0.3 · cosine(trace.vecSummary, policy.vec)
```

then:

1. filter out redacted traces (content begins with `[REDACTED`).
2. sort by score desc.
3. take the top `evidenceLimit` rows.
4. truncate each trace's `userText + agentText + reflection` to
   `traceCharCap` characters, preserving the leading context.

The output is both the list of evidence traces and the set of
unique episode ids (used later to write `sourceEpisodeIds` into
the skill row).

If the filter produces zero traces we short-circuit the run with a
`skill.failed { stage: "evidence", reason: "no-evidence" }` event
instead of fabricating content.

---

## 3. LLM crystallization

`crystallizeDraft` (see [`crystallize.ts`](./crystallize.ts)) sends a
packed prompt to the LLM via `LlmClient.completeJson`. Inputs packed
into the prompt:

* policy: id, title, trigger, procedure, verification, boundary.
* evidence: trace excerpts (capped) with the trace's `value` and
  reflection included.
* `namingSpace`: the set of existing skill names so the LLM must pick
  a new one when crystallizing, or the exact same name when rebuilding.

The expected JSON shape (strict; validated via `defaultDraftValidator`):

```jsonc
{
  "name": "<lowercase_snake_case>",
  "displayTitle": "<sentence>",
  "summary": "<1-3 sentences>",
  "preconditions": ["..."],
  "parameters": [{"name":"pkg","type":"string","required":true,"description":"..."}],
  "steps": [{"title":"...","body":"..."}],
  "examples": [{"input":"...","expected":"..."}],
  "tags": ["pip", "alpine"]
}
```

If the LLM call fails or the response is not parseable as the expected
schema, the module emits `skill.failed { stage: "crystallize", reason }`
for that policy and continues with the next one. Nothing is persisted
and the policy stays eligible for the next trigger.

When `config.useLlm === false` (test mode / degraded runtime) we
short-circuit with `skill.failed { reason: "llm_disabled" }`.

---

## 4. Heuristic verification

`verifyDraft` (see [`verifier.ts`](./verifier.ts)) runs two
deterministic checks on the draft:

### Consistency coverage

```
commandLike = tokens that look like shell commands / module paths
              (e.g. "apk add", "docker.build", "rg", "pip install")
coverage = |commandLike ∩ actionBlob| / |commandLike|
```

* `actionBlob` is the concatenation of every trace's
  `userText + agentText + reflection`, lowercased.
* `commandLike` is extracted from the draft's `steps` and `examples`
  via a regex that catches backticked tokens and `name.method`-style
  identifiers of length ≥ 3.
* Stopwords (`the`, `with`, `steps`, …) are filtered out.

Verdict: `ok = coverage ≥ 0.5 || commandLike.length === 0`.

### Evidence resonance

```
draftTokens = unique tokens in (summary + steps.title + steps.body)
resonance   = |{ trace : |tokens(trace) ∩ draftTokens| ≥ 2 }| / |evidence|
```

Verdict: `ok = resonance ≥ minResonance` (default `0.5`).

Both checks are cheap string matching by design — this is not a
security gate, it is a first-line defence against hallucinated tool
names. A skill can still be wrong about intent; the trial cycle is
what catches that.

A rejected draft emits `skill.verification.failed` and the policy
stays eligible for the next trigger.

---

## 5. Packaging

`buildSkillRow` (see [`packager.ts`](./packager.ts)) deterministically
shapes the verified draft into a `SkillRow`. Highlights:

* **id** — reuse `existing.id` on rebuilds; mint a fresh `sk_…` ULID on
  fresh crystallizations.
* **procedureJson** — the structured draft (steps, params, examples)
  serialized as JSON for audit + future refinements.
* **invocationGuide** — a compact markdown block the agent adapter
  injects into the system prompt when retrieval surfaces the skill.
* **eta** — via `deriveInitialEta`:
  * fresh mint → `max(minEtaForRetrieval, policy.gain)`.
  * rebuild → carry the existing η forward, clamped into `[0, 1]`.
* **vec** — embed `summary + steps + trigger` via the configured
  `Embedder`. If embedding fails we log and persist `vec = null`;
  the row is still useful (Tier-1 will simply fall back to BM25-like
  heuristics for this skill).
* **trialsAttempted / trialsPassed** — carried forward on rebuild,
  start at `0/0` on fresh mint.
* **sourcePolicyIds** — set-union `[policy.id, ...existing.sourcePolicyIds]`
  so one skill may cite multiple policies (a common occurrence when
  L2 later generalises).

Every newly built row is persisted with `status = "probationary"`.
Verifier success is not sufficient to auto-promote — the agent must
accumulate trial evidence first.

---

## 6. Lifecycle (η, trials, status)

`applyFeedback` (see [`lifecycle.ts`](./lifecycle.ts)) is the single
state-transition function. All updates are computed from the current
skill row and the feedback signal; no hidden state.

### Trials (`trial.pass` / `trial.fail`)

```
trialsAttempted' = trialsAttempted + 1
trialsPassed'    = trialsPassed + (passed ? 1 : 0)
η' = clamp01((trialsPassed' + 1) / (trialsAttempted' + 2))   // Beta(1,1)
```

Transition rules:

```
if status == candidate && trialsAttempted' ≥ candidateTrials:
    if η' ≥ minEtaForRetrieval:  status' = active
    else:                         status' = archived
if status == active && η' < archiveEta:
    status' = archived
```

> Field name note: earlier drafts of this doc called the threshold
> `probationaryTrials`. The actual schema / config field is
> `candidateTrials` — see `core/skill/types.ts` and
> `core/config/schema.ts`. Default lowered from 5 → 3 in 2026-04 so
> first-time skills can graduate within a normal usage week instead of
> sitting in `candidate` forever.

The Beta(1,1) prior keeps early trials from whipsawing η between 0
and 1 — `2/3 passes` yields η ≈ 0.6 instead of 0.67, `0/3 passes`
yields η = 0.2 instead of 0.

### User thumbs (`user.positive` / `user.negative`)

```
η' = clamp01(η ± etaDelta)   // etaDelta default 0.1
```

* retired → probationary if η' ≥ minEtaForRetrieval (rehab).
* active / probationary → retired if η' < retireEta.

### Reward drift (`reward.updated`)

```
η' = clamp01(0.7·η + 0.3·magnitude)   // magnitude = updated policy gain
```

We deliberately blend (not overwrite) so a single noisy reward run
can't take down a well-trialled skill. If the blend drives η under
`retireEta` we still retire; the skill can rehab later via positive
signals.

---

## 7. Retrieval surface

Downstream tiers must filter as follows to avoid surfacing
misrepresented skills:

```
visible = skills where status IN ('probationary', 'active')
                    AND eta ≥ minEtaForRetrieval
```

Retired skills are kept in the database for audit + potential
rehabilitation but never retrieved. Probationary skills are surfaced
with a subtle "beta" flag so the UI layer can indicate the skill is
still under trial.

---

## 8. Cooldown

`cooldownMs` debounces repeat runs for the same policy triggered by
rapid-fire upstream events (e.g. a burst of `reward.updated`). The
subscriber holds a simple in-memory `{policyId → lastRunAt}` table.

If `cooldownMs === 0` (as in unit tests), every event triggers a run.

---

## 9. Failure policy

Every per-policy failure is scoped: the orchestrator logs, emits
`skill.failed { stage, reason }`, and moves on to the next candidate.
A skill run never throws because one policy in a batch misbehaves.
Run-level cancellation is never used — the orchestrator instead
returns `rejected` / `warnings` counts in `RunSkillResult` so the
caller can assert on them.
