# memory_search / memory_add 独立开关迁移说明

## 1. 变更范围

- 基线：`upstream/main` 的 `554bb98e`
- 开发分支：`mem-agent-0721-dev`
- 仅迁移 `memory_search`、`memory_add` 两个独立开关
- 不迁移或新增任何 `readonly` 模式、只读检索分支、只读 runtime lock 或 headless duplicate runtime 逻辑

推荐配置：

```yaml
memory_search:
  enabled: true
memory_add:
  enabled: false
```

两个开关默认均为 `true`，未配置时保持原有行为。

老版本配置文件不包含这两个字段时，解析结果仍为：

```yaml
memory_search:
  enabled: true
memory_add:
  enabled: true
```

只配置其中一个开关时，另一个开关也会独立回退到 `true`。已有的 Viewer、hook 等其他配置字段不会影响这两个默认值。

## 2. 开关行为

| memory_search | memory_add | 行为 |
| --- | --- | --- |
| `true` | `true` | 正常检索、注入上下文并捕获记忆。 |
| `true` | `false` | 正常走原有 turn-start、session/episode 和检索链路，但跳过 turn-end 捕获及记忆写入。 |
| `false` | `true` | 保留 turn 生命周期和捕获，跳过检索与上下文注入。 |
| `false` | `false` | 跳过检索和捕获。 |

`memory_add=false` 不是数据库只读模式，也不等同于 `readonly=true`。它只关闭 memory add/capture 相关行为；正常 turn-start 过程中原本存在的 session/episode 生命周期不做只读化改造。

## 3. 修改文件及修改原因

### 3.1 配置与插件入口

#### `apps/memos-local-plugin/adapters/openclaw/plugin-config.ts`

新增统一配置解析：

- 定义 `memory_search.enabled` 和 `memory_add.enabled`；
- 两个开关默认值均为 `true`；
- 兼容直接布尔值和已有 camelCase 布尔字段。

原因：保证插件入口、Bridge 和工具注册使用同一套开关语义，同时兼容已有配置。

#### `apps/memos-local-plugin/adapters/openclaw/index.ts`

修改内容：

- 插件注册时解析两个开关；
- 将开关传给 OpenClaw Bridge；
- 将 `memory_search` 开关传给工具注册；
- `memory_search=false` 时不发布依赖检索工具的 memory capability 提示；
- 对外提供插件配置 schema；
- 启动日志记录最终开关值。

原因：插件入口负责统一分发配置，避免 hook 和工具出现不同状态。

未修改内容：

- runtime lock 仍保持 `main` 原有的独占策略；
- Viewer 端口冲突仍按原有逻辑报错；
- 不因 `memory_add=false` 启动只读或 headless runtime。

#### `apps/memos-local-plugin/openclaw.plugin.json`

增加两个开关的 JSON Schema、默认值和说明。

原因：OpenClaw 需要通过 manifest 识别、校验并展示插件配置。

#### `apps/memos-local-plugin/install.sh`

同步更新安装脚本生成的插件 manifest。

原因：避免源码 manifest 与实际安装产物不一致。

### 3.2 OpenClaw Hook 与工具

#### `apps/memos-local-plugin/adapters/openclaw/tools.ts`

增加 `memorySearchEnabled`：关闭后不注册 `memos_search`。

`memos_get`、`memos_timeline`、skill 等其他工具保持不变。

原因：关闭 `memory_search` 时，既要关闭自动检索，也要避免模型显式调用 `memos_search` 绕过开关；同时不扩大成“禁用所有记忆查看工具”。

#### `apps/memos-local-plugin/adapters/openclaw/bridge.ts`

修改内容：

- 接收 `memorySearchEnabled` 和 `memoryAddEnabled`；
- `memory_search=false` 时不执行有效检索、不注入上下文、不追加检索修复提示；
- `memory_add=false` 时跳过 `agent_end` 捕获、tool outcome 记录等 add/capture 行为；
- 两个开关均关闭时直接跳过对应 turn hook；
- 保留 `MEMOS_MEMORY_ADD_DISABLED` 和 `EVOAGENTBENCH_MEMOS_DISABLE_ADD` 环境变量兼容。

