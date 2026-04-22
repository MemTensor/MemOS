# Advanced configuration

The default `config.yaml` shipped by `install.sh` only exposes the handful of
fields a user is likely to care about (viewer port, embedding/LLM provider,
hub, telemetry, log level). Everything else is controlled by baked-in
defaults that match the V7 algorithm spec.

If you need to override any of these, just add the corresponding block to
`config.yaml`. The writer preserves comments and field order, so partial
overrides are safe.

## What's hidden from the default template (but still honored if you add it)

### `viewer`
```yaml
viewer:
  port: 18910
  bindHost: 127.0.0.1       # do NOT change unless you know why
  openOnFirstTurn: false
```

### `bridge`
```yaml
bridge:
  port: 18911
  mode: stdio               # stdio | tcp
```

### `embedding`
```yaml
embedding:
  endpoint: ""              # override cloud provider base URL
  model: "Xenova/all-MiniLM-L6-v2"
  dimensions: 384
  cache:
    enabled: true
    maxItems: 20000
```

### `llm`
```yaml
llm:
  endpoint: ""              # override provider base URL
  temperature: 0
  fallbackToHost: true      # retry through the OpenClaw host LLM on failure
  timeoutMs: 45000
  maxRetries: 3
```

### `algorithm`
Direct mapping to the V7 spec (γ, support, gain, top-K, etc.). Change only
if you know what you're doing — defaults are calibrated for the paper.

