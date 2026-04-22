# tests/

Three tiers, mirrored against the source layout.

| Tier         | Path                | Scope                                                              | Speed |
|--------------|---------------------|--------------------------------------------------------------------|-------|
| Unit         | `tests/unit/`       | One module at a time, fakes for I/O, LLM, embedder.                | <100ms each |
| Integration  | `tests/integration/`| Multiple core modules + real SQLite in `tmp-home`.                 | <2s each    |
| End-to-end   | `tests/e2e/`        | Spin up bridge + server (+ a mock adapter); assert events / files. | <10s each   |

## Helpers

- `tests/helpers/tmp-home.ts` — creates a throwaway runtime home directory and
  wires `core/config/paths.ts` to point at it. Cleaned up on test teardown.
- `tests/helpers/fake-llm.ts` — deterministic LLM fixtures keyed by prompt id.
- `tests/helpers/fake-embedder.ts` — deterministic vectors (hash-based).

## Fixtures

`tests/fixtures/*.json` holds canonical sample data:

- `traces.json`, `policies.json`, `episodes.json`, `feedback.json`
- `llm-responses.json` — a corpus of replayable LLM outputs

These are checked into the repo and never written to.

## Running

```bash
npm test                    # all
npm run test:unit           # unit only
npm run test:integration    # integration only
npm run test:e2e            # e2e only
npm run test:watch          # watch
```

## Conventions

- One test file per source file. Mirror the path:
  `core/skill/crystallizer.ts` → `tests/unit/skill/crystallizer.test.ts`.
- Never write to `os.homedir()` even transitively. Use `tmp-home`.
- Never call real LLMs or embedders. Use the fakes.
- If a test has to mock the clock, do it through `tests/helpers/clock.ts`
  (added when first needed) — keep mocks centralized.
