# CLAUDE.md

This file provides guidance to AI coding harnesses (Claude Code, Codex, Cursor,
OpenHands, and similar agentic tools) when working in this repository. Human
contributors should read [CONTRIBUTING.md](./CONTRIBUTING.md) first — this file
restates the rules in the shape an agent needs, and adds harness-specific
guardrails.

If you are a non-Claude agent that loads `AGENTS.md` by convention, see the
`AGENTS.md` at the repo root — it points back here.

---

## 1. Project Overview

**MemOS (MemoryOS)** is a Memory Operating System for LLMs and AI agents. It
unifies **store / retrieve / manage** for long-term memory and supports
plaintext, activation, and parametric memory across multiple backends.

- Language: **Python ≥ 3.10** (CI tests 3.10 – 3.13)
- Package manager: **Poetry ≥ 2.0** (lockfile committed: `poetry.lock`)
- Distribution name on PyPI: `MemoryOS`
- Import name: `memos` (e.g. `from memos import ...`)
- License: Apache-2.0
- Public docs: <https://memos-docs.openmem.net/>

### Repository layout (top level)

```
src/memos/        # Core package (the thing PyPI ships)
packages/         # Adjacent sub-packages (memos-core, memos-schema, adapter-base)
apps/             # Standalone apps & plugins (Electron, OpenClaw, Hermes…)
tests/            # pytest suite; mirrors src/memos layout
examples/         # Runnable example scripts grouped by module
evaluation/       # Benchmark harness (LoCoMo, LongMemEval, PrefEval, PersonaMem)
docs/             # Generated OpenAPI + bilingual docs (cn / en)
docker/           # Dockerfile(s) and docker-compose for local backends
deploy/helm/      # Helm chart for k8s deployment
scripts/          # One-off maintenance scripts
.github/          # Issue / PR templates and workflows
```

### Key modules inside `src/memos/`

`api/`, `mem_os/`, `mem_cube/`, `mem_reader/`, `mem_scheduler/`, `mem_chat/`,
`mem_agent/`, `mem_user/`, `mem_feedback/`, `mem_tools/`, `memories/`,
`llms/`, `embedders/`, `vec_dbs/`, `graph_dbs/`, `reranker/`, `chunkers/`,
`parsers/`, `search/`, `templates/`, `configs/`, `context/`, `dream/`,
`plugins/`, `extras/`, `multi_mem_cube/`, plus `cli.py`, `log.py`,
`settings.py`, `utils.py`, `dependency.py`, `deprecation.py`, `exceptions.py`.

---

## 2. Common Commands

All commands run from the repo root. The canonical entry point is the
`Makefile`; prefer it over invoking `poetry run …` directly.

| Command                  | What it does                                                       |
| ------------------------ | ------------------------------------------------------------------ |
| `make install`           | `poetry install --extras all --with dev --with test` + pre-commit  |
| `make test`              | Run the full pytest suite (`tests/`)                               |
| `make test-cov`          | Tests + coverage report (`cov-report/`)                            |
| `make test-report`       | Tests + HTML test report + coverage                                |
| `make format`            | `ruff check --fix` then `ruff format`                              |
| `make pre_commit`        | Run **all** pre-commit hooks against the whole repo                |
| `make serve`             | Launch the API: `uvicorn memos.api.server_api:app`                 |
| `make openapi`           | Regenerate `docs/openapi.json`                                     |
| `make clean`             | Remove `.memos/`, caches, coverage artefacts                       |

Targeted pytest invocations:

```bash
poetry run pytest tests/test_hello_world.py          # single file
poetry run pytest tests/mem_cube -k "naming"          # filter
poetry run pytest tests/test_cli.py::test_main       # single test
```

---

## 3. Development Workflow (harness edition)

The human flow is in [CONTRIBUTING.md §Development Workflow](./CONTRIBUTING.md).
What an agent must do on top:

1. **Branch off the right base.** The default human base is `dev`. Automated
   pipelines (GitHub AutoDev, release scripts) may target a release branch
   such as `v2.0.x` — respect the base branch the scheduler picked, do not
   silently retarget.
2. **One logical change per branch.** If the issue grew, split the work; do
   not bundle unrelated fixes into the same commit.
