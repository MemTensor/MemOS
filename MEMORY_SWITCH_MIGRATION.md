# memory_search / memory_add 独立开关迁移说明

## 1. 变更概览

- 基线分支：`upstream/main`
- 基线提交：`554bb98e`（`chore: update version to v2.0.24`）
- 开发分支：`mem-agent-0721-dev`
- 功能提交：`df853c67`（`feat(memos-local): add independent memory switches`）
- 变更范围：OpenClaw 适配器、MemoryCore turn-start 流程、插件配置清单、安装脚本及对应测试。

本次变更将“是否检索记忆”和“是否新增记忆”拆成两个独立开关：

```yaml
memory_search:
  enabled: true
memory_add:
  enabled: false
```

两个开关默认均为 `true`，因此未配置时保持原有行为。

## 2. 开关组合及行为

| memory_search | memory_add | 行为 |
| --- | --- | --- |
| `true` | `true` | 正常检索、注入上下文并在 turn 结束后写入记忆。 |
| `true` | `false` | 正常检索和注入，但不创建持久化 episode、不捕获 trace、不写入记忆。 |
| `false` | `true` | 不执行 turn-start 检索、不注入上下文，但保留 session/episode 路由并正常写入记忆。 |
| `false` | `false` | 检索和写入均关闭，相关 turn hook 直接跳过。 |

选择独立开关而不是只提供 `readonly`，主要原因是独立开关可以表达四种运行模式，而 `readonly` 只能表达“允许读、禁止写”。配置含义也更直接，便于正式版部署、评测组合和后续扩展。

## 3. 修改文件及原因

### 3.1 OpenClaw 配置与启动

#### `apps/memos-local-plugin/adapters/openclaw/plugin-config.ts`

新增文件，集中定义：

- `memory_search.enabled` 和 `memory_add.enabled` 的插件配置 schema；
- 两个开关默认值；
- 配置解析和兼容逻辑。

除了推荐的嵌套配置，还兼容直接布尔值以及已有的 camelCase 布尔字段，避免旧安装或测试配置立即失效。

#### `apps/memos-local-plugin/adapters/openclaw/index.ts`

修改内容：

- 插件注册时解析独立开关；
- 将开关传递给 bridge 和 tools；
- `memory_search=false` 时不发布依赖检索工具的 memory capability 提示；
- `memory_add=false` 时允许重复实例以 search-only、headless 方式启动，避免第二个只读检索实例争抢 Viewer 端口和 runtime lock；
- 启动日志记录两个开关的最终值；
- 对外导出插件配置 schema。

修改原因：开关必须在插件入口统一解析，并在 runtime、hook、tool 三条路径中使用同一份配置，避免不同组件对开关状态理解不一致。

#### `apps/memos-local-plugin/openclaw.plugin.json`

为 OpenClaw 插件 manifest 增加两个开关的 JSON Schema 和默认值说明。

修改原因：OpenClaw 需要通过 manifest 识别合法配置；同时让安装后的配置具备校验和自描述能力。

#### `apps/memos-local-plugin/install.sh`

同步更新安装脚本生成的 OpenClaw manifest，加入与源码 manifest 一致的开关 schema。

修改原因：安装脚本会生成实际部署使用的插件清单。如果只修改仓库中的 `openclaw.plugin.json`，通过脚本安装的版本不会获得新配置。

### 3.2 OpenClaw 工具与 Hook 行为

#### `apps/memos-local-plugin/adapters/openclaw/tools.ts`

新增 `memorySearchEnabled` 选项，并在关闭检索时不注册 `memos_search` 工具。

`memos_get`、`memos_timeline`、skill 等其他工具仍保留，避免把“关闭自动搜索”扩大成“禁用全部记忆查看能力”。

修改原因：`memory_search=false` 不应只阻止自动 turn-start 检索，还应避免模型通过显式 `memos_search` 绕过开关。

#### `apps/memos-local-plugin/adapters/openclaw/bridge.ts`

修改内容：

- Bridge 接收 `memorySearchEnabled` 和 `memoryAddEnabled`；
- `memory_add=false` 时禁止 `agent_end` 捕获、tool outcome 记录和其他写入相关 hook；
- `memory_search=false` 时禁止 turn-start 上下文注入和失败修复检索提示；
- `memory_search=false, memory_add=true` 时仍建立 turn 路由，但向 MemoryCore 传递 `skipRetrieval`；
- `memory_search=true, memory_add=false` 时使用确定性的临时 session 标识，并标记 read-only turn-start，避免为了检索创建持久化 session/episode；
- 同时兼容 `MEMOS_MEMORY_ADD_DISABLED` 和 `EVOAGENTBENCH_MEMOS_DISABLE_ADD` 环境变量。

修改原因：OpenClaw 的读写行为分布在多个 hook 中，只在 `agent_end` 增加判断并不能彻底禁止写入。必须同时约束 turn、tool、session 等相关 hook，才能保证 `memory_add=false` 的语义完整。

