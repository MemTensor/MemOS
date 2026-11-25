# Windows DSH 诊断增强版补测说明

本轮使用 `fix/local-plugin-dsh-install-version` 分支最新提交重新构建的插件。
目的是为 Q2、Q9、Q10 取得可判因的证据，并核对 Q11 的插件与宿主行为。
此版本增加诊断及过滤预算配置，尚不能据此将 Q9、Q10 标记为已修复。

## 1. 统一基线，确认真实加载

1. 记录完整 Git SHA、tarball SHA256、Windows / Node / 包管理器版本、
   `dsh --version`、Desktop 关于页版本与桌面内实际 DSH runtime 版本。
   本轮继续验证 DSH `0.2.1-rc.3`，另在真实 Desktop 0.2 系列实例上测试。
   同构 profile 的 CLI 运行不能代替 Desktop 验证。
2. 从指定提交的 `apps/memos-local-plugin` 安装依赖并执行 `npm pack`
   （其 `prepack` 会构建 Node 产物和 Viewer）。不要复用之前的 tarball。
   仓库中的 `2.0.16-beta.1` 是发布前版本占位，判断代码以提交和包哈希为准。
3. Windows 可执行 `Get-FileHash C:\test\memos-local-plugin.tgz -Algorithm SHA256`。
   每个测试用例使用明确的 DSH profile 和独立 MemOS home；并发同库组例外。
   Desktop 必须实际加载同一份补丁、包和 home。若用环境变量，需由设置变量的
   同一终端启动 Desktop；也可在补丁中直接指定绝对 home，避免 GUI 环境继承差异。
4. 按 [README 的安装步骤](README.md) 预置 Q1 的 profile 构建策略再安装 tarball。
   直接 `dsh plugin add` 仍需要消费端的构建白名单，不能靠插件自己的白名单替代。
   然后执行以下命令，确认 dump 中存在 `memos-local-memory`，且运行时出现 ready 日志。

```powershell
dsh --profile web --dump-config
```

若安装替换后 dump 没有 MemOS 行，再执行 Q7 幂等兜底并重新 dump：

```powershell
dsh plugin --profile web exec node node_modules/@memtensor/memos-local-plugin/scripts/ensure-dsh-bundle.mjs
dsh --profile web --dump-config
```

不要给上面的 `node_modules/...` 加 `./`：DSH 对显式相对路径的参数锚定不同。
请只回传 dump 中 MemOS 行及脱敏的 provider/model 配置，不回传整个可能含凭据的 dump。

## 2. 开启诊断

在被测 profile 的 `cordis.patch.yml` 中完整覆盖此行。将 `home` 改成该用例的目录，
保留已有 profileId（下面用默认值示例）。DSH patch 对 `config` 整体替换：

```yaml
- id: memos-local-memory
  config:
    enabled: true
    profileId: default
    home: 'C:/memos-test/diag-case/memory'
    recallEnabled: true
    captureEnabled: true
    toolsEnabled: true
    hostLlmEnabled: true
    viewerEnabled: true
    viewerPort: 18801
    recallTimeoutMs: 3000
    contextMaxChars: 6000
    toolResultMaxChars: 1200
    failOnStartupError: false
    diagnosticsEnabled: true
```

重启实际被测进程。启动日志会显示诊断文件路径，位于**实际生效的** MemOS home 的
`logs/dsh-diagnostics-<PID>-<runId>.jsonl`。环境变量 `MEMOS_HOME` 的优先级高于上述 home，
因此仍需核对启动日志。每次挂载单独写文件，并发进程互不覆盖。
Viewer 可用时，`GET http://127.0.0.1:18801/api/v1/diag/counts` 的
`dshDiagnostics` 字段给出当前进程统计；端口冲突、Viewer 关闭或插件启动失败时收集文件即可。
同库多进程时，Viewer 只代表占用该端口的一个进程，不能代表所有进程。

仅记录时间、PID、session/episode/trace ID、模型路由、adapter 列表、操作名、错误码、
计数和耗时等白名单元数据，不写提示词、消息正文、模型回复或 API key。
每文件上限 8 MiB，达到上限会写 `diagnostics.truncated` 并停止文件输出。
一旦截断，该用例需重启后缩小批次重测，不能将截断日志当完整样本。
这是同步追加的尽力诊断，不是磁盘断电持久性保证。强制终止可能没有 exit/closed 事件；
缺少收尾标记也可能表示进程仍在运行，必须附进程状态和宿主退出时间。

