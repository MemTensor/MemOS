# core/session

Session & Episode management. Responsible for the boundary between the
outside world (one adapter ↔ one agent ↔ many users) and the algorithm
pipeline. Every LLM-side memory operation must attach to a known session
AND episode, which makes this module the authoritative source of truth
for "what conversation turn are we inside of?".

## 1. Concepts (matches V7 §3.1)

| Concept | Definition |
|---|---|
| **Session** | Long-lived logical connection to an agent. One per running agent process. Lives in `sessions` table. |
| **Episode** | Exactly **one** user query + its full agent response arc (tool calls, sub-agents). The atomic unit of reward + induction. Lives in `episodes` table. |
| **Turn**    | Individual message inside the episode (user / assistant / tool / system). Persists as traces in Phase 6; here we keep a slim in-memory copy. |

Every user query opens a fresh episode. Sub-agent hops do **not** open
new episodes — they add more turns to the parent episode. This matches
the V7 decision of "one reward signal per episode" while keeping
`trace_depth` as a per-trace attribute.

## 2. Public API

```ts
import { createSessionManager, createIntentClassifier,
         adaptSessionsRepo, adaptEpisodesRepo } from "@memos/core";

const intent = createIntentClassifier({ llm, timeoutMs: 5000 });
const sm = createSessionManager({
  sessionsRepo: adaptSessionsRepo(sqliteSessions),
  episodesRepo: adaptEpisodesRepo(sqliteEpisodes),
  intentClassifier: intent,
  idleCutoffMs: 24 * 60 * 60 * 1000,
});

const session = sm.openSession({ agent: "openclaw", meta: { hostPid: 1234 } });
const episode = await sm.startEpisode({ sessionId: session.id, userMessage: "fix the flaky test" });

sm.addTurn(episode.id, { role: "assistant", content: "Sure. Reading the log…" });
sm.addTurn(episode.id, { role: "tool", content: "<log output>", meta: { tool: "read_file" } });
sm.addTurn(episode.id, { role: "assistant", content: "Done. Patched `mutex_lock`." });

sm.finalizeEpisode(episode.id); // rTask scored later (Phase 7)
```

## 3. Event bus

```ts
sm.bus.on("episode.started", (e) => console.log(e.episode.id));
sm.bus.onAny((e) => console.log(e.kind));
```

Events are:

- `session.started` / `session.closed` / `session.idle_pruned`
- `episode.started` / `episode.turn_added` / `episode.finalized` (with
  `closedBy: "finalized" | "abandoned"`) / `episode.abandoned`

Listener exceptions are caught and logged on `core.session`. Never break
ordering; delivery is synchronous.

The Phase 15 pipeline subscribes to `episode.finalized` to trigger:

```
capture.extract → reflection → reward.R_human → backprop → l2.incremental
                                                              ↓
                                                   skill.maybe_crystallize
```

The viewer subscribes to `onAny` for live SSE streaming.

## 4. Intent classifier

```
user message
    ▼
  heuristic rules (heuristics.ts)
    │
    ├─ strong match (conf ≥ 0.85) ─→ DONE
    │
    ├─ weak match                  ─→ LLM (if available) — fall back to weak match on failure
    │
    └─ no match                    ─→ LLM (if available) — fall back to "unknown" (= full retrieval)
```

Five canonical kinds:

| Kind            | Retrieval fired    | Typical examples                                  |
|-----------------|--------------------|---------------------------------------------------|
| `task`          | Tier 1 + 2 + 3     | "fix this bug", "帮我改这个函数", "write a blog"  |
| `memory_probe`  | Tier 1 + 2         | "what did we discuss last time", "你还记得…"      |
| `chitchat`      | (none)             | "thanks", "ok", "你好"                            |
| `meta`          | (none; adapter)    | "/memos status", "/memory export"                 |
| `unknown`       | Tier 1 + 2 + 3     | Defaults to full retrieval on ambiguity.           |

The LLM tiebreaker uses `LlmClient.completeJson` with a small schema hint.
Model failures never prevent a session from proceeding — they just
downgrade to the heuristic fallback.

## 5. Storage

- `SessionRepo` / `EpisodesRepo` (defined in `persistence.ts`) are the
  thin interfaces this module depends on.
- `adaptSessionsRepo` / `adaptEpisodesRepo` bridge the raw SQLite
  repositories in `core/storage/repos/`.
- Tests inject in-memory fakes that implement these interfaces without
  spinning up a real DB.

Write pattern:

- `openSession`         → INSERT sessions if missing; no-op otherwise.
- `startEpisode`        → INSERT episodes (status='open') + `sessions.touch`.
- `addTurn`             → in-memory only. Turn-level persistence is
                          Phase 6's job (traces).
- `finalize` / `abandon`→ UPDATE episodes (status='closed', ended_at,
                          rTask, meta.closeReason).
- `attachTraceIds`      → UPDATE episodes.trace_ids_json. Called by
                          Phase 6 after writing L1 rows.

All writes are synchronous SQLite calls. The hot path (new turn) doesn't
touch SQLite beyond `sessions.touch`.

## 6. Context propagation

`startEpisode` wraps its body in `withCtx({ sessionId, episodeId }, fn)`
so downstream `log.info(...)` calls automatically carry the correlation
ids. Same pattern is used by the orchestrator / LLM layer — no
`log.child({ sessionId })` boilerplate required.

## 7. Errors

| Code                   | When                                                 |
|------------------------|------------------------------------------------------|
| `session_not_found`    | `startEpisode` on unknown session.                   |
| `episode_not_found`    | `addTurn`/`finalize`/`abandon` on unknown episode.   |
| `conflict`             | `addTurn` on a closed episode.                       |
| `invalid_argument`     | `startEpisode` with empty user message.              |
| `internal`             | DB returned no row immediately after upsert.         |
| `llm_timeout`          | Intent classifier LLM exceeded `timeoutMs`.          |
| `llm_output_malformed` | Intent classifier LLM returned non-conforming JSON.  |

## 8. Logging channels

- `core.session` — session.opened / closed / pruned / shutdown events
- `core.session.intent` — heuristic matches, LLM verdicts, failures
- `core.episode` — episode.begun / turn_added (debug) / finalized / abandoned

## 9. Testing

Under `tests/unit/session/`:

- `heuristics.test.ts` — rule matching for each canonical label.
- `intent-classifier.test.ts` — strong heuristic, LLM tiebreak,
  LLM failure → fallback, empty message, timeout.
- `events.test.ts` — on / onAny / listenerCount; listener throws are isolated.
- `episode-manager.test.ts` — start/addTurn/finalize/abandon lifecycle,
  closed-episode guards, trace id attachment, event emission order.
- `session-manager.test.ts` — openSession idempotence, startEpisode,
  pruneIdle, shutdown cleanup, open-episode count.

## 10. Caveats

- **No per-session concurrency.** We assume one agent process writes at a
  time. If you need parallel agents, open distinct session ids.
- **Turn ids are ephemeral.** They're stable only within the in-memory
  snapshot. Phase 6 mints stable trace ids (`tr_…`) for the ones that
  get promoted to L1.
- **Intent LLM is fire-and-forget from a config POV.** We respect
  `llm.provider=local_only` by passing `disableLlm=true` so classifier
  never attempts a network call that will definitely fail.
