---
title: AutoDev Smoke Test Note
desc: Internal note used to verify the AutoDev (cloud-coding-agent) end-to-end issue-to-PR pipeline. This file is documentation-only and does not affect runtime behavior.
---

# AutoDev Smoke Test Note

This note exists to verify that the AutoDev (cloud-coding-agent) pipeline can
take a GitHub Issue labeled `ai-task`, dispatch a code task, push a working
branch, and open a documentation-only Pull Request without altering runtime
behavior of MemOS.

## What this verifies

- A GitHub Issue with the `ai-task` label triggers the AutoDev webhook.
- The scheduler creates linked rows in `code_tasks` and `github_info`
  (`github_info.task_id` matches `code_tasks.id`).
- When dispatch is enabled, the task proceeds to branch creation, commit,
  push, and PR creation against the configured base branch.

## What this does not change

- No source code under `src/` or `packages/` is touched.
- No tests, configuration, or build files are modified.
- No public API, schema, or migration is introduced.

If you are reading this in a regular contribution context, you can ignore
this note — it is intentionally minimal and exists solely as a smoke-test
artifact for the AutoDev pipeline.
