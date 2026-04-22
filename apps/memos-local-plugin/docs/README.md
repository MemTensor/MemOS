# docs/ — developer-facing documentation

For *user-facing* docs (getting started, configuration, viewer tour), see
[`site/content/docs/`](../site/content/docs/) instead.

## Document index

| File                          | What it covers                                          |
|-------------------------------|---------------------------------------------------------|
| `ALGORITHM.md`                | The Reflect2Evolve V7 spec, indexed against the code.   |
| `DATA-MODEL.md`               | Every SQLite table, column, and index.                  |
| `EVENTS.md`                   | Every `CoreEventType`, when it fires, payload shape.    |
| `PROMPTS.md`                  | Prompt anatomy, evaluation samples, golden outputs.     |
| `BRIDGE-PROTOCOL.md`          | JSON-RPC method list, error semantics, stdio + TCP.     |
| `ADAPTER-AUTHORING.md`        | How to wire a new agent against `agent-contract/`.      |
| `LOGGING.md`                  | Channel taxonomy, redaction, retention, dashboards.     |
| `FRONTEND-VALIDATION.md`      | Scripted "say X to the agent → expect Y in viewer".     |
| `RELEASE-PROCESS.md`          | Versioning, release notes, CI gates.                    |

These files are filled in over Phases 1–25; until each phase lands, you'll
find a short stub explaining what will go there.
