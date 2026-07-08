---
title: Development Workflow
---

Follow these steps to contribute to the project.

::steps{level="4"}

#### Sync with Upstream

If you've previously forked the repository, sync with the upstream changes:

```bash
git checkout dev        # switch to dev branch
git fetch upstream      # fetch latest changes from upstream
git pull upstream dev   # merge changes into your local dev branch
git push origin dev     # push changes to your fork
```

#### Create a Feature Branch

Create a new branch for your feature or fix:

```bash
git checkout -b feat/descriptive-name
```

#### Make Your Changes

Implement your feature, fix, or improvement in the appropriate files.

- For example, you might add a function in `src/memos/hello_world.py` and create corresponding tests in `tests/test_hello_world.py`.

#### Test Your Changes

Run the test suite to ensure your changes work correctly:

```bash
make test
```

#### Commit Your Changes

Before committing or creating a PR, rebase to the latest upstream/dev:

```bash
git fetch upstream
git rebase upstream/dev      # Replay your feat branch on top of the latest dev
```

Follow the project's commit guidelines (see [Commit Guidelines](./commit_guidelines.md)) when committing your changes.

#### Push to Your Fork

Push your feature branch to your forked repository:

```bash
git push origin feat/descriptive-name
```

#### Create a Pull Request

Submit your changes for review:

- **Important:** Please create your pull request against
  - ✅ the `dev` branch of the upstream repository,
  - ❎ not the `main` branch of the upstream repository.
- Go to the original repository on GitHub
- Click on "Pull Requests"
- Click on "New Pull Request"
- Select `dev` as the base branch, and your branch as compare
- Fulfill the PR description carefully.

::