### 3.3 MemoryCore 与检索调度

#### `apps/memos-local-plugin/agent-contract/dto.ts`

在 `TurnInputDTO` 增加可选字段 `skipRetrieval`。

修改原因：`memory_search=false, memory_add=true` 仍需要打开并路由当前 turn，以便 turn-end 正常捕获；因此不能简单跳过整个 `onTurnStart`，需要显式表达“保留生命周期、跳过检索”。

#### `apps/memos-local-plugin/core/pipeline/memory-core.ts`

识别 `skipRetrieval`：

- 继续调用 pipeline 的 turn-start 路由；
- 返回空 hits 和空 injected context；
- 不执行 Hub/local memory 检索；
- 不记录一次并未发生的 `memos_search` API 日志和检索 telemetry。

修改原因：保证 capture-only 模式仍能形成完整的 session/episode/trace，同时避免产生误导性的检索数据和额外检索成本。

#### `apps/memos-local-plugin/core/pipeline/orchestrator.ts`

增加两条受控路径：

1. `skipRetrieval=true`：正常完成 session/episode 路由，然后返回空检索包；
2. read-only turn-start：不调用 `ensureSession`、不创建 episode，但仍复用正式版的 intent classifier、`scheduleInjection` 和 `retrieveTurnStart`。

read-only 路径没有固定为 `TASK + Tier1/2/3`，而是继续执行正常 scheduler，因此可以保留：

- chitchat/meta 场景跳过；
- memory-probe 场景；
- intent 对 Tier1/Tier2/Tier3 的选择；
- `retrieveTurnStart` 后续的 query builder、domain tag、排序、过滤和注入逻辑。

修改原因：`memory_search=true, memory_add=false` 应当只改变“是否写入”，不应偷偷切换成另一套简化检索算法。这样挂接在正式检索链路上的评测域优化才能继续触发。

> 注意：这里保证的是 `main` 当前已有、且挂在正常 `retrieveTurnStart` 链路上的优化不会被独立开关绕过。旧开发分支中其他尚未提交的 Hermes、LLM、retrieval/injector 等实验改动没有随本次迁移进入新分支。

### 3.4 测试

#### `apps/memos-local-plugin/tests/unit/adapters/openclaw-bridge.test.ts`

新增覆盖：

- 两个开关的默认值、嵌套格式和兼容格式；
- `memory_add=false` 时能够检索但不产生 episode/trace；
- `memory_search=false` 时不注入上下文但仍能捕获 trace；
- 关闭检索时不注册 `memos_search`，其他工具仍可用。

#### `apps/memos-local-plugin/tests/unit/adapters/openclaw-runtime.test.ts`

新增 runtime 配置传递和 search-only headless 重复实例行为测试。

修改原因：验证开关不仅能被解析，还能真正控制插件启动和 runtime lock/Viewer 端口行为。

#### `apps/memos-local-plugin/tests/unit/install/install-sh.test.ts`

增加安装产物包含 `memory_search`、`memory_add` schema 的断言。

修改原因：防止源码 manifest 已更新、安装脚本产物却遗漏配置的回归。

#### `apps/memos-local-plugin/tests/unit/pipeline/orchestrator.test.ts`

增加 read-only turn-start 调度测试，验证：

- 继续使用正常场景 scheduler；
- chitchat 不触发 embedding/retrieval；
- 不创建持久化 session 和 episode。

修改原因：直接保护“检索逻辑一致但不写入”这一关键语义，避免以后把 read-only 路径退化成固定全量检索。

## 4. 与 readonly 的关系

`memory_search=true, memory_add=false` 与传统 `readonly=true` 的目标相近，都是“允许检索、禁止新增记忆”，但实现和配置边界不同：

- 独立开关是正式插件配置的一部分，有 schema、默认值和组合语义；
- `memory_add=false` 只关闭写入，不改变正常检索 scheduler；
- `memory_search` 可以单独关闭，从而支持 capture-only 模式；
- 两个开关关闭时可以完整跳过读写路径。

因此正式版推荐以独立开关作为主要配置接口。如果仍需保留 `readonly`，更合理的做法是将其作为兼容别名，内部转换成 `memory_search=true, memory_add=false`，而不是维护第二套检索实现。

## 5. 验证结果

- TypeScript 构建通过：`npm run build`
- OpenClaw bridge、runtime、install、pipeline orchestrator 相关 4 个测试文件均通过，共 79 个测试用例
- `git diff --check` 通过
- 功能提交后工作区保持干净

原开发分支的未提交内容保存在：

```text
stash@{0}: On memos-local-plugin-0611-work: codex-preserve-before-mem-agent-0721-dev
```

该 stash 未合并到 `mem-agent-0721-dev`，避免把与独立开关无关的实验改动带入正式版候选分支。