3. **Run the local gates before pushing**, in this order:
   1. `make format`        (auto-fix ruff issues)
   2. `make pre_commit`    (full hook suite — ruff, ruff-format, yaml/json/toml
      checks, no-implicit-optional, poetry-check, …)
   3. `make test`          (or a focused subset if the change is scoped)
4. **Never bypass hooks.** Do not pass `--no-verify`, `--no-gpg-sign`,
   `SKIP=…`, or otherwise disable pre-commit. If a hook fails, fix the
   underlying issue, re-stage, and create a new commit.
5. **Never amend a commit.** Always add a new commit on top — agents that
   amend after a failed hook risk destroying earlier work.
6. **Do not edit `poetry.lock` by hand.** Let `poetry-lock` regenerate it
   when `pyproject.toml` changes; commit the regenerated file alongside the
   manifest change.
7. **Do not commit generated artefacts** (`cov-report/`, `report/`, `.memos/`,
   `tmp/`, `.coverage*`, `*.egg-info`). They are already in `.gitignore`;
   leave them there.
8. **Secrets stay out of the repo.** Never commit `.env`, API keys, dataset
   credentials, or anything matching `*token*`, `*secret*`, `*key*` unless
   the file is an explicit non-sensitive sample.

---

## 4. Commit & PR Conventions

We follow **Conventional Commits**. Title format: `<type>: <imperative summary>`.

| Type       | When to use                                          |
| ---------- | ---------------------------------------------------- |
| `feat`     | New user-visible capability                          |
| `fix`      | Bug fix                                              |
| `docs`     | Docs-only change                                     |
| `style`    | Formatting / whitespace only                         |
| `refactor` | Restructuring without behaviour change               |
| `test`     | Adding or updating tests                             |
| `perf`     | Performance improvement                              |
| `chore`    | Build tooling, deps, housekeeping                    |
| `ci`       | CI / workflow changes                                |

Rules of thumb:

- Subject line ≤ 72 chars, imperative mood, no trailing period.
- Body explains **why**, not what — the diff already shows what.
- Reference issues with `Closes #1234` / `Refs #1234` in the footer.
- For agent-authored commits, keep the trailer that identifies the agent
  (`Co-Authored-By: …`) intact — reviewers rely on it.
- Open PRs against the base branch the issue / scheduler indicated
  (`dev` for community PRs). PRs against `main` will be asked to retarget.

PR description must include:

- A 1–3 bullet **Summary** of what changed and why.
- A **Test plan** checklist (commands run, manual steps, screenshots if UI).
- Issue links.

---

## 5. Code Conventions

### Style & lint

- Ruff is the single source of truth — config lives in `pyproject.toml` under
  `[tool.ruff]`. Line length **100**, target **py310**.
- Enabled lint groups: `B`, `C4`, `ERA`, `I` (isort), `N`, `PIE`, `PGH`,
  `RUF`, `SIM`, `TC`, `TID`, `UP`. Suppressions: `RUF001`, `PGH003`.
- Import order is managed by ruff’s isort plugin: 1 blank line between import
  type blocks, 2 blank lines after the import block.
- Do **not** introduce new lint warnings. If a rule must be suppressed, do it
  per-line with a justification comment, not a blanket file-level ignore.

### Typing

- Public APIs need type hints. Prefer `from __future__ import annotations` in
  new modules to allow forward refs.
- No implicit `Optional` — the `no_implicit_optional` pre-commit hook enforces
  PEP 484: write `x: int | None = None`, never `x: int = None`.
- Use `typing.TYPE_CHECKING` for import cycles and heavy optional deps.

### Docstrings

- All public functions, classes, and modules get docstrings.
- One-line summary first, blank line, then details. Use the same style as
  surrounding code (Google-style is most common in the repo).
- `check-docstring-first` is a pre-commit hook — keep the module docstring
  at the very top.

### Errors & logging

- Raise from `memos.exceptions` where a fitting class already exists; add a
  new subclass rather than raising bare `Exception`.
- Use `memos.log` (or a module-local `logger = logging.getLogger(__name__)`)
  rather than `print`. `debug-statements` is a pre-commit hook — no
  `breakpoint()` / `pdb.set_trace()` in committed code.

### Architecture rules of thumb

