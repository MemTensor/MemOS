# Eval Branch Workflow

This document describes how to maintain `mem-agent-eval` as the shared evaluation
base for MemOS Local plugin testing.

## Goal

`mem-agent-eval` should stay clean and reusable:

- Track the latest `main`.
- Keep the `memory_search` / `memory_add` independent switch feature.
- Keep local package install helpers needed for evaluation.
- Avoid permanently merging every feature branch into `mem-agent-eval`.

For each feature branch under test, create a temporary evaluation branch.

## One-Time Setup

Enable Git rerere so repeated conflict resolutions can be reused:

```bash
git config rerere.enabled true
```

## Push the Eval Base Branch

Start from the current local branch:

```bash
git switch mem-agent-eval
git status --short --branch
```

Run focused verification:

```bash
npm run lint
npm test -- tests/unit/adapters/openclaw-bridge.test.ts
npm test -- tests/unit/install/install-sh.test.ts
```

Commit the evaluation-base changes:

```bash
git add \
  adapters/openclaw/bridge.ts \
  adapters/openclaw/index.ts \
  adapters/openclaw/tools.ts \
  adapters/openclaw/plugin-config.ts \
  agent-contract/dto.ts \
  core/pipeline/memory-core.ts \
  core/pipeline/orchestrator.ts \
  install.sh \
  install.ps1 \
  openclaw.plugin.json \
  tests/unit/adapters/openclaw-bridge.test.ts \
  tests/unit/adapters/openclaw-runtime.test.ts \
  tests/unit/install/install-sh.test.ts \
  local-pack-install.sh \
  scripts/install-local-package.sh \
  docs/EVAL-BRANCH-WORKFLOW.md

git commit -m "feat(openclaw): add memory search and add switches"
```

Push the branch:

```bash
git push -u origin mem-agent-eval
```

## Keep `mem-agent-eval` Following `main`

When `main` updates:

```bash
git switch mem-agent-eval
git fetch origin
git rebase origin/main
```

Resolve conflicts if needed, then verify:

```bash
npm run lint
npm test -- tests/unit/adapters/openclaw-bridge.test.ts
npm test -- tests/unit/install/install-sh.test.ts
```

Push the updated eval base:

```bash
git push --force-with-lease
```

Use `--force-with-lease` only after a rebase. It protects against overwriting
remote changes you have not fetched.

## Evaluate a Feature Branch

Do not merge feature branches directly into `mem-agent-eval`.

For a branch named `feature-a`:

```bash
git fetch origin
git switch mem-agent-eval
git switch -c eval/feature-a
git merge --no-ff origin/feature-a
```

Run the evaluation on `eval/feature-a`.

After evaluation, either keep the branch for traceability or delete it:

```bash
git switch mem-agent-eval
git branch -D eval/feature-a
```

If the temporary branch was pushed:

```bash
git push origin --delete eval/feature-a
```

## If a Feature Branch Needs the Switch Feature

Prefer temporary eval branches. If a real feature branch must permanently get
the switch functionality, cherry-pick only the switch commit from
`mem-agent-eval`:

```bash
git switch target-branch
git cherry-pick <switch-commit-sha>
```

Do not merge the entire `mem-agent-eval` branch into product branches unless the
team explicitly wants all evaluation-only changes.

## Expected Branch Shape

The long-lived branch should look like this:

```text
mem-agent-eval = latest main + memory_search/memory_add switches + local install helpers
```

Temporary evaluation branches should look like this:

```text
eval/<feature> = mem-agent-eval + feature branch changes
```

This keeps the evaluation base stable while allowing any branch to be tested
with the same switch controls.
