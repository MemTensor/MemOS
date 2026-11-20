# Architecture

This document is the living blueprint for `@memtensor/memos-local-plugin`. It
covers the layering, the agent-agnostic core, the contract layer, the per-agent
adapters, the runtime services (server + bridge), the viewer, and the supporting
docs/test infrastructure.

> If a module disagrees with this document, fix the document **or** the module.
> Don't let them drift.

---

## 1. Goals & non-negotiables

1. **Agent-agnostic algorithm core.** `core/` must not know what an "OpenClaw
   conversation turn" or a "Hermes Provider call" looks like. Adapters are the
   only place agent-specific concepts live.
2. **Source ↔ runtime separation.** Source code lives only inside this
   directory. User data + core config live only in the runtime home resolved
   through `core/config/paths.ts`, including DSH's `$DSH_HOME/memos-plugin/`.
3. **YAML is the only core config.** No `.env`. Sensitive fields (API keys,
   tokens) live in `config.yaml`; the OpenClaw/Hermes installer and config
   writer use owner-only permissions. DSH host knobs live in its Cordis YAML.
4. **Logs are first-class where the plugin owns logging.** Standalone and
   server-backed deployments use structured, channelled, rotating sinks.
   Embedded adapters leave logging to the host; DSH starts no MemOS file sink.
5. **Algorithm is the spec.** All math (γ, α, V, η, support, gain) is named the
   same in code, docs, and prompts as in the algorithm spec.
6. **Three adapters, one core.** OpenClaw and DeepSeek Harness use in-process
   TypeScript adapters that import `core/` directly. Hermes is Python, so it
   speaks JSON-RPC to the shared `bridge.cts`.
7. **Frontend is verifiable where mounted.** Server-backed adapters expose
   algorithm events in the viewer. `docs/FRONTEND-VALIDATION.md` documents the
   deterministic "say X → see Y" checks. DSH mounts the existing Viewer from
   the same process by default, on loopback port `18801`.

---

## 2. Layered architecture

```
                ┌────────────────────────────────────────────────┐
                │                  Agent host                    │
                │  (OpenClaw / DeepSeek Harness / Hermes / …)    │
                └────────────────┬─────────────┬─────────────────┘
                                 │             │
                  in-process     │             │     stdio / TCP JSON-RPC
                  TypeScript     ▼             ▼
                ┌──────────────────────┐   ┌──────────────────────┐
                │ adapters/openclaw/ + │   │ adapters/hermes/     │
                │ deepseek-harness/    │   │  - memos_provider    │
                │  - in-process hooks  │   │  - bridge_client     │
                │  - tools / lifecycle │   │  - daemon_manager    │
                └──────────┬───────────┘   └──────────┬───────────┘
                           │                          │
                           ▼                          ▼
                 ┌────────────────────────────────────────────┐
                 │           agent-contract/                  │
                 │  MemoryCore type · events · errors · DTO   │
                 │  jsonrpc methods · log records             │
                 └────────────────┬───────────────────────────┘
                                  │
                                  ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                            core/                             │
        │                                                              │
        │  pipeline/orchestrator + memory-core   ← single facade       │
        │      ├── session/        ├── capture/      ├── reward/       │
        │      ├── memory/l1/l2/l3 ├── episode/      ├── feedback/     │
        │      ├── skill/          ├── retrieval/    ├── hub/          │
        │      ├── telemetry/      └── update-check/                   │
        │                                                              │
        │  shared infra: storage · embedding · llm · logger · config   │
        └────────────┬───────────────────────────┬─────────────────────┘
                     │                           │
                     ▼                           ▼
            ┌──────────────────┐        ┌──────────────────┐
            │   server/ (HTTP) │        │   bridge.cts     │
            │   /api · /events │        │   JSON-RPC daemon │
            │   serves viewer/ │        │   used by Hermes  │
            │       dist       │        │                   │
            └────────┬─────────┘        └──────────────────┘
                     │
                     ▼
            ┌──────────────────────────┐
            │      viewer/             │
            │  Overview · Traces · …   │
            │  Logs · Settings · …     │
            └──────────────────────────┘
```