```yaml
algorithm:
  capture:
    maxTextChars: 4000        # per-turn text cap before truncation
    maxToolOutputChars: 2000  # per-tool-call output cap
    embedTraces: true         # vectorize state+action with the embedder
    alphaScoring: true        # ask the LLM to grade each reflection (α ∈ [0,1])
    synthReflections: false   # ask the LLM to WRITE a reflection when missing
    llmConcurrency: 4         # parallel LLM calls per episode
  reward:
    gamma: 0.9                # γ discount factor (V7 §0.6 eq. 4/5)
    tauSoftmax: 0.5           # τ for softmax reweighting in Phase 9 L2 induction
    decayHalfLifeDays: 30     # priority decay half-life (V7 §3.3)
    llmScoring: true          # use rubric LLM for R_human; off = heuristic only
    implicitThreshold: 0.2    # |R_human| threshold for implicit-feedback runs
    feedbackWindowSec: 600    # wait this long after capture.done for explicit feedback (0 disables)
    summaryMaxChars: 2000     # cap on the task summary handed to the scorer LLM
    llmConcurrency: 2         # parallel R_human LLM calls
  l2Induction:
    minSimilarity: 0.72            # cosine floor for trace→policy association
    candidateTtlDays: 30           # TTL for unpromoted rows in l2_candidate_pool
    minEpisodesForInduction: 2     # min distinct episodes to mint a new policy
    minTraceValue: 0.1             # ignore traces whose V < this after backprop
    useLlm: true                   # false = collect candidates but never call l2.induction
    traceCharCap: 3000             # chars per trace handed to the induction prompt
    retireGain: -0.05              # active policies dipping below this → retired
  l3Abstraction:
    minPolicies: 3                 # min compatible L2s to trigger abstraction
    minPolicyGain: 0.1             # eligible L2 gain floor
    minPolicySupport: 1            # eligible L2 support floor
    clusterMinSimilarity: 0.6      # cosine cutoff for cluster-and-merge decisions
    policyCharCap: 800             # chars per policy in the prompt
    traceCharCap: 500              # chars per evidence trace in the prompt
    traceEvidencePerPolicy: 1      # evidence traces per policy in the prompt
    useLlm: true                   # false = collect clusters but never call l3.abstraction
    cooldownDays: 1                # debounce per primary domain tag (0 = disable)
    confidenceDelta: 0.05          # confidence step per merge / human thumb
    minConfidenceForRetrieval: 0.2 # Tier-3 hides WMs below this
  skill:
    minSupport: 3                  # min distinct-episode support to crystallize
    minGain: 0.15                  # min policy gain to crystallize
    probationaryTrials: 5          # trials to transition out of probationary
    cooldownMs: 60000              # debounce between crystallize runs for a policy
    traceCharCap: 600              # chars per evidence trace in the crystallize prompt
    evidenceLimit: 4               # max evidence traces per crystallize call
    useLlm: true                   # false = schedule runs but skip LLM crystallization
    etaDelta: 0.1                  # η step per user.positive/user.negative thumbs
    retireEta: 0.25                # η floor; crossing retires
    minEtaForRetrieval: 0.5        # η gate for Tier-1 retrieval + auto-promotion
  feedback:
    failureThreshold: 3            # failures in `failureWindow` that trigger a burst (V7 §6.3)
    failureWindow: 5               # rolling tool-call window per (toolId, context)
    valueDelta: 0.5                # |mean(high) - mean(low)| floor before repair fires (V7 §2.4.6 δ)
    useLlm: true                   # false = skip the decision.repair LLM call; template-only
    attachToPolicy: true           # merge the draft into `policy.boundary` @repair block
    cooldownMs: 60000              # debounce between repeat repairs for the same contextHash
    traceCharCap: 500              # chars per evidence trace in the decision-repair prompt
    evidenceLimit: 4               # max high-value / low-value traces per synthesis call
  retrieval:
    tier1TopK: 3            # skills injected at turn start
    tier2TopK: 5            # trace/episode snippets
    tier3TopK: 2            # world-model snippets
    candidatePoolFactor: 4  # poolSize = tierTopK × this, before ranking
    weightCosine: 0.6       # Tier-2 relevance = w_cos·cos + w_pri·priority
    weightPriority: 0.4
    mmrLambda: 0.7          # MMR: λ·rel − (1-λ)·redundancy; 1.0 = pure rel, 0 = pure diversity
    rrfConstant: 60         # k in RRF: score = Σ 1/(k+rank_i)
    minSkillEta: 0.5        # hide Tier-1 skills with η below this
    minTraceSim: 0.35       # hide Tier-2 traces below cosine threshold
    includeLowValue: false  # include priority=0 traces (overridden to true by repair entry)
    tagFilter: auto         # auto | strict | off — pre-filter traces by domain tag
    keywordTopK: 20         # per-tier FTS + pattern channel size (vector channel still uses tier{1,2,3}TopK · candidatePoolFactor)
    relativeThresholdFloor: 0.4
    # Drop ranked candidates whose blended `relevance < topRelevance · this`.
    # Adaptive cousin of `minTraceSim`: a strong query (top relevance 0.9)
    # trims to ≥ 0.36; a weak query (top 0.4) keeps items down to ≥ 0.16.
    # Set to 0 to disable the relative cutoff entirely.
    skillEtaBlend: 0.15     # blend weight for Tier-1 skill `η` (reliability).
    # Default 0.15 — cosine dominates, η is a small nudge so stale-but-
    # well-trodden skills no longer outrank fresh, query-aligned ones.
    smartSeed: true         # MMR seed-by-tier only when tier's best clears the relative floor
    skillInjectionMode: summary  # summary (default) | full
    # summary  → Tier-1 skills land in the prompt as `name + η + 1-line
    #            description + a `skill_get(id="…")` invocation hint`. The
    #            host model loads the full procedure on demand by calling
    #            the `skill_get` tool. Keeps prompts small.
    # full     → Inline the entire `invocationGuide` body (legacy). Use
    #            this if your host doesn't support tool / function calls.
    skillSummaryChars: 200  # char cap for the per-skill summary line
    # (The retrieval-trigger policy — turn-start / tool-driven / repair —
    # is not user-tunable; it's documented in ARCHITECTURE.md §4 and
    # core/retrieval/README.md.)
