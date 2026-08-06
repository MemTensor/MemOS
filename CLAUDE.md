# CLAUDE.md

## Claude Code Entry

Project facts live in `AGENTS.md`. This file only covers Claude Code runtime adaptation.

## Sub-agents

Five project-recommended sub-agents live under `.claude/agents/*.md`. Claude Code loads them automatically; the main agent should dispatch by task boundary:

| Agent | Permissions | When to use |
|-------|-------------|-------------|
| `explorer` | Read-only | Locate code, trace call chains, gather evidence |
| `design-reviewer` | Read-only | Review design docs (architecture / interface / performance / security / requirement coverage) |
| `code-reviewer` | Read-only | Review diffs and return APPROVE or CHANGES_REQUESTED |
| `backend-dev` | Read-write | Implement backend / library code under `src/memos/` (TDD) |
| `integration-tester` | Read-write | Author and run integration / end-to-end cases under `tests/` |

The main repo has no frontend stack, so no `frontend-dev` is provided; TypeScript sub-projects under `apps/` use their own AI configuration.

## Project knowledge

Before starting a task, run `ls docs/`. `docs/openapi.json` is the source of truth for the API contract; after touching `src/memos/api/`, run `make openapi` to regenerate it.