---

## 3. Module map

### 3.1 `agent-contract/`

The only thing that **both** core and adapters import. Zero runtime dependencies
so it can be replicated to any other language (e.g. Python types).

| File              | Purpose                                                       |
|-------------------|---------------------------------------------------------------|
| `memory-core.ts`  | The `MemoryCore` interface — the only public facade.          |
| `events.ts`       | All `CoreEventType` literals + type guard.                    |
| `errors.ts`       | Stable error codes + `MemosError` class.                      |
| `dto.ts`          | Plain data transfer types crossing the boundary.              |
| `jsonrpc.ts`      | JSON-RPC envelope types + canonical method names.             |
| `log-record.ts`   | The serializable shape of one log line (used by Python too).  |

### 3.2 `core/`

Every subdirectory has its own `README.md` describing intent, contracts, math,
edge cases, and observability. Top-level shared infra:

| Subdir         | Responsibility                                                                  |
|----------------|---------------------------------------------------------------------------------|
| `config/`      | Load + validate + write `config.yaml`; resolve agent-aware home paths.          |
| `logger/`      | Structured logging (channels, sinks, transports, redaction, rotation).          |
| `storage/`     | SQLite conn + schema + idempotent migrations + per-table repos + vector store. Files: `connection.ts`, `migrator.ts`, `vector.ts`, `repos/*.ts` (trace, policy, world, skill, episode, feedback, session, audit, kv, candidate-pool), plus `tx.ts` helpers. |
| `embedding/`   | `Embedder` facade + 6 providers (local MiniLM + openai-compat + gemini + cohere + voyage + mistral) + LRU cache. Files: `embedder.ts`, `cache.ts`, `normalize.ts`, `fetcher.ts`, `providers/*.ts`. |
| `llm/`         | `LlmClient` facade + 6 providers (openai-compat + anthropic + gemini + bedrock + host + local_only) + JSON-mode + SSE stream + `HostLlmBridge` fallback. Files: `client.ts`, `fetcher.ts`, `json-mode.ts`, `host-bridge.ts`, `providers/*.ts`, `prompts/*.ts`. |
| `id.ts`/`time.ts` | Tiny helpers used everywhere.                                                |

Algorithm modules:

| Subdir         | Responsibility                                                                  |
|----------------|---------------------------------------------------------------------------------|
| `session/`     | Session & episode lifecycle, intent classification, lifecycle event bus (consumed by orchestrator + viewer SSE). Files: `manager.ts`, `episode-manager.ts`, `intent-classifier.ts`, `heuristics.ts`, `events.ts`, `persistence.ts`. |
| `capture/`     | `episode.finalized` → L1 trace rows. Step extractor + normalizer + reflection extractor (adapter / regex / optional LLM synth) + α scorer (`REFLECTION_SCORE_PROMPT`) + embedder (vec_summary, vec_action) + persistence. Files: `capture.ts`, `subscriber.ts`, `step-extractor.ts`, `normalizer.ts`, `reflection-extractor.ts`, `reflection-synth.ts`, `alpha-scorer.ts`, `embedder.ts`. |
| `reward/`      | V7 §0.6 + §3.3: per-episode `R_human ∈ [-1,1]` via rubric LLM (three axes: goal / process / satisfaction) with heuristic fallback, reflection-weighted backprop `V_T=R_human`, `V_t=α_t·R+(1-α_t)·γ·V_{t+1}`, exponential time decay for `priority`. Files: `reward.ts`, `human-scorer.ts`, `backprop.ts`, `task-summary.ts`, `subscriber.ts`, `events.ts`. |
| `memory/l1/`   | L1 trace store + multi-modal search + priority.                                 |
| `memory/l2/`   | V7 §0.5.2 + §2.4.1: cross-task policy induction. Listens to `reward.updated`, then per episode: (a) associate high-V traces with existing policies via blended cosine + signature bonus + hard-gate, (b) drop unmatched traces into `l2_candidate_pool` keyed by `signature = primaryTag\|secondaryTag\|tool\|errCode`, (c) when a bucket has ≥ N distinct episodes call the `l2.induction` prompt (one trace per episode, char-capped) to mint a `candidate` policy, (d) recompute `gain = weightedMean(with) − mean(without)` + `status` (candidate → active → retired) with V7 §0.6 softmax weighting. Files: `l2.ts` (orchestrator), `associate.ts`, `candidate-pool.ts`, `induce.ts`, `gain.ts`, `similarity.ts`, `signature.ts`, `subscriber.ts`, `events.ts`, `types.ts`. |
| `memory/l3/`   | V7 §1.1 + §2.4.1: cross-task world-model induction. Listens to `l2.policy.induced`, then per run: (a) gather eligible active L2s (gain/support floors), (b) bucket by domain key + split by centroid cosine → compatible clusters, (c) per cluster, pack policies + one evidence trace each, call the `l3.abstraction` prompt (with JSON mode + validator) to produce an `(ℰ, ℐ, C)` draft, (d) merge into the nearest existing world model (cosine ≥ θ) or insert a new one, with per-cluster cooldown via `kv`. Confidence moves via `confidenceDelta` (merge or human thumbs). Files: `l3.ts` (orchestrator), `cluster.ts`, `abstract.ts`, `merge.ts`, `subscriber.ts`, `events.ts`, `types.ts`. |
| `episode/`     | Episode stitching across multiple turns.                                        |
| `feedback/`    | Classifier, revisor, decision-repair (preference / anti-pattern).               |
| `skill/`       | V7 §2.5: callable skill layer. Listens on `l2.policy.induced` / `l2.policy.updated (active)` / `reward.updated`, then per candidate policy: (a) eligibility check (support/gain/status/skill freshness), (b) evidence gather (value·cosine-scored L1 traces, char-capped), (c) `skill.crystallize` LLM draft + normalization, (d) heuristic `verifier` (command-token coverage + evidence resonance — no LLM), (e) `packager` → `SkillRow` with `invocationGuide`, `procedureJson`, embedded vector, η seeded from policy gain, (f) lifecycle governed by `applyFeedback` (Beta(1,1) posterior η, probationary→active/retired transitions at `probationaryTrials`, thumbs & reward drift). Files: `skill.ts` (orchestrator), `eligibility.ts`, `evidence.ts`, `crystallize.ts`, `verifier.ts`, `packager.ts`, `lifecycle.ts`, `subscriber.ts`, `events.ts`, `types.ts`. |
| `retrieval/`   | V7 §2.6: Tier-1 (skill), Tier-2 (trace+episode rollup with tag pre-filter), Tier-3 (world model). Query builder → three tiers → RRF fusion + MMR diversity ranker → `InjectionPacket`. Five entry points (`turnStart` / `toolDriven` / `skillInvoke` / `subAgent` / `repair`). Files: `retrieve.ts`, `query-builder.ts`, `tier1-skill.ts`, `tier2-trace.ts`, `tier3-world.ts`, `ranker.ts`, `injector.ts`, `events.ts`. |
| `pipeline/`    | Orchestrator (`onTurnStart`/`onTurnEnd`/`onFeedback`/`onShutdown`) + events bus + `MemoryCore` facade. |
| `hub/`         | Optional team sharing (server/client/auth/sync/users).                          |
| `telemetry/`   | Anonymized opt-out usage events.                                                |
| `update-check/`| Periodic check for newer npm versions.                                          |

### 3.3 `server/`

Thin HTTP/SSE shell over `MemoryCore`. Routes mirror the viewer's needs:

