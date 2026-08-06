# RFC-001: L2 Induction Prompt — Business-Granularity Sub-Problems

| Field      | Value |
|------------|-------|
| **Status** | Draft (proposed 2026-04) |
| **Owner**  | _open — claim by editing this file_ |
| **Touches** | `core/llm/prompts/l2-induction.ts`, `core/memory/l2/induce.ts`, `tests/unit/memory/l2/induce.test.ts`, fixture LLM outputs in `tests/helpers/fake-llm.ts` |
| **Risk**   | Medium-high (changes the *shape* of every newly induced policy; existing rows untouched) |
| **Blocks** | Better L3 world-model quality; better Skill `domain_model` field |

---

## Background

The 2026-04 L3 cluster two-mode admission patch
(`core/memory/l3/cluster.ts`) made world-model formation robust to
loose clusters — even policies whose embeddings drift apart still seed
an L3 row when they share a domain key. **What it didn't fix is the
*content* of those policies.** Today, the LLM-induced L2 policies on
the TaskCLI demo corpus look like:

| `policy.title` | What it actually captures |
|---|---|
| "确认文件写入后用 ls 命令验证" | a generic "after `write`, run `ls`" meta-action |
| "用 python -m py_compile 验证语法" | a generic "after writing .py, compile-check" meta-action |
| "写入存储模块文件以实现统一接口" | a vague "write a file under storage/" meta-action |

These are real patterns the agent uses, but they're **operational
tics** rather than **business sub-problems**. The L3 abstraction over
them ends up describing "how the agent uses the shell" rather than
"what shape this Python project has".

What we'd rather have:

| `policy.title` (proposed) | Captures |
|---|---|
| "Add a new persistence backend in task-cli" | trigger = "user requests new file format support"; procedure = scaffold `<fmt>_store.py` with the canonical `load/save` signature; verification = round-trip + 3 pytest scenarios |
| "Add a new task-cli CLI subcommand" | trigger = "user requests new task verb"; procedure = `register(subparsers)` + `handler() -> int` with Chinese error prose; verification = `python -m task_cli.main <verb> --help` |
| "Pytest unit tests for a task-cli storage backend" | trigger = "implementation of a new storage backend just landed"; procedure = `tmp_path` fixture + 3 standard scenarios |

L3 over **these** would describe the project's architecture, not the
agent's shell habits.

---

## Hypothesis

The current `l2-induction` system prompt is too abstract about what a
"policy" is. It implicitly biases the LLM toward *action-level*
generalisations (the most-frequent verbatim repeat across episodes is a
shell action like `ls`, so the LLM picks up on those). We need to
explicitly require **business-level** sub-problems — sub-problems
phrased in terms of *what the user wanted*, not *what tool the agent
ran*.

---

## Proposed change

### 1. Prompt edits (`core/llm/prompts/l2-induction.ts`)

Add the following requirements to the system prompt (current prompt
will be left in place; this is an additive constraint block):

```
## Granularity rules — induce business-level sub-problems, not tool-level habits

A good L2 policy answers: "When the USER wants X (a sub-problem in
their domain), do this procedure to satisfy them."

A bad L2 policy answers: "After running tool A, the agent often runs
tool B" — that's operational behaviour, not user-facing knowledge.

Specifically:

- **trigger** must reference the user's intent or a project-level
  state, not a tool's output. Good: "user asks to add a new
  persistence format". Bad: "after `write` succeeds".
- **procedure** must describe a sequence of *user-visible artifacts*
  (created files, exposed interfaces, test scenarios), not a sequence
  of tool calls. Good: "create <fmt>_store.py with `load(path)/save(path,
  tasks)`; add tests/test_<fmt>_store.py covering 3 scenarios". Bad:
  "call write 3 times then call exec ls".
- **verification** must be checkable by the user, not by the agent.
  Good: "round-trip test passes". Bad: "py_compile returns 0".

If the only common pattern across the candidate traces is a tool-level
habit, return `{ "drafts": [], "reason": "no business-level pattern" }`
rather than inducing a meta-action policy. Tool-level habits will be
captured by `decision_guidance` via the feedback channel (V7 §2.4.6),
not by L2 directly.
```

### 2. Add a `domainHint` channel from the orchestrator

`core/memory/l2/induce.ts` should optionally pass the orchestrator's
current project / file context (e.g. "this episode worked on
`task-cli/storage/json_store.py`") so the LLM can phrase triggers /
procedures in terms of the project, not generic Python. This piggy-
backs on the `episode.meta` already populated by the OpenClaw
adapter.

### 3. Test fixture updates

- `tests/helpers/fake-llm.ts` — add a `l2InductionBusinessGranularity`
  scenario whose LLM mock returns business-level draft policies, plus
  a parallel `l2InductionToolHabit` scenario that returns the empty
  drafts + `reason` per the new constraint, so the runner's "skip
  empty drafts" path is exercised.
- `tests/unit/memory/l2/induce.test.ts` — replace the assertions that
  pin policy titles like "verify-after-write" with assertions on the
  business-level shape (triggers contain `user`/`项目`/`task-cli`,
  procedures reference `*.py` files, etc.).

### 4. Migration strategy for existing rows

**No DB migration.** Existing `policies` rows stay as-is; they continue
to drive existing world models and skills. As traces accumulate, the
new prompt will induce *new* policies in parallel. Operators who want
to clean up the old tool-level rows can manually `DELETE` them through
the viewer's policy archive UI — there is no automated retire because
"is this title business-level?" is too subjective to script.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| LLM ignores the new constraint and still emits tool-habit policies | Add a post-induce validator in `induce.ts` that rejects drafts where `procedure` matches a regex of obviously-shell-only verbs (`exec`, `run`, `bash`, `cd`, `ls`, `cat`, `grep` standalone). Reject → mark trace bucket as "needs human induction" rather than auto-induce a low-quality policy. |
| New prompt produces too few policies (LLM frequently returns "no business-level pattern") | Acceptable — V7 explicitly says "candidates wait for more episodes". Better to under-induce than to flood the catalog with tool-tics. |
| Existing demo / test data becomes incomparable (apples-to-oranges) | Run a labelled regression: pick 10 historical episodes, run BOTH old and new prompt, hand-grade the resulting policies for "business vs tool". Shipping requires the new prompt to win ≥ 7/10. |

---

## Acceptance criteria

1. `npm test -- tests/unit/memory/l2/induce.test.ts` passes with the
   updated fixtures.
2. On the TaskCLI demo (9 + 1 turns from `docs/DEMO_TaskCLI_OpenClaw_演示.md`),
   re-running the demo end-to-end yields ≥ 1 policy whose `title`
   includes the project name (`task-cli`) or a project artifact
   (`<fmt>_store.py`, `commands/<verb>.py`).
3. The L3 row that forms over those policies has at least one
   `environment` entry whose `label` is a path under
   `task-cli/`, **not** a generic Python concept.
4. Hand-grading regression: ≥ 7/10 historical episodes produce
   demonstrably "more business-flavoured" policies than the current
   prompt produces.

---

## Out of scope

- Changing the V7 trigger/procedure/verification/boundary schema of
  `PolicyRow` itself. The data model is fine; only the LLM-facing
  prompt needs to change.
- Retiring or rewriting historical policies. RFC-002 may follow up
  with a "policy quality refactor" pass once we have enough data on
  the new prompt's outputs.
- The L2 `domainHint` channel could be a separate, smaller PR if this
  RFC stalls — please split it out then.