## 3. Q10：完整模式模型调用在哪个阶段失败

先让同一 provider/model 的普通 DSH 对话成功。保留 DSH 的真实 provider 别名
（例如 `memtensor`）；MemOS 的 `llm.provider: host` 表示委托给 DSH，
不能据此把 DSH 路由也改成 `host`。

在该用例的 MemOS `config.yaml` 中设置：

```yaml
algorithm:
  lightweightMemory:
    enabled: false
```

各组使用相同合成任务和模型，至少 5 轮已完成对话；包含工具成功/失败及明确的用户纠正，
让反思、奖励等流程有实际输入。记录每个 session/turn 的开始、答案完成、关闭时间。

| 组别 | 操作 | 要观察的区别 |
| --- | --- | --- |
| A：真实 Desktop 常驻 | 回答完成后保持进程运行至少 60 秒；再关闭会话，继续观察 60 秒 | 后台调用在 adapter 仍注册时是否成功 |
| B：CLI 正常退出 | 同样任务按正常退出方式结束，记录完整命令和退出码；不能手动延长宿主退出期限 | `adapter.disposing`、`llm.adapters_updated` 与 `NO_ADAPTER` 的先后关系 |
| C：直接 provider 对照 | 若 A/B 失败，在隔离 home 中按现有文档为 MemOS 配直接 provider，复跑同样任务 | 是否仅 host 委托链路失败；凭据只留本机 |

回传 `llm.started/succeeded/failed`、`llm.adapters_updated`、`model.status/error`
所在的完整诊断文件。重点按 callId 关联 provider/model、op、registeredProviders 和原生错误码。
若注册表列出 `memtensor` 但仍报 `NO_ADAPTER`，保留完整时间线；若只在销毁时从列表消失，
也应单独标注。不要仅按 policy/skill 数量定成败：这些产物有数据量和质量门槛，
单轮短对话没有 skill 不足以证明异常。附 trace、policy、skill 前后计数及相关 system_error 脱敏摘录。

## 4. Q2：区分过滤成功率、超时和真实耗时

### 4.1 诊断探针测量（独立预算）

诊断开启后多一个 `memos_diagnostic_filter` 工具。明确让 agent 逐次调用工具，例如：

> 请只调用一次 memos_diagnostic_filter，参数 candidateCount=5、timeoutMs=15000，返回工具结果。

候选数分别取 **1、5、20**；每组先 1 次预热，再连续 **20 次串行调用**。
确认实际发生了工具调用，并把预热与正式样本所在的运行/时间区间标明。
每次只调用一次；若 agent 没调用，应补齐有效样本数，不能把自然语言回答算探针结果。
15 秒仍超时时，可以额外做 60 秒组；**单独统计**，不要与 15 秒组混合。

探针用固定合成候选，直接执行同一过滤函数，不查库、不写记忆。
它的耗时只反映合成过滤基线，不能代替真实候选的质量评估或端到端召回耗时。
模型/宿主本身有更短限制时，较大的探针期限也无法绕过它。
探针返回 `outcome`、`durationMs`、`candidateCount`、`timeoutMs`、`kept`；
日志 `filter.result` 带 `probe: true`，汇总脚本与普通请求分开统计。

### 4.2 正常召回的预算对照（仍最多 3 秒）

用相同的记忆语料/问题集，分别设置以下过滤 cap，重启并各执行至少 20 次实际命中过滤的检索：

```yaml
algorithm:
  retrieval:
    llmFilterTimeoutMs: 2000  # 对照组改为 2800
```

实际预算为 `min(cap, 当前检索剩余期限)`，自动 recall 与 `memos_search` 仍最多 3000ms。
记录 attempted/succeeded/failed/skipped、outcome、错误码、端到端延迟及预期记忆是否命中。
语料需包含相关与不相关候选，比较保留/误保留情况；不能只看响应有无报错。
超时观测是右删失数据，不能把 2000ms 超时当真实完成耗时算 P95。
汇总中的 P50/P95 **只覆盖成功完成样本**，必须同时报告失败数和总样本数。
若全部超时，应写“该期限内无成功完成”，不能据此断言真实 P95=2000ms。

## 5. Q9：已完成 turn 是否在退出前落盘