```
GET    /api/system          version, paths, health
GET    /api/config          read current resolved config (secrets redacted)
PATCH  /api/config          partial update, written back to config.yaml
GET    /api/memory/traces   list / search L1
GET    /api/memory/policies list / search L2
GET    /api/memory/world    list L3
GET    /api/skills          list + lifecycle
POST   /api/feedback        explicit user feedback
GET    /api/retrieval/preview run a tier1+2+3 retrieval against an arbitrary query
GET    /api/hub/*           team-sharing surface
GET    /api/logs/tail       channelled, paginated, with `?level=&channel=&limit=`
GET    /events              SSE: every CoreEvent + every log line (after redact)
```

### 3.4 `bridge.cts` + `bridge/`

A long-lived JSON-RPC server (stdio + TCP modes). Method names live in
`agent-contract/jsonrpc.ts`. Hermes' Python `bridge_client.py` is its only
heavyweight client today.

### 3.5 `adapters/openclaw/`

Standard OpenClaw plugin. Imports `core/` directly. Provides:

- `plugin.ts` — `definePluginEntry` wiring; passes config + paths into `createMemoryCore`.
- `tools.ts` — `memos_search`, `memos_get`, `memos_timeline` tool definitions.
- `hooks.ts` — `onConversationTurn`, `onShutdown`, etc.
- `host-llm-bridge.ts` — when `llm.fallback_to_host: true`, route LLM calls
  through the OpenClaw host's LLM rather than failing.
- `openclaw.plugin.json` — the host plugin manifest.

### 3.6 `adapters/deepseek-harness/`

Native Cordis plugin installed as an out-of-tree DSH bundle. It imports
`MemoryCore` directly and provides:

- `cordis.patch.yml` — bundle layer declared by `package.json`'s
  `dsh.bundle.patch` field.
- `index.ts` — Cordis configuration, DSH service injection, lifecycle hook
  registration, `DSH_HOME`-aware runtime bootstrap, same-process Viewer
  startup, and ordered disposal.
- `bridge.ts` — correlates DSH turns, assistant output, native/code-mode tools,
  and session disposal with `MemoryCore` DTOs. It deliberately does not
  register a `session/flush` hook, so DSH flushes never create a MemOS capture
  barrier.
- `host-llm.ts` — adapts MemOS completions to DSH's public streaming LLM
  service and isolates each turn's provider/model route with async-local state;
  credentials remain owned by DSH.
- `tools.ts` — six explicit `memos_*` tools using the same
  `agentPreset`-aware namespace as automatic recall and capture.

Every accepted, non-empty direct-user DSH turn performs one automatic recall.
Re-entry in the same logical turn is de-duplicated, but prior session history
does not suppress a new turn; greetings have no special case. Plugin and tool
messages do not trigger automatic recall. The model can additionally use the
explicit `memos_search` tool for a shorter, reformulated, or scoped lookup.

The DSH foreground boundary is retrieval and context assembly for the current
accepted query. The bridge returns the direct query before the source-labeled
`memos-local-memory` context, but other DSH context contributions may sit
between them. DSH still awaits `agent/pre-step` before it emits the canonical
user event, so the query can remain unrendered until its own bounded recall
completes; the adapter controls final message ordering, not host-side
optimistic rendering.

Turn routing (relation, intent, and episode) followed by capture runs in a
per-session serial background queue. Neither a later `agent/pre-step`,
`session/flush`, nor session disposal joins that queue. Session disposal only
marks the session closing and detaches its route; queued work is retained for
the later Cordis shutdown drain. Completed output becomes available to later
automatic recalls and memory-tool calls. The immediately following turn never
waits for that queue and can observe the older committed state if its own recall
or tool search runs too soon.

Automatic recall and explicit `memos_search` receive the same absolute core
deadline: `min(recallTimeoutMs, 3000)` ms. The default is 3,000 ms, and the
configuration may shorten but cannot extend this DSH foreground bound. DSH
retrieval filtering sets malformed-JSON retries to zero; a
malformed response, provider failure, or cancellable deadline abort returns the
mechanical `safeCutoff` when ranked candidates exist. Without candidates,
automatic recall injects nothing and explicit search returns an empty result.
The adapter's hard guard uses that same effective budget. If native work
cannot be cancelled immediately, automatic recall preserves the original
pre-step decision and `memos_search` returns an empty result marked
`timedOut: true`; the late work may still finish warming the shared cache.

