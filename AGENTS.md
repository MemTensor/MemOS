# AGENTS.md

> Single source of truth for the project across AI runtimes. Claude Code, Codex, Cursor, Copilot, etc. all defer to this file.
> Runtime-specific adaptation belongs in each runtime's own file (Claude reads `CLAUDE.md`); do not mix it in here.

## Project Overview

**MemOS / MemoryOS**: a memory operating system for LLM agents. Python library plus a FastAPI service, providing multiple memory types (textual / tree / preference / skill / KV cache / LoRA parametric) plus scheduling, version management, and vector & graph storage.

- **Repository**: https://github.com/MemTensor/MemOS
- **Documentation**: https://memos-docs.openmem.net/home/overview/
- **PyPI**: https://pypi.org/project/MemoryOS/
- **License**: Apache-2.0
- **Top-level package**: `src/memos/`. Distribution name `MemoryOS`; import name `memos`.
- **CLI**: `memos` (entry `memos.cli:main`)
- **API service**: `memos.api.start_api:app`

## Repository Layout

| Path | Purpose |
|------|---------|
| `src/memos/mem_os/` | `MOS` / `MOSCore` — top-level Memory OS entry |
| `src/memos/mem_cube/` | `GeneralMemCube` — memory container aggregating multiple memory types |
| `src/memos/memories/` | Memory implementations: `textual/`, `activation/`, `parametric/` |
| `src/memos/mem_scheduler/` | Memory scheduler + monitors + ORM + task scheduling |
| `src/memos/mem_user/` | User / multi-tenant management (MySQL / Redis backends) |
| `src/memos/mem_chat/` `mem_reader/` `mem_agent/` `mem_feedback/` `multi_mem_cube/` | Chat sessions, ingest pipeline, agent integration, feedback channel, multi-cube routing |
| `src/memos/llms/` `embedders/` `vec_dbs/` `graph_dbs/` `chunkers/` `parsers/` `reranker/` | Provider implementations (`base.py` + `factory.py` + each backend) |
| `src/memos/api/` | FastAPI service (routers / handlers / middleware / MCP server) |
| `src/memos/configs/` | All pydantic configuration classes (one-to-one with the modules above) |
| `src/memos/context/` | Cross-thread context (trace_id / user / env) |
| `tests/` | pytest cases, subdirectories mirror `src/memos/` |
| `apps/` | Independent sub-projects, each with its own README; not part of the main Harness flow |
| `extensions/` | Official plugin examples |
| `docker/` `docs/` `evaluation/` `scripts/` | Deployment, documentation, evaluation, helper scripts |
| `.claude/agents/`, `.codex/agents/` | Project-recommended AI sub-agent definitions |

## Command Cheatsheet

- Install: `make install` (= `poetry install --extras all --with dev --with test` + pre-commit + push hook)
- Start API: `make serve`
- Export OpenAPI: `make openapi` (writes to `docs/openapi.json`)
- Run full tests: `make test`
- Run a single test: `poetry run pytest tests/<path>/test_xxx.py -q`
- Lint + format: `make format`
- Full pre-commit: `make pre_commit`
- Build: `poetry build` (publishing is automated by `python-release.yml` on GitHub release)

## Core API

### Python top-level entries (`from memos import ...`)

| Symbol | Purpose | Source |
|--------|---------|--------|
| `MOS` | Memory OS top-level entry (inherits `MOSCore`) | `memos.mem_os.main` |
| `GeneralMemCube` | General memory container | `memos.mem_cube.general` |
| `MOSConfig` / `GeneralMemCubeConfig` | Primary configs | `memos.configs.mem_os` / `memos.configs.mem_cube` |
| `GeneralScheduler` / `SchedulerFactory` / `SchedulerConfigFactory` | Scheduler and factories | `memos.mem_scheduler.*` |

Common `MOS` methods: `MOS.simple()` (auto-configure from env), `register_mem_cube(cube)`, `add(...)`, `search(...)`, `chat(...)`, `create_user(...)` / `list_users()`.

### API entry

- ASGI app: `memos.api.start_api:app`
- Routers: `src/memos/api/routers/` (`admin_router`, `product_router`, `server_router`)
- OpenAPI contract: `docs/openapi.json` (must run `make openapi` after touching the API)

## Import Patterns

| Use | Import |
|-----|--------|
| Top-level entries | `from memos import MOS, GeneralMemCube, MOSConfig` |
| Config classes | `from memos.configs.<submodule> import <Config>` |
| Any provider factory | `from memos.<category>.factory import <Category>Factory` |
| Logger | `from memos.log import get_logger`; `logger = get_logger(__name__)` |
| Context (trace) | `from memos.context.context import get_current_trace_id, get_current_user_name` |
| Exceptions | `from memos.exceptions import <semantic Exception>` |

## Provider Matrix

Every provider follows the same three-piece pattern: `base.py` abstract class + `factory.py` registry + `configs/<category>.py` config. The authoritative list of registered backends is the factory's `backend_to_class`; the snapshot below is provided for quick reference:

