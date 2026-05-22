# AutoDev Webhook Smoke Test

This document records a documentation-only smoke test for the AutoDev pipeline.

## Purpose

Verify that the GitHub webhook can trigger the AutoDev pipeline end-to-end:

1. AutoDev receives the `issues.labeled` event for the `ai-task` label.
2. AutoDev creates a working branch.
3. AutoDev makes a minimal documentation-only change.
4. AutoDev opens a pull request against `main`.

## Scope

This change is intentionally limited to documentation. No source code, build
configuration, tests, or runtime behavior is affected. It exists solely to
exercise the AutoDev → GitHub integration path.

## Related

- Issue: [MemOS #1781](https://github.com/MemTensor/MemOS/issues/1781)