```

#### Tuning cheat-sheet

| Symptom                                              | Try                                                          |
|------------------------------------------------------|--------------------------------------------------------------|
| Packet dominated by old, off-topic traces            | Lower `weightPriority`, raise `minTraceSim`.                 |
| Similar traces keep repeating in packet              | Lower `mmrLambda` (0.5–0.6) for more diversity.              |
| Tag filter suppresses legitimate results             | Keep `tagFilter: auto` (fallback kicks in) or set `"off"`.   |
| Too few skills surface after restart / fresh install | Lower `minSkillEta` (0.3); skills start at η=0.5 by default. |
| Ranker too slow in perf logs                         | Lower `candidatePoolFactor` (e.g. 3).                        |
| L2 induction fires on single-episode loops (noisy)   | Raise `l2Induction.minEpisodesForInduction` (e.g. 3).        |
| Useful L2 policies never get promoted to `active`    | Lower `algorithm.skill.minGain` or `minSupport`.             |
| LLM costs too high during heavy on-ramp              | Set `l2Induction.useLlm: false` — candidates still collect.  |
| Active policies churn between `active` ↔ `retired`   | Lower `l2Induction.retireGain` (-0.10 for a wider dead-zone).|
| L3 world models never get created                    | Lower `l3Abstraction.minPolicies` (e.g. 2) or `clusterMinSimilarity` (e.g. 0.55). |
| Too many near-duplicate world models                 | Raise `l3Abstraction.clusterMinSimilarity` (0.65–0.7).         |
| Low-confidence world models leak into retrieval      | Raise `l3Abstraction.minConfidenceForRetrieval`.                |
| Skills never graduate from `probationary`            | Lower `skill.probationaryTrials` (e.g. 3) or `minEtaForRetrieval` (e.g. 0.4). |
| Skills churn between `active` ↔ `retired`            | Lower `skill.retireEta` (0.15) or raise `etaDelta` damping.     |
| Verifier rejects most drafts with "coverage-low"     | Raise `skill.traceCharCap`/`evidenceLimit` so more evidence reaches the verifier. |
| Too few skills surface — retrieval empty             | Lower `skill.minSupport` (2) or `minGain` (0.05).               |
| Agent ignores obvious failure loops (≥3 tries)       | Lower `feedback.failureThreshold` (2) or `failureWindow` (3).   |
| "value-delta-low" keeps skipping valid repairs       | Lower `feedback.valueDelta` (0.3) — it's the §2.4.6 δ floor.    |
| Decision-repair table fills with near-duplicates     | Raise `feedback.cooldownMs` (e.g. 300000 = 5 min).              |
| Repair guidance never reaches skills                 | Check `feedback.attachToPolicy: true` and that the source      |
|                                                      |   policies are `active`; only active policies get tagged.       |
| Template-only repairs feel generic                   | Set `feedback.useLlm: true` and confirm the LLM provider works. |


### `hub`
```yaml
hub:
  role: client              # hub | client
  port: 18912
  teamName: ""
  nickname: ""
```

### `logging`
```yaml
logging:
  console:
    enabled: true
    pretty: true
    channels: ["*"]
  file:
    enabled: true
    format: json             # json | compact
    rotate:
      maxSizeMb: 50
      maxFiles: 14
      gzip: true
    retentionDays: 30        # app/error files
  audit:
    enabled: true
    rotate:
      monthly: true
      gzip: true
    # Note: audit/llm/perf/events are kept FOREVER by design. If you really
    # need to prune them, gzip them out of logs/ by hand.
  llmLog:
    enabled: true
    redactPrompts: false
    redactCompletions: false
  perfLog:
    enabled: true
    sampleRate: 1.0
  eventsLog:
    enabled: true
  redact:
    extraKeys: ["api_key", "secret", "token", "password", "authorization"]
    extraPatterns: []
  channels: {}               # per-channel level overrides, e.g. "core.l2.cross-task": debug
```

## Resetting to defaults

Delete the block in `config.yaml`. On next load the schema's default value
kicks in.

## Environment-variable overrides (dev/test only)

| Env var             | Effect                                                        |
|---------------------|---------------------------------------------------------------|
| `MEMOS_HOME`        | Overrides the whole runtime home. All paths recomputed from it. |
| `MEMOS_CONFIG_FILE` | Overrides only the config file path.                          |

These are intentionally undocumented in user-facing docs — they're meant for
tests and CI, not day-to-day configuration.