- `src/memos/api/` is the HTTP/MCP surface. Business logic belongs in the
  feature modules (`mem_cube/`, `mem_reader/`, …), not in routers.
- Storage backends live behind the abstractions in `vec_dbs/`, `graph_dbs/`,
  `memories/`. Don’t reach into a backend client (qdrant, neo4j, milvus,
  redis…) from feature modules.
- LLM / embedder calls go through `memos.llms` / `memos.embedders`. Don’t
  instantiate provider SDKs directly from feature code.
- Optional extras are declared in `pyproject.toml` under
  `[project.optional-dependencies]`. If you add a dependency, slot it into
  the right extras group (`tree-mem`, `mem-scheduler`, `mem-user`,
  `mem-reader`, `pref-mem`, `skill-mem`, `tavily`) and mirror it into the
  `all` group when appropriate.

---

## 6. Testing

`pytest` with `pytest-asyncio` (`asyncio_mode = "auto"`). `pythonpath = "src"`.

- Tests live under `tests/`, mirroring `src/memos/`. New module → new test
  file. New backend → new test directory.
- New features ship with tests for the happy path + the key edge cases.
- Bug fixes ship with a regression test that fails on `HEAD~1` and passes
  on `HEAD`.
- Prefer fixtures and fakes over real network / database calls. If a test
  needs a real backend, mark it (e.g. `@pytest.mark.integration`) so it can
  be filtered out by default.
- Coverage is tracked for `src/memos`. New code should not regress coverage
  on the modules it touches.

---

## 7. Documentation

- User-facing docs live in a separate repo: <https://github.com/MemTensor/MemOS-Docs>.
- Code-adjacent docs in this repo:
  - `README.md` (project pitch + quickstart)
  - `CONTRIBUTING.md` (human contributor flow)
  - `CLAUDE.md` (this file — agent harness flow)
  - `AGENTS.md` (alias for non-Claude harnesses)
  - `docs/openapi.json` (regenerated via `make openapi`)
  - `docs/cn` / `docs/en` (bilingual deep-dives)
- Public API changes must:
  1. Regenerate the OpenAPI spec (`make openapi`) if HTTP routes changed.
  2. Update the relevant docstring.
  3. Mention the change in the PR description, with a note if the
     MemOS-Docs repo needs a follow-up PR.

---

## 8. Tool-use guardrails for harnesses

These rules apply to **agentic tools** specifically. Skip if you’re a human.

- **Read before you write.** Before editing a file, read enough surrounding
  context to keep style consistent.
- **Prefer Edit over Write.** Only use full-file writes for genuinely new
  files. Mass rewrites of existing files defeat review.
- **No new files unless needed.** Don’t create a `NOTES.md`, a scratch
  script, or a duplicate config to “organize” your work. Keep the diff
  focused.
- **No emoji in code unless asked.** Comments, docstrings, identifiers, and
  log lines should stay ASCII unless the surrounding code already uses
  emoji.
- **Stay in scope.** If the issue says "add X", do not also reformat
  unrelated files, rename modules, or upgrade dependencies. Open a separate
  issue for drive-by improvements.
- **Be honest about uncertainty.** If you can’t run the test suite, say so
  in the PR description rather than claiming the change is verified.
- **Don’t push to `main` or release branches.** Push to the working branch
  the scheduler created (`autodev/*`, `feat/*`, `fix/*`, …) and let the
  scheduler / a maintainer open the PR against the correct base.

---

## 9. Environment & Backends

Local development needs at minimum:

- Python 3.10+ and Poetry
- One textual memory backend — `tree_text` (Neo4j + Qdrant) is the
  recommended default
- A `.env` file with provider API keys (see CONTRIBUTING.md §Configure .env)

Docker compose is provided under `docker/` for Neo4j and friends. Helm
charts for k8s deployment live under `deploy/helm/`.

---

## 10. When in doubt

1. Re-read this file and `CONTRIBUTING.md`.
2. Read the closest test file — the test fixtures usually reveal the
   intended usage.
3. Open a GitHub Discussion or comment on the issue rather than guessing
   on an architectural decision.
4. For agent-authored PRs that need human input, set the PR status to
   **Draft** and `@`-mention the reviewers configured by the scheduler.
