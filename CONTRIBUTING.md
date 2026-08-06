# Contributing to MemOS

Thanks for your interest in contributing to MemOS! 🎉

MemOS is a Memory Operating System for LLMs and AI agents, maintained by [记忆张量MemTensor](https://www.memtensor.com.cn/) and a growing community of contributors. Whether you want to fix a bug, add a feature, improve docs, or just ask a question — you're welcome here.

---

## Table of Contents

*   [Ways to Contribute](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#ways-to-contribute)

*   [Before You Start](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#before-you-start)

*   [Setting Up Your Development Environment](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#setting-up-your-development-environment)

*   [Development Workflow](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#development-workflow)

*   [Commit Message Guidelines](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#commit-message-guidelines)

*   [What Makes a Good PR](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#what-makes-a-good-pr)

*   [Review Process](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#review-process)

*   [Writing Tests](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#writing-tests)

*   [Writing Documentation](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#writing-documentation)

*   [Community](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#community)

*   [Code of Conduct](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#code-of-conduct)

*   [License](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#license)

*   [Recognition](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#recognition)


---

## Ways to Contribute

You don't have to write code to be a contributor. Things that genuinely help the project:

*   **🐛 Report bugs** — open a [GitHub Issue](https://github.com/MemTensor/MemOS/issues)with a minimal reproduction

*   **💡 Propose features or design ideas** — start a thread in [GitHub Discussions](https://github.com/MemTensor/MemOS/discussions)

*   **🔧 Submit code** — bug fixes, new memory backends, plugins, performance improvements

*   **📚 Improve documentation** — typos, missing examples, unclear explanations. Docs live in a separate repo: [MemTensor/MemOS-Docs](https://github.com/MemTensor/MemOS-Docs)

*   **🧪 Add tests** — coverage for edge cases or under-tested modules

*   **🌍 Translate** — help us reach more developers in more languages

*   **❓ Answer questions** — help newcomers in Discussions, Discord, and the WeChat group

*   **📣 Share what you built** — write a blog post, demo, or tutorial using MemOS, and tell us about it


![image.png](https://alidocs.oss-cn-zhangjiakou.aliyuncs.com/res/WgZOZA8erK2geqLX/img/db661fd0-70ec-4c31-af72-87dabfcb89be.png)

All of these count as contributions. We're happy to recognize non-code contributors as well — open an issue or message us if you'd like to be added.

---

## Before You Start

### First time here?

*   Read the [project overview](https://github.com/MemTensor/MemOS#readme) to get a sense of what MemOS does

*   Try the [Quickstart](https://memos-docs.openmem.net/open_source/getting_started/installation)to set up a local instance

*   Skim [Core Concepts](https://memos-docs.openmem.net/open_source/home/core_concepts)— especially the distinction between Plaintext, Activation, and Parametric memory


### Found something to work on?

*   **For bugs or small fixes** — feel free to open a PR directly

*   **For larger changes** (new modules, API changes, architectural changes) — please open an Issue or Discussion first to align with maintainers before writing code. This avoids the situation where a substantial PR is rejected because it doesn't fit the project direction


### Not sure where to start?

We use two labels to help newcomers find a good entry point:

*   🌱 [`good first issue`](https://github.com/MemTensor/MemOS/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22) — small, well-scoped tasks that don't require deep familiarity with the codebase. **Start here for your first contribution.**

*   🙋 [`help wanted`](https://github.com/MemTensor/MemOS/issues?q=is%3Aopen+is%3Aissue+label%3A%22help+wanted%22) — issues where maintainers actively welcome external contributions. May be larger or more involved than `good first issue`, but the direction is already agreed on.


**How to claim an issue:**

1.  Comment on the issue saying you'd like to take it (this avoids two people working on the same thing)

2.  Wait for a maintainer to assign it to you, or just go ahead if it's been sitting unclaimed

3.  If you go quiet for more than a week without progress, we may release the issue back to the pool — feel free to pick it up again later


If nothing on the list catches your eye, ask in [Discussions](https://github.com/MemTensor/MemOS/discussions) — we're happy to suggest something based on your interests.

---

## Setting Up Your Development Environment

### Prerequisites

Make sure these are installed locally:

*   **Git**

*   **Python 3.9+** — verify with `python3 --version`

*   **Make**

*   **Poetry** — for dependency management


Install Poetry using the official installer:

```bash
curl -sSL https://install.python-poetry.org | python3 -
poetry --version

```

If you see `poetry: command not found`, add the Poetry executable directory to your `PATH` as prompted by the installer, then restart your terminal.

### Fork and clone the repository

```bash
# Fork the repo on GitHub first, then:
git clone https://github.com/YOUR-USERNAME/MemOS.git
cd MemOS
git remote add upstream https://github.com/MemTensor/MemOS.git

```

### Install dependencies

From the repository root:

```bash
make install

```

This installs all project dependencies and sets up pre-commit hooks. If you later switch branches or upstream dependencies change, run `make install` again to keep your environment in sync.

### Choose your memory backend

MemOS supports multiple memory types, each with different database dependencies. You only need to set up the ones you'll actually use.

**Textual Memory** (you must pick one):

| Backend | Identifier | Database needed |
| --- | --- | --- |
| **Tree** (recommended) | `tree_text` | Graph database — Neo4j Desktop, Neo4j Community, or PolarDB |
| **General** | `general_text` | Vector database — Qdrant or compatible |
| **Naive** | `naive_text` | None (testing only) |

**Preference Memory** (optional):

| Backend | Identifier | Database needed |
| --- | --- | --- |
| **Pref** | `pref` | Milvus |

For most contributors, the simplest setup is:

*   **Memory type:** `tree` (`tree_text`)

*   **Graph database:** Neo4j Community (via Docker)

*   **Vector database:** Qdrant in local embedded mode (no separate service needed)


> Neo4j Community has no native vector retrieval, so it's paired with Qdrant for vector search. Qdrant in local embedded mode reads/writes local files directly, so you don't need to run a separate Qdrant server.

### Configure `.env`

Create a `.env` file in the repo root:

```bash
cd MemOS
touch .env
```

For the contents, refer to the [`.env` configuration guide](https://memos-docs.openmem.net/open_source/getting_started/installation#2.-.env-content). You'll need API keys for your chosen LLM provider — these can be obtained from [BaiLian](https://bailian.console.aliyun.com/) (for `OPENAI_API_KEY`, `MOS_EMBEDDER_API_KEY`, `MEMRADER_API_KEY`, etc.) or any compatible provider.

### Start dependent services

If you're using the Neo4j + Qdrant setup:

```bash
cd docker
docker compose up neo4j
```

### Run the dev server

In a new terminal:

```bash
cd MemOS
make serve
```

The API server will start on `http://localhost:8000`.

For more deployment options (full Docker setup, slim/full image variants, ARM/x86 builds), see the [full Setting Up guide](https://memos-docs.openmem.net/open_source/contribution/setting_up).

---

## Development Workflow

### 1. Sync with upstream

If you've forked previously, pull in the latest upstream changes before starting:

```bash
git checkout dev
git fetch upstream
git pull upstream dev
git push origin dev

```

### 2. Create a feature branch

Branch off `dev` (not `main`):

```bash
git checkout -b feat/your-feature-name

```

Use a descriptive branch name:

*   `feat/add-redis-backend`

*   `fix/memory-leak-in-scheduler`

*   `docs/clarify-memcube-api`


### 3. Make your changes

Implement your feature, fix, or improvement in the appropriate files. For example, you might add a function in `src/memos/your_module.py` and corresponding tests in `tests/test_your_module.py`.

### 4. Run tests

```bash
make test

```

All tests should pass before you open a PR. If you've added new functionality, please add tests for it (see [Writing Tests](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#writing-tests) below).

### 5. Rebase onto the latest `dev`

Before committing or opening a PR, rebase to make sure your branch is on top of the latest upstream:

```bash
git fetch upstream
git rebase upstream/dev
```

### 6. Commit your changes

Follow the [Commit Message Guidelines](https://claude.ai/chat/4504392b-b48f-484a-b284-09624e7f1147#commit-message-guidelines) below.

### 7. Push to your fork

```bash
git push origin feat/your-feature-name
```

### 8. Open a Pull Request

> ⚠️ **Open PRs against** `**dev**`**, not** `**main**`**.** PRs against `main` will be asked to retarget.

*   Go to [the upstream repository](https://github.com/MemTensor/MemOS) on GitHub

*   Click **Pull Requests** → **New Pull Request**

*   Select `dev` as the base branch and your feature branch as compare

*   Fill in the PR description carefully — what you changed, why, and any tradeoffs or open questions

*   Link to any related issue with `Closes #123` or `Refs #123`


If your PR is a work-in-progress and you'd like early feedback, mark it as **Draft** when opening — maintainers will know not to do a full review yet.

---

## Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/)format:

```plaintext
<type>: <short description>

[optional body]

[optional footer]
```

### Types

| Type | Use for |
| --- | --- |
| `feat` | A new feature |
| `fix` | A bug fix |
| `docs` | Documentation-only changes |
| `style` | Formatting changes (no logic change) |
| `refactor` | Code restructuring without behavior change |
| `test` | Adding or updating tests |
| `chore` | Maintenance tasks, build tooling, dependencies |
| `ci` | CI/CD or workflow related changes |

### Examples

```plaintext
feat: add Redis Streams backend for MemScheduler

fix: prevent memory leak in MemCube cleanup

docs: clarify MemCube vs MemReader in core concepts

refactor: extract retry logic into shared helper
```

Keep the description in the imperative mood ("add", "fix", "update"), not past tense.

For larger changes, include a body explaining the **why**, not just the **what** — the diff already shows what changed.

---

## What Makes a Good PR

Things that help your PR get merged faster:

*   **Scoped** — one logical change per PR. Don't bundle unrelated fixes

*   **Tested** — new code should have tests; bug fixes should include a regression test

*   **Documented** — public APIs need docstrings; user-facing changes need a note in the PR description

*   **Conventional commit messages** — see above

*   **Linked to an issue** — for non-trivial changes, reference the issue (`Closes #123`)

*   **Passes CI** — the PR can't be merged until checks are green


---

## Review Process

*   A maintainer will usually review within a few business days. If a PR sits untouched for over a week, feel free to ping politely

*   We may ask for changes — this isn't personal, it's how we keep the codebase consistent. Please don't take rejection or revision requests as discouragement

*   Once approved and CI is green, a maintainer will merge using **squash and merge** by default


---

## Writing Tests

We use `pytest`. Tests live under `tests/`, mirroring the structure of `src/`.

```bash
# Run all tests
make test

# Run a specific test file
poetry run pytest tests/test_your_module.py

# Run a specific test
poetry run pytest tests/test_your_module.py::test_specific_behavior

```

Guidelines:

*   New features should include tests covering the happy path and key edge cases

*   Bug fixes should include a regression test that fails on the old code and passes on the new

*   Use descriptive test names — `test_search_returns_empty_when_no_match` is better than `test_search_2`

*   Avoid relying on external services in unit tests — mock them or use fixtures


For detailed conventions, see [How to Write Unit Tests](https://memos-docs.openmem.net/open_source/contribution/writing_tests).

---

## Writing Documentation

The MemOS documentation lives in a separate repository: [MemTensor/MemOS-Docs](https://github.com/MemTensor/MemOS-Docs).

If you want to:

*   **Fix a typo or small issue** — click "Edit on GitHub" at the bottom of any doc page

*   **Add a new doc page or restructure existing ones** — open a PR against the MemOS-Docs repo

*   **Document a new feature you're adding** — please update both the code (in this repo) and the docs (in MemOS-Docs) as part of your change


For style and structure conventions, see [Documentation Writing Guidelines](https://memos-docs.openmem.net/open_source/contribution/writing_docs).

---

## Community

Questions, ideas, showing off what you built — pick whichever channel fits:

| Channel | Best for |
| --- | --- |
| [GitHub Issues](https://github.com/MemTensor/MemOS/issues) | Bug reports, concrete feature requests |
| [GitHub Discussions](https://github.com/MemTensor/MemOS/discussions) | Open-ended questions, design ideas, sharing projects |
| [Discord](https://discord.gg/Txbx3gebZR) | Real-time chat, mostly English-speaking community |
| [WeChat Group](https://statics.memtensor.com.cn/memos/qr-code.png) | 中文实时交流，国内用户首选 |

For sensitive issues (security vulnerabilities, Code of Conduct concerns), please contact the maintainers privately rather than using public channels. See our [Code of Conduct](https://claude.ai/chat/CODE_OF_CONDUCT.md) for the reporting email.

---

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](https://claude.ai/chat/CODE_OF_CONDUCT.md). We're committed to making MemOS a welcoming, harassment-free community for everyone.

---

## License

MemOS is licensed under the [Apache License 2.0](https://claude.ai/chat/LICENSE). By contributing, you agree that your contributions will be licensed under the same license.

---

## Recognition

Every merged PR earns you a place in the [Contributors graph](https://github.com/MemTensor/MemOS/graphs/contributors)and on your GitHub profile. We're working on broader recognition for non-code contributions too — stay tuned.

Thanks again for being here. ✨