使用默认轻量模式先隔离问题。每轮以唯一合成标记提问，例如 `Q9-SERIAL-001`，
确认 agent 的答案已完成后，再按组别关闭；不要在一条消息内放多个标记替代多个 turn。

| 组别 | 样本 | 操作 |
| --- | --- | --- |
| 单进程串行 | 10 次独立运行 | 每次一轮，正常退出，核对每轮 trace |
| 双进程同库，Viewer 关闭 | 20 对 | 同时启动两个 CLI 进程，共用同一 MemOS home，每个一轮，正常退出 |
| 双进程同库，Viewer 开启 | 20 对 | 同上，使用默认 failOnStartupError=false，允许其中一方 Viewer 绑定失败 |
| 真实 Desktop 常驻对照 | 至少 10 个完成 turn | 保持进程运行，核对 trace 后正常关闭，再核对 |

每个已完成且有用户文本的 turn 应能对应 `turn.ended → capture.queued → capture.started`
`→ capture.prepared（或 prepare_failed 后的惰性兜底）→ capture.committed(traceId)`。
正常收尾再核对 `dispose.started/progress/finished` 与 `diagnostics.closed`。
`capture.committed` 表示该 turn 的 core 调用已返回，不表示 L2/L3/skill 均完成。
保留退出期间仍未结束的模型调用；`dispose.progress.phase=core_shutdown` 可用于定位后续排空。

每个进程分别记录 PID、sessionId/turn、命令、答案完成时间、关闭/退出时间、退出码，
核对 Viewer/DB 中对应 traceId。Viewer 可用时保存 counts，退出后需要检查时只读核验，
不要把查询或清理过程当补写修复。首次发现缺失立即保留现场，再用相同条件重复。
Ctrl+C、取消和强杀另开独立组，不能与正常退出混算。
仅 `closed + trace_ids=[]` 不能判“丢失”，必须能证明对应用户 turn 已完成。

## 6. Q11：端口占用时的预期

用独立监听程序预先占用 18801，同样执行一轮对话，分别验证：

| 配置 | 预期 |
| --- | --- |
| `failOnStartupError: false` | Viewer 记录 EADDRINUSE/不可用，内存捕获、召回、工具继续；释放端口后可在有限重试窗口内恢复 |
| `failOnStartupError: true` | MemOS 插件启动拒绝并回滚；若 DSH 将其视为 optional，DSH 进程仍可继续，此时没有记忆服务 |

第二行不能作为“插件静默成功”的预期；应核对 startup_failed、宿主 startup audit 和工具是否存在。
该开关不负责把 MemOS 变成宿主 required plugin。记录两个组的插件挂载状态、是否有 trace、
宿主退出码与告警，不要求 true 一定使整个 Desktop/CLI 退出。
这项主要核对默认降级和文档语义，不需要先改宿主才补测其他问题。

## 7. 统一回传材料

每个用例单独目录，包含版本与提交/包哈希、脱敏配置差异、测试步骤/命令、
每个进程完整诊断 JSONL、结果表及相关时间点/退出码。不要只回传 grep 后的 WARN 行。
不要发送 credentials、API key、真实用户对话或整个生产数据库。

可在插件源码目录执行以下命令汇总拷回来的诊断文件：

```powershell
node scripts/summarize-dsh-diagnostics.mjs C:\test\case-logs > C:\test\case-summary.json
```

也可在 Windows 被测 profile 中运行包内脚本（替换真实的 logs 绝对路径）：

```powershell
dsh plugin --profile web exec node node_modules/@memtensor/memos-local-plugin/scripts/summarize-dsh-diagnostics.mjs C:\memos-test\diag-case\memory\logs
```

汇总按 runId + seq 去重、按 PID/runId 分组，输出普通过滤/探针、成功耗时分位数、
捕获已提交/失败/待完成数、未完成 host 调用及收尾标记。
`errorEvents` 是错误事件数，一个调用可在不同阶段重复记录，不能当独立失败请求数。
报告检查 parseErrors、sequenceGaps、truncated；异常时必须保留原文件说明完整性。

建议结果表列：`用例 / GUI或CLI / 提交+包哈希 / PID+runId / 模式与模型 / 完成turn数`
`/ committed与缺失trace / filter attempted成功失败跳过 / 探针分组 / 退出方式+退出码 / 诊断文件名`。
以这些证据确定 Q9/Q10 修复位置，并决定 Q2 默认 cap 是否应调整。
