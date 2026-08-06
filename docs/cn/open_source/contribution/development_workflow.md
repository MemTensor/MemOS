---
title: 开发流程
---

按照以下步骤参与项目开发。

::steps{level="4"}

#### 与上游仓库同步

如果你之前 fork 了该仓库，请与上游仓库的变更保持同步：

```bash
git checkout dev        # 切换到 dev 分支
git fetch upstream      # 获取上游仓库的最新更改
git pull upstream dev   # 将更改合并到本地 dev 分支
git push origin dev     # 将合并后的代码推送到你自己的 fork
```

#### 创建功能分支

为你的新功能或修订创建一个新的分支：

```bash
git checkout -b feat/descriptive-name
```

#### 添加你的功能或修订

在相应文件中实现你的功能、修订或改进。

* 例如，你可以在 `src/memos/hello_world.py` 中添加一个函数，并在 `tests/test_hello_world.py` 中编写相应的测试用例。

#### 测试你的更改

运行测试套件以确保更改正确：

```bash
make test
```

#### 提交更改

在提交前或 PR 前，rebase 到最新 upstream/dev：

```bash
git fetch upstream
git rebase upstream/dev      # 把你的 feat 分支基于最新 dev 重放
```

提交更改时请遵循项目的提交规范（参见 [提交规范](commit_guidelines.md)）。

#### 推送到你的 Fork 仓库

将功能分支推送到你 fork 的远程仓库：

```bash
git push origin feat/descriptive-name
```

#### 创建 Pull Request

提交你的更改以供审核：

* **重要提示：** 请务必将 Pull Request 提交到：

  * ✅ 上游仓库的 `dev` 分支，
  * ❎ 而不是上游仓库的 `main` 分支。
* 打开 GitHub 上的原始仓库
* 点击 "Pull Requests"
* 点击 "New Pull Request"
* 选择 `dev` 作为目标分支，你的分支作为对比分支
* 仔细填写 PR 描述

::