| Category | Base class | Factory | Registered backends |
|----------|-----------|---------|---------------------|
| LLM | `BaseLLM` | `LLMFactory` | `openai` / `openai_new` / `azure` / `ollama` / `huggingface` / `huggingface_singleton` / `vllm` / `qwen` / `deepseek` |
| Embedder | `BaseEmbedder` | `EmbedderFactory` | `ollama` / `sentence_transformer` / `ark` / `universal_api` |
| Vector DB | `BaseVecDB` | `VecDBFactory` | `qdrant` / `milvus` |
| Graph DB | `BaseGraphDB` | `GraphStoreFactory` | `neo4j` / `neo4j_community` / `nebular` / `polardb` / `postgres` |
| Chunker | `BaseChunker` | `ChunkerFactory` | `sentence` / `markdown` / `simple` / `charactertext` |
| Parser | `BaseParser` | `ParserFactory` | `markitdown` |
| Reranker | `BaseReranker` | `RerankerFactory` | `cosine_local` / `http_bge` / `http_bge_strategy` / `concat` / `noop` |
| Memory | `BaseMemory` (+ `BaseTextMemory` / `BaseActMemory` / `BaseParaMemory`) | `MemoryFactory` | `naive_text` / `general_text` / `tree_text` / `simple_tree_text` / `pref_text` / `simple_pref_text` / `kv_cache` / `vllm_kv_cache` / `lora` |
| Scheduler | `BaseScheduler` | `SchedulerFactory` | `general` / `optimized` |

## Adding a New Provider

Mirror any existing provider in the same category:

1. Implement `src/memos/<category>/<backend>.py`, inheriting the `base.py` abstract class and matching the signatures of existing providers.
2. Add a pydantic config in `src/memos/configs/<category>.py` and register it in `<Category>ConfigFactory.backend_to_class`.
3. Register the implementation in `<Category>Factory.backend_to_class` in `src/memos/<category>/factory.py`.
4. Third-party dependencies **must** go into an optional extras group in `pyproject.toml` (`tree-mem` / `mem-scheduler` / `mem-user` / `mem-reader` / `pref-mem` / `skill-mem`) and be added to `all`; guard the import with try/except ImportError and raise a clear "install extras X" message on failure.
5. Add tests under `tests/<category>/test_<backend>.py`; external HTTP / model loading must be mocked.

## Behavior Boundaries

### Always do

- Write a failing test first (TDD), placed under `tests/<corresponding module>/test_*.py`.
- Before claiming a task is done, run verification commands and paste the real output (at minimum `make format` plus the relevant pytest run).
- Keep changes within the directories the current task authorizes; cross-module edits need to be called out and approved first.
- Use `memos.log.get_logger(__name__)` for logging; route trace info through `memos.context.context` — do not `print`.
- Optional third-party dependencies (neo4j / redis / pika / pymilvus / markitdown, etc.) must be guarded with try/except ImportError and declared in the matching extras group.
- After touching `src/memos/api/`, run `make openapi` to refresh `docs/openapi.json`.

### Ask first

- Modifying `pyproject.toml` dependencies or the Python version constraint.
- Touching public routes, request/response models, or the OpenAPI contract under `src/memos/api/`.
- Changing DB schema, migrations, `mem_user` tables, or `graph_dbs` graph models.
- Deleting files or doing wide-scope renames of public APIs (`memos.*` top-level symbols).
- Editing `Makefile`, `.pre-commit-config.yaml`, `pyproject.toml [tool.*]`, or `.github/workflows/`.

### Never do (IMPORTANT)

- **Never** commit `.env`, `private/`, `.private-paths`, `tmp/`, `*.log`, secrets, tokens, or model credentials.
- Do not log or include real API keys, raw user data, or vector contents in tests/fixtures.
- Do not skip `pre-commit` or push with `--no-verify` (the `scripts/check-public-push.sh` pre-push hook is enforced).
- Do not claim tests pass without real pytest output as evidence.
- Do not add third-party dependencies to core `dependencies` — they must go into optional extras.
- Do not run wide-scope `rm -rf` outside `src/`; do not `git push --force` or `git reset --hard origin/*`.

## Code Style

- Format and lint with Ruff (configured in `pyproject.toml [tool.ruff]`); `make format` must pass before commit.
- Type annotations are required on public functions, API schemas, and config classes; implicit `Optional` is not allowed (enforced via pre-commit).
- All configs and API schemas use Pydantic v2.
- Logging: `logger.info("... %s", x)` form — do not pre-format with f-strings before passing to the logger.
- Exceptions: library code raises semantic exceptions from `memos.exceptions`, never bare `Exception` / `RuntimeError`; the API layer translates them to HTTP errors in `memos.api.exceptions`.
- File naming: source `snake_case.py`, tests `test_<module>.py`.

## Change → Test Mapping

- Edit `src/memos/<module>/`: at minimum run `pytest tests/<corresponding module>/ -q`; run `make test` once more before merging.
- Edit `src/memos/api/`: run `tests/api/` and `make openapi` to confirm the OpenAPI spec did not change unexpectedly.
- Edit `pyproject.toml` dependencies: `poetry lock --no-update`, then `make test`.
- Edit `Makefile` / pre-commit / Ruff config: run `make pre_commit` locally over the whole tree.

## Git Conventions

- Commits: Conventional Commits (`feat:` / `fix:` / `chore:` / `refactor:` / `docs:`), subject line ≤ 72 chars.
- Branches: `feat/<slug>` / `fix/<slug>` / `dev-YYYYMMDD-v<version>`.
- `main` is protected — all changes go through PRs; never force-push to `main`; do not skip git hooks.
- Do not commit paths listed in `.private-paths`.
- The PR template lives at `.github/PULL_REQUEST_TEMPLATE.md` — its checklist must be fully ticked.