This per-turn recall, deadline, and malformed-output policy is adapter-scoped.
OpenClaw and Hermes retain their existing foreground ordering, retrieval, and
retry behavior.

When `viewerEnabled` is true, the adapter starts the shared HTTP/SSE server
against its in-process core and serves the packaged Viewer on
`127.0.0.1:<viewerPort>` by default (`18801`). Cordis disposal stops new memory
work, closes the server, then attempts a bounded, best-effort drain of the
adapter bridge before shutting down the core. The DSH adapter opts into
active-SSE termination during server close so an open Viewer tab cannot consume
DSH's bounded disposal window; OpenClaw and Hermes retain their existing
default drain policy. The Viewer and plugin have no independent process and
exit with DSH. A transient
`EADDRINUSE` during a quick restart gets a finite background retry, so ordinary
one-`Ctrl+C` restart flows require no special wait or shutdown command. It
starts no JSON-RPC bridge or sidecar process. See its [installation and
lifecycle guide](./adapters/deepseek-harness/README.md).
Its config-aware prompt guidance omits disabled tool hints and treats recalled
context as untrusted historical data, not as instructions.
An empty MemOS `llm.provider` is resolved to this host bridge; an explicit
provider remains unchanged and can use the bridge as its configured fallback.

On normal `Ctrl+C`/`SIGINT` or `SIGTERM`, the bridge closes its intake before
the Viewer, queued work receives only the remaining bounded Cordis window, and
the in-process plugin and Viewer exit with DSH. A second signal, `SIGKILL`, a
process crash, terminal loss outside host disposal, or shutdown-budget expiry
can leave background work unfinished. Because DSH does not replay the original
`session/event` stream after restart and MemOS has no durable host receipt,
such a turn can remain uncaptured.

### 3.7 `adapters/hermes/`

Python package. Implements Hermes' `MemoryProvider` interface and proxies to
`bridge.cts`:

- `memos_provider/provider.py` — `MemoryProvider` impl.
- `memos_provider/bridge_client.py` — async JSON-RPC client.
- `memos_provider/daemon_manager.py` — start/stop/health-check the bridge.
- `memos_provider/config_loader.py` — read `~/.hermes/memos-plugin/config.yaml`.
- `memos_provider/log_forwarder.py` — forward Python-side logs back over the
  bridge so everything ends up in the same `logs/` directory.

### 3.8 `viewer/`

Vite app, served at runtime by `server/static.ts`. Ten views map 1:1 to the
algorithm's observable surface:

The well-known defaults are OpenClaw `18799`, Hermes `18800`, and DeepSeek
Harness `18801`. DSH defaults the Viewer to loopback and allows its port to be
overridden in the Cordis row; the shared core `viewer.bindHost` setting owns
the bind interface. The current DSH adapter supports local-machine Viewer use
only: it does not pass an HTTP API key to the server, so it accepts only
`localhost` or IPv4 `127.*` and rejects non-loopback binding.

| View         | Purpose                                                       |
|--------------|---------------------------------------------------------------|
| Overview     | Live KPIs + recent events                                     |
| Traces       | L1 list / detail (with V, α, R)                               |
| Policies     | L2 candidates → induced policies                              |
| WorldModel   | L3 abstractions                                               |
| Episodes     | Stitched task timelines                                       |
| Skills       | Crystallized skills + lifecycle                               |
| Retrieval    | Three-tier preview / debug panel                              |
| Hub          | Team-sharing dashboard                                        |
| Logs         | Channelled, level-filtered, real-time + tail                  |
| Settings     | Config editor (writes back to `config.yaml`)                  |

### 3.9 `templates/`

