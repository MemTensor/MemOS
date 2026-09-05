# OpenClaw 云插件自动 Draft Release 发布说明

## 一句话结论

发布人员不需要新建固定名称的 `release/*` 分支，也不需要手工填写 npm tag 或 40 位 commit。
将四个版本文件在同一个受审 PR 中一致升级并合入 `main` 后，系统会自动判断是 Beta 还是稳定版，
发布并验证 npm，随后创建 GitHub Draft Release；发布负责人检查 Draft 后再点击 **Publish**。

这套流程不会让 GitHub Actions 新建或批准 PR，因此仓库不需要开启
**Allow GitHub Actions to create and approve pull requests**。版本修改仍由开发人员通过普通 PR 提交，Actions
只负责消费已经合入 `main` 的代码、发布 npm、创建 tag 和 Draft Release。

## 发布负责人怎么操作

以稳定版 `0.1.21` 为例：

1. 使用团队现有分支，例如 `test` 或普通版本准备分支，不要求特定名称。
2. 将下列四个文件的 `version` 全部从当前版本改成 `0.1.21`：
   - `package.json`
   - `openclaw.plugin.json`
   - `moltbot.plugin.json`
   - `clawdbot.plugin.json`
3. 可选：添加 `.github/release-notes/v0.1.21.md`。不添加时由 106 根据 Git 证据自动生成。
4. 提交目标为 `main` 的 PR，确认测试和版本检查通过后由有权限人员合并。
5. 合并后打开 Actions 中的 **OpenClaw Cloud Plugin — Publish & Release**，确认自动 run 为绿色。
6. 打开仓库 Releases，检查系统创建的 `v0.1.21` Draft：
   - 版本和目标 commit 正确；
   - Release Notes 准确；
   - 中英文官网预览准确；
   - npm `0.1.21` 已经通过 `latest` 可见。
7. 确认无误后点击 **Publish release**。只有这一步会产生稳定版 `release.published` webhook，并让 106 创建 MemOS-Docs PR。

合并前会有一条只读的版本门禁，只比较 PR 合并预览与当前 `main` 的四个版本值，不读取发布 Secrets，
也不会发布 npm、创建 tag 或 Release。真正副作用只发生在合并后的自动 Workflow。

Beta 示例：将四个文件从旧版本一致升级为 `0.1.21-beta.0`。系统自动选择 npm `beta`，创建
GitHub Prerelease Draft；Publish 后 106 必须成功跳过正式官网同步。

## 系统怎样判断这是一次发版

系统比较 PR 合入前的 `main` 与合入后的精确 merge commit。只有同时满足以下条件才自动发版：

1. PR 已合入 `main`，并且来自当前仓库而不是 Fork；
2. 四个版本文件在合入前版本一致；
3. 四个版本文件在合入后版本一致；
4. 四个版本值都在本次 PR 中发生升级；
5. 新版本是严格 SemVer，并且优先级高于旧版本；
6. npm、GitHub tag 和 Release 状态没有冲突。

如果四个版本值完全没变，这是普通代码合并，自动跳过，不会发布。只改一部分版本文件、四个版本不一致、
版本倒退或使用 build metadata 时会失败停止，避免产生半正确的包。

允许的升级示例：

```text
0.1.20 -> 0.1.21-beta.0
0.1.21-beta.0 -> 0.1.21-beta.1
0.1.21-beta.1 -> 0.1.21
```

## Beta 与稳定版的区别

| 合入后的版本 | npm dist-tag | GitHub Draft | Publish 后的 Docs 行为 |
|---|---|---|---|
| `0.1.21-beta.0` | `beta` | Prerelease Draft | 106 成功跳过，不创建正式 Docs PR |
| `0.1.21-alpha.1` | `alpha` | Prerelease Draft | 106 成功跳过，不创建正式 Docs PR |
| `0.1.21-rc.1` | `next` | Prerelease Draft | 106 成功跳过，不创建正式 Docs PR |
| `0.1.21` | `latest` | 正常 Draft | 人工 Publish 后由 106 创建 Docs PR |

## 为什么 npm 在 Draft 之前发布

GitHub Draft 一旦被人工 Publish，`release.published` webhook 会立即到达 106。如果这时才异步发布 npm，
就可能出现官网同步已经开始、npm 却失败或暂时不可见的半发布状态。

因此本仓库选择：

```text
版本 PR 合入 main
-> 校验四文件版本与 Release Notes
-> npm publish + 校验 version/gitHead/dist-tag
-> 创建不可变 tag 和 Draft Release
-> 人工 Publish
-> 稳定版进入 106 Docs PR，预发布版成功跳过
```

合并版本 PR 表示已经批准代码和 npm 发布；Draft 的人工边界用于最后确认 GitHub Release 和官网文案。
如果团队要求“人工审批前 npm 也不能发布”，需要改用受保护 GitHub Environment 的审批按钮，不能只依赖原生 Draft。

## Release Notes 规则

### 默认方式：106 自动生成

不创建 `.github/release-notes/v<版本>.md`。Workflow 会基于真实 tag range 和本次 merge commit 调用 106，
生成中英文内容、真实 `source_refs`、质量报告和 Docs Preview。

稳定版会跳过中间 prerelease tag，以上一个稳定 tag 为 evidence 基线，避免 Beta 已经承载的真实功能在
`beta -> stable` 时被漏掉。

### 人工方式：随版本 PR 提交

创建 `.github/release-notes/v<版本>.md`。文件必须包含：

- `## Changelog` 公开 Markdown；
- 隐藏的 `doc-agent-release-notes-json` 双语证据块；
- 唯一的 `<!-- doc-agent: source-id=openclaw-cloud-plugin -->`。

人工文件也必须通过 source ref、覆盖率、双语和长度检查，不能绕过质量门禁。

## 哪些合并不会发布

分支名不决定是否发版。`test`、`feature/*`、`fix/*`、`docs-sync/*` 都可以合入 `main`：

- 四个版本值没有变化：正常跳过发布；
- 四个版本值全部一致升级：进入自动发布；
- 只有部分版本变化或版本不一致：检查失败，要求修正。

## 失败怎么处理

- 合并前版本检查失败：继续修改原 PR，四个版本一致且确实升级后再合并。
- 106 文案生成失败：不会发布 npm、tag 或 Draft；修复 endpoint、证据或人工 notes 后再处理。
- npm 发布失败且 registry 没有正确版本：不会创建 tag/Draft；根据 Action 错误处理，禁止猜测成功。
- npm 已成功但同一次自动任务尚未创建 tag/Draft：可先点击 Re-run；系统确认 npm `gitHead` 与原合并 commit 完全相同后，只补缺失元数据，不会重复发布 npm。
- npm 已成功，但 tag/Draft 未创建：使用现有 Workflow 的显式 Recovery；它从 npm `gitHead` 补齐元数据，不会重复发布 npm，并且仍然只创建 Draft 等待人工 Publish。
- Draft 文案不通过：不要点 Publish。修订 Draft 时不得删除或损坏隐藏的双语 evidence payload 和 `source-id`。
- tag 指向、npm `gitHead`、四文件版本任一冲突：必须人工排查，Workflow 不会移动已有 tag。

## 旧的手动入口

**OpenClaw Cloud Plugin — Publish & Release** 的 `Run workflow` 仍保留给历史 Dry-run、故障注入和部分失败 Recovery。
正常新版本发布直接走“四个版本文件一致升级并合入 `main`”，不再要求发布人员填写旧表单。
