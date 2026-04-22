# docs/ — developer-facing documentation

For *user-facing* docs (getting started, configuration, viewer tour), see
[`site/content/docs/`](../site/content/docs/) instead.

## Document index

| File                          | What it covers                                          |
|-------------------------------|---------------------------------------------------------|
| `Reflect2Skill_算法设计核心.md` | Reflect2Evolve V7 算法规范（中文原版）。               |
| `ALGORITHM_ALIGNMENT.md`      | 算法 ↔ 实现的逐节对照表，标记 ✅/⚠️/❌。              |
| **`GRANULARITY-AND-MEMORY-LAYERS.md`** | **术语与粒度对齐：小步 / 轮 / 任务、经验 / 环境认知 / 技能 之间的关系，打分与检索的粒度选择。读其它文档前先看这一篇。** |
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