Plain files copied — never edited at runtime — by `install.sh`:

- `config.openclaw.yaml`
- `config.hermes.yaml`
- `README.user.md`

### 3.10 `docs/`

Developer-facing docs:

- `ALGORITHM.md` — the V7 spec, restated and indexed against the code.
- `DATA-MODEL.md` — every table, every column, every index.
- `EVENTS.md` — full event catalogue with payload shape.
- `PROMPTS.md` — prompt anatomy + evaluation samples.
- `BRIDGE-PROTOCOL.md` — JSON-RPC method list + error semantics.
- `ADAPTER-AUTHORING.md` — how to add a new agent adapter.
- `LOGGING.md` — channel taxonomy + redaction + retention.
- `FRONTEND-VALIDATION.md` — scripted "say X → expect Y" checklists.
- `RELEASE-PROCESS.md` — versioning + release-note workflow.

---

## 4. Data flow (one turn)

### 4.1 Golden rule: when do we retrieve?

The V7 spec is explicit about **injection timing, not quantity.** Translated
to this codebase, the composite row is the OpenClaw/Hermes path; DSH has an
explicit row because its ordering and lifecycle differ:

| Trigger                                      | Public adapter call / internal path                                      | Where it lands                            |
|----------------------------------------------|--------------------------------------------------------------------------|-------------------------------------------|
| OpenClaw/Hermes composite user turn arrives | `MemoryCore.onTurnStart` → `turnStartRetrieve` (normally Tier-1+2+3)      | Prepended as `memos_context` to this turn |
| DSH accepted, non-empty direct-user turn    | `MemoryCore.searchMemory({ reason: "turn_start" })` → `turnStartRetrieve` | Appended after the direct query; other DSH context may intervene |
| LLM asks for `memos_search`                  | `MemoryCore.searchMemory` → `toolDrivenRetrieve` (Tier-2 + optional Tier-3; no Tier-1) | Returned as the tool result |
| LLM asks for `memos_timeline`                | `MemoryCore.timeline` (ordered storage query; no embedding or ranking)   | Returned as the tool result               |
| LLM asks for `skill.<name>` directly         | `skillInvokeRetrieve` (named Tier-1 skill + corroborating Tier-2 traces) | Returned as the tool result (cached)      |
| SubAgent starts (`onSubAgentStart`)          | `subAgentRetrieve` (Tier-2 + optional Tier-3; no Tier-1)                  | Prepended to the sub-agent's first turn   |
| Decision-repair signal fires (see §4.3)      | `repairRetrieve` (targeted Tier-1+2 lookup; no Tier-3)                    | Prepended to the **next** LLM step        |

`lightweightMemory` narrows automatic, tool-driven, and sub-agent retrieval
to trace-only Tier-2. Turn-start scheduling can also gate tiers for the
classified scenario, so the table describes the normal full-memory plan.

We do **not** silently inject context on every `onToolCall` / `onToolResult`.
Those hooks are for observation only (failure counters, latency, event
logging); any "injection" they produce is deferred to one of the triggers
above — never mid-decision.

Adapters use the public `MemoryCore` facade rather than importing those
internal retrieval functions directly. The relevant facade methods include:

```ts
interface MemoryCore {
  onTurnStart(turn: TurnInputDTO): Promise<RetrievalResultDTO>;
  prepareTurn?(turn: TurnInputDTO): Promise<{ sessionId: SessionId; episodeId: EpisodeId }>;
  onTurnEnd(result: TurnResultDTO): Promise<{ traceId: string; episodeId: EpisodeId }>;
  searchMemory(query: RetrievalQueryDTO): Promise<RetrievalResultDTO>;
  timeline(input: { episodeId: EpisodeId; namespace?: RuntimeNamespace }): Promise<TraceDTO[]>;
  recordToolOutcome(outcome: ToolOutcomeDTO): void;
  // … plus listSkills, getSkill, feedback, and lifecycle methods.
}
```

