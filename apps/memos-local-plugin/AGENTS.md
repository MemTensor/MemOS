# AGENTS.md — coding rules for this package

> Read this **first** before editing any file in `apps/memos-local-plugin/`.
> If the rules disagree with `ARCHITECTURE.md`, `ARCHITECTURE.md` wins.
> If you change the rules, update both files in the same commit.

---

## 0. Mental model

- `core/` is **agent-agnostic**. It does not know what an "OpenClaw turn" is.
- `adapters/<agent>/` is the only place agent-specific concepts live.
- `agent-contract/` is the only thing both sides import.
- User data + config live under `~/.<agent>/memos-plugin/`. Source code lives
  here. **Never blur that line.**

---

## 1. Non-negotiables

1. **Source ↔ runtime separation.**
   No file under `apps/memos-local-plugin/` may write to `~/.openclaw/`,
   `~/.hermes/`, or any user home path. Resolve those exclusively through
   `core/config/paths.ts`.

2. **YAML is the only config.**
   No `.env`, no `process.env.*` reads outside `core/config/`. Sensitive
   fields (API keys, tokens) live in `config.yaml` (`chmod 600`).

3. **Logger first, console second.**
   Never call `console.log` outside of `scripts/` and `bridge.cts` startup.
   Always call `rootLogger.child({ channel: "<area>" }).info|debug|…`.

4. **Every module ships with a README.**
   When you create a new directory under `core/`, `server/`, `bridge/`,
   `adapters/`, `web/`, or `site/`, add a `README.md` describing intent,
   contracts, math (if any), edge cases, observability hooks.

5. **Every module ships with tests.**
   Same name, mirrored in `tests/unit/<path>/<file>.test.ts`. If it touches
   multiple modules, add an `tests/integration/` test too.

6. **No hidden TODOs.**
   `// TODO`s are fine; orphan TODOs are not. Track them in
   `docs/RELEASE-PROCESS.md` or in the next release note.

7. **No dead code.**
   Old code from the legacy projects (`memos-local-openclaw`,
   `memos-local-hermes`) is **reference only** — read for inspiration, do not
   copy verbatim into this package.

8. **Every published version needs a release note.**
   `site/content/releases/<version>.md`. Enforced by `npm run release:check`.

---

## 2. Module-completion checklist

Before marking a Phase done, every new module must satisfy:

- [ ] `README.md` explains intent, public API, internal algorithm, edge cases,
      observability hooks, and a small "how to test manually".
- [ ] All exports go through the module's `index.ts`.
- [ ] Channel name registered in `docs/LOGGING.md`.
- [ ] Tests in `tests/unit/<path>/` cover happy path + at least 2 failure modes.
- [ ] If it persists data: a migration entry in `core/storage/migrations/`.
- [ ] If it emits events: types added in `agent-contract/events.ts` and
      documented in `docs/EVENTS.md`.
- [ ] If it surfaces in the viewer: an SSE event flow + a `web/src/views/` hook.
- [ ] Linter clean: `npm run lint` passes.

---

## 3. Logging style

- Always declare a channel:
  ```ts
  const log = rootLogger.child({ channel: "core.l2.cross-task" });
  log.info("induce.start", { episodes: ids.length });
  ```
- Channel naming: `<area>.<sub>.<verb-or-noun>`, e.g.
  `core.skill.crystallize`, `llm.openai`, `hub.sync`, `adapter.openclaw`.
- Use `log.timer("operation")` (returns `using`-disposable) around any
  non-trivial async operation; it auto-logs to `perf.jsonl`.
- Errors: `log.error("did_not_X", { err, …context })`. Pass the `Error`
  object as `err`, not as `err.message`.
- Audit-worthy events (config change, hub join, install/uninstall, skill
  retire): use `log.audit("…", payload)` — never the regular sinks.

---

## 4. TypeScript style

- ES modules everywhere. `"type": "module"` in `package.json`.
- Use `node:` prefixes (`import { readFile } from "node:fs/promises"`).
- Prefer `unknown` over `any`. Narrow with type guards from `@sinclair/typebox`.
- Prefer `Result<T, E>`-style returns at module boundaries; throw `MemosError`
  with a stable code from `agent-contract/errors.ts` only when callers can't
  reasonably continue.
- All time values are millisecond `number` (UTC epoch). All durations are
  `number` (ms). No `Date` on the wire.

---

## 5. Python style (Hermes adapter only)

- Python 3.11+.
- `pyproject.toml` only — no `requirements.txt`.
- Use `asyncio` + `aiohttp` for the bridge client; `pyyaml` for config; no
  other heavyweight deps.
- Logs go through `log_forwarder.py` so they end up in the same `logs/`.

---

## 6. Tests

- `vitest`, run via `npm test`.
- Use `tests/helpers/tmp-home.ts` for any test that needs a config / data dir.
- Use `tests/helpers/fake-llm.ts` and `fake-embedder.ts` to keep tests
  deterministic and offline.
- Never write to `os.homedir()` in tests, even transitively.

---

## 7. Doc map

| Question                                | File                                  |
|-----------------------------------------|---------------------------------------|
| What does the system look like?         | `ARCHITECTURE.md`                     |
| What's the algorithm?                   | `docs/ALGORITHM.md`                   |
| Which events fire and when?             | `docs/EVENTS.md`                      |
| What's in SQLite?                       | `docs/DATA-MODEL.md`                  |
| How do I add a new agent adapter?       | `docs/ADAPTER-AUTHORING.md`           |
| What's the JSON-RPC method list?        | `docs/BRIDGE-PROTOCOL.md`             |
| How do I write a prompt?                | `docs/PROMPTS.md`                     |
| What's logged where?                    | `docs/LOGGING.md`                     |
| How do I verify the loop in the viewer? | `docs/FRONTEND-VALIDATION.md`         |
| How do I cut a release?                 | `docs/RELEASE-PROCESS.md`             |
| What's the user-facing config?          | `site/content/docs/configuration.md`  |