原因：OpenClaw 的检索和捕获分散在多个 hook 中，必须分别控制才能实现真正独立的开关。

未增加 `__memosReadOnlyTurnStart`、临时只读 session 或其他 readonly 标记。

### 3.3 MemoryCore 与 Pipeline

#### `apps/memos-local-plugin/agent-contract/dto.ts`

在 `TurnInputDTO` 增加 `skipRetrieval?: boolean`。

原因：`memory_search=false, memory_add=true` 时仍要保留正常 turn/session/episode 路由，供 turn-end 捕获使用，只跳过检索本身。

#### `apps/memos-local-plugin/core/pipeline/memory-core.ts`

识别 `skipRetrieval`：

- 继续调用 pipeline 的 `onTurnStart`；
- 返回空 hits 和空 injected context；
- 不执行 Hub/local memory retrieval；
- 不记录未实际发生的 `memos_search` API 日志和 retrieval telemetry。

原因：实现 capture-only 模式，避免额外检索成本和误导性日志。

#### `apps/memos-local-plugin/core/pipeline/orchestrator.ts`

在原有 turn-start 流程中识别 `skipRetrieval`，完成 session/episode 路由后返回空检索包。

原因：关闭搜索不能破坏后续捕获需要的生命周期关联。

本文件不包含 read-only turn-start 分支。`memory_search=true` 时仍完整执行 `main` 原有的：

- intent classifier；
- `scheduleInjection`；
- `retrieveTurnStart`；
- query builder、domain tag、Tier1/Tier2/Tier3、排序和过滤。

因此 `memory_add=false` 不会改变检索算法；挂在正常检索链路上的评测域优化仍按原路径触发。

> 本次只保证 `main` 已有检索能力不被开关绕过。旧开发分支中其他 Hermes、LLM、retrieval/injector 等实验改动不在迁移范围内。

### 3.4 测试

#### `apps/memos-local-plugin/tests/unit/adapters/openclaw-bridge.test.ts`

覆盖：

- 配置默认值、嵌套格式和兼容格式；
- `memory_add=false` 时保留检索但不产生 trace；
- `memory_search=false` 时不注入上下文但仍能捕获 trace；
- 关闭搜索后不注册 `memos_search`，其他工具仍保留。

#### `apps/memos-local-plugin/tests/unit/adapters/openclaw-runtime.test.ts`

验证插件入口会把两个独立开关正确传给 Bridge。

不包含只读 runtime 或重复 headless runtime 测试。

#### `apps/memos-local-plugin/tests/unit/install/install-sh.test.ts`

验证安装产物包含两个开关的 schema。

#### `apps/memos-local-plugin/tests/unit/pipeline/orchestrator.test.ts`

验证 `skipRetrieval` 会跳过 embedding/retrieval，同时仍建立正常 session/episode 路由。

## 4. 为什么不迁移 readonly

`readonly` 是运行模式，通常还会影响数据库打开方式、锁、Viewer、session/episode 写入边界等；`memory_add` 和 `memory_search` 是功能开关。把两者混在一起会导致：

- `memory_add=false` 暗中改变检索路径；
- runtime lock 和 Viewer 行为随开关变化；
- 正式版需要维护两套 turn-start 实现；
- 评测结果难以区分是开关差异还是 readonly 实现差异。

因此本分支只保留独立功能开关。若未来需要 `readonly`，应作为单独需求设计和评审。

## 5. 验证项

- TypeScript 构建：`npm run build`
- OpenClaw bridge/runtime/install 相关单测
- Pipeline `skipRetrieval` 生命周期测试
- `git diff --check`

原开发分支的未提交内容仍保存在：

```text
stash@{0}: On memos-local-plugin-0611-work: codex-preserve-before-mem-agent-0721-dev
```

该 stash 未合并到当前分支。