DeepSeek Harness uses `searchMemory({ reason: "turn_start", ... })` for pure
prompt-time recall on every accepted, non-empty direct-user turn, with
same-turn de-duplication. It then invokes the optional `prepareTurn()`
capability in its background capture queue. Prior direct-user history does not
suppress recall for a new turn. Existing adapters continue to use the composite
`onTurnStart()` method and therefore retain their current ordering, waiting,
deadline, and malformed-output semantics.

The retrieval pipeline builds an internal `InjectionPacket`; the facade maps
it to the DTO contract, and adapters decide how to splice the result into
their host's prompt shape.

### 4.2 Happy path

The diagram below is specifically the OpenClaw/Hermes composite
`onTurnStart()` path. DeepSeek Harness does not follow its intent-before-recall
ordering: as described in §3.6, every accepted direct-user DSH turn awaits only
its own bounded retrieval/context assembly. DSH moves
relation/intent/episode routing followed by capture to the per-session
background queue, and the next turn never joins that earlier work.

```
agent.turn(input)
   └── adapter.onConversationTurn(input)
        └── core.pipeline.orchestrator.onTurnStart
              ├── session.manager.openOrContinue
              ├── session.relationClassifier + episode routing
              ├── session.intentClassifier (retrieve? skip chitchat?)
              ├── retrieval.turnStartRetrieve
              │     ├── tier1 (skills, top-K=3 by default)
              │     ├── tier2 (trace+episode, top-K=5)
              │     └── tier3 (world-model, top-K=2)
              └── returns InjectionPacket to adapter
   ─── agent.execute
         ├── (optional) tool call: memos_search
         │     └── core.searchMemory → toolDrivenRetrieve (tier2 + optional tier3; no tier1)
         ├── (optional) tool call: memos_timeline
         │     └── core.timeline (ordered trace query; no retrieval pipeline)
         ├── (optional) tool call: skill.<name>
         │     └── orchestrator.skillInvokeRetrieve (single skill, cached)
         └── (optional) onSubAgentStart → subAgentRetrieve
   └── adapter.onTurnEnd(turnResult)
        └── core.pipeline.orchestrator.onTurnEnd
              ├── session.manager.finalizeEpisode → emits `episode.finalized`
              ├── capture.subscriber (async) — Phase 6
              │     └── extract → normalize → reflect → α-score → embed → persist
              │           (traces written with V=priority=0 initially)
              └── capture.done → reward.subscriber (async) — Phase 7
                    ├── within feedback window: wait for explicit UserFeedback
                    └── timeout OR explicit.submit → reward.runner
                          ├── task-summary.build
                          ├── human-scorer (LLM rubric → axes → R_human)
                          ├── backprop (V_t, priority with decay)
                          ├── traces.updateScore + episodes.setRTask
                          └── emits `reward.updated`
   ─── user sends next turn / adapter.onFeedback(payload)
        └── feedback classifier → feedbackRepo.insert
              └── reward.subscriber.submitFeedback → runner.run (re-scores,
                   idempotent if already settled)
                   · downstream: memory.l2.crossTask (on `reward.updated`),
                     memory.l3.abstractor (on `l2.policy.induced`, debounced by cooldown),
                     skill.subscriber (on `l2.policy.induced` / `l2.policy.updated`
                       with status=active / `reward.updated` — runs crystallizer,
                       verifier, packager, and drives η via applySkillFeedback)
```

### 4.3 Decision-repair trigger (two-phase)

Decision repair must never block the in-flight LLM step; it always inserts
context **before the next one**.

```
onToolResult (success=false) ──▶ feedback.signals.bumpFailure(toolId)
                                 │
                                 ▼
                  threshold crossed? (≥3 same-tool fails in ≤5 steps, configurable)
                                 │
                 ┌───────────────┴───────────────┐
                 no                              yes
                  │                              │
                  ▼                              ▼
           record & return              feedback.decisionRepair.generate
                                           ├─ find similar high-V traces (preference)
                                           ├─ find similar low-V traces (anti-pattern)
                                           └─ emit `decision_repair.generated`
                                                     │
                          ┌──────────────────────────┘
                          │
                          ▼
              orchestrator.stashRepairPacket(sessionId, packet)
                          │
                          ▼
       on the NEXT adapter.onConversationTurn or onSubAgentStart:
       orchestrator merges stashed packet into InjectionPacket before LLM sees it.
```

The stash lives in memory only, keyed by session+conversation; if the user
abandons the session it's dropped. This is why `onToolCall`/`onToolResult` in
the OpenClaw SDK are sufficient without any SDK changes.

### 4.4 Observability

Every `└──` step emits one or more `CoreEventType` values. In deployments that
mount the MemOS logger and server, those events:

1. Get persisted to `logs/events.jsonl` (never deleted).
2. Get broadcast over `/events` SSE to the viewer.
3. Get summarized into `memos.log` at INFO level.

The DSH bundle persists memory state in SQLite and sends adapter lifecycle
messages to the DSH logger. With `viewerEnabled`, it also mounts the shared
HTTP/SSE Viewer transport over the same core. It still does not initialize the
MemOS file-log sinks.

---

## 5. Logging architecture

See `docs/LOGGING.md` for the full taxonomy. Highlights:

- `core/logger/` is **not** a single file. It's a directory exposing
  `rootLogger` plus a `child({ channel })` method.
- In deployments that mount MemOS file logging, business modules declare a
  channel and use `log.timer()` to record performance into `perf.jsonl`.
- In those deployments, LLM-call records go through the `llm-log` sink to
  `llm.jsonl` (model, tokens, latency, cost estimate, and prompt/completion
  redaction according to configuration).
- Audit-grade events (config change, hub join/leave, install/uninstall, skill
  retire) go to `audit.log`. Audit log retention is **永不删** — only gzip
  rotation by month.
- Redaction (`redact.ts`) runs before MemOS log and SSE sinks. This guarantee
  applies to observability output, not to memory records in `data/memos.db`,
  which can contain captured conversation and tool content and must be
  protected separately. The DSH adapter does not mount the MemOS file-log
  sinks; its optional SSE surface belongs to the same-process Viewer.

---

## 6. Testing strategy

| Tier         | Location              | Scope                                                              |
|--------------|-----------------------|--------------------------------------------------------------------|
| Unit         | `tests/unit/`         | One module at a time, in-memory + fakes.                           |
| Integration  | `tests/integration/`  | Multiple core modules + real SQLite in tmp dir.                    |
| End-to-end   | `tests/e2e/`          | Spin up bridge + server + (mocked) adapter; assert events / files. |

Common helpers:

- `tests/helpers/tmp-home.ts` — creates a throwaway `~/.<agent>/memos-plugin/`.
- `tests/helpers/fake-llm.ts` — deterministic LLM responses keyed by prompt id.
- `tests/helpers/fake-embedder.ts` — deterministic vectors.
- `tests/fixtures/*.json` — canonical traces / policies / episodes / feedbacks.

---

## 7. Release & versioning

- SemVer.
- `CHANGELOG.md` at the project root is hand-maintained per release.
- `core/update-check/` lets the running plugin notify users when a newer npm
  version is available.

---

## 8. Compatibility & migration

- Database migrations live in `core/storage/migrations/`. They're additive
  only (new tables / new columns / new indexes). Removals require a major
  version bump and an entry in `BREAKING` of the release note.
- The `agent-contract/` types are versioned with the package; non-breaking
  adapter compatibility within a minor is a hard requirement.

---

## 9. Open questions / future work

- Bigger-than-RAM vector index. Today: float32 BLOB columns + brute search,
  plenty fast at <100k vectors. When we cross that, swap `core/storage/vector.ts`
  to FAISS-style on-disk index.
- Multi-tenant isolation inside one process. Today: one `MemoryCore` = one
  user. The contract leaves room to add `userId` to every method.
