# 开发验证记录

日期：2026-11-17。环境：macOS，Node 26.4.0，npm 11.17.0。结论：公共链路可运行，开发包可独立安装；**未完成方案要求的全量真实环境验收**。

## 已执行

| 检查 | 结果 | 证明范围 |
|---|---|---|
| `npm test` | 40/40 通过 | SQLite、路由、轮次、上传确认、失败次数持久化、上下文保留、全部适配 profile 的针对性协议测试、Mock、Viewer |
| `npm run typecheck` | 通过 | src/tests/dev 严格类型检查 |
| `npm run lint` | 通过 | 源码语法检查；不是 ESLint 全规则扫描 |
| `npm run build` / prepack | 通过 | TypeScript→独立 JS，入口、资源路径转换 |
| `npm run test:package` | 通过 | 临时干净 npm 安装；编译后后台服务、四项 Viewer 资源、实际 HTTP 上传、CLI 五状态与退出码、Hook/native loader、共享 Skill 引用 |
| Viewer 实际浏览器 | 通过 | 创建项目、首次绑定、会话/工具原文、上传状态、检索、暂停恢复、22 Agent 列表，无控制台错误 |
| 独立架构审查 | 通过 | 当前未发现未修复的正常主链路阻断；复跑40测试及类型检查 |
| 限定精简后回归 | 通过 | 删除未用游标表/变量/别名；公共代码格式化，无新增功能或依赖 |

Mock 使用真正 HTTP，与插件业务服务分进程/实例；不做模型记忆抽取。Hook 测试使用真实 Node 子进程 stdin→本地 HTTP→宿主协议 stdout；Prime 采用真实子进程 JSONL 协议测试。这些都不替代实际宿主模型执行证据。

修复且有回归：空会话生命周期记录不触发建空间；已有真实消息的子代理可上传；历史 native turn 不覆盖当前轮；最多两次发送跨重启保持；云端处理失败不抹去 uploaded；tool name 不误作 role_name；Kimi 工具参数对象转 JSON 字符串。

## 尚未完成的必需验收

1. **真实 MemOS**：未提供本任务专用 Key；未创建真实空间或上传用户轨迹。省略 domains 后空领域 Space 能否写入、完整工具/特殊事件、多模态和其余接口暂定字段须真服务验证。
2. **22 宿主实机**：已实现22入口/profile，不宣称22全部支持验证。多数目标版本未安装；本机旧版 Claude/Cursor/Copilot/CodeBuddy 与目标版本不同。Codex与WorkBuddy版本匹配也仅是探测证据。
3. **入口缺口**：Grok 首token概览、Cursor异步初始化的首请求时序；TRAE CN准确build及完整轨迹、Devin完整轨迹；Antigravity真实日志中用户轮结构。这些正常链路要求仍需宿主能力/源码证据，不能计为已达标。
4. **真实模型上下文及评测集**：未获得22宿主连续两轮、多工具、Skill调用的模型侧证据；未提供评测方测试集。
5. **发布条件**：包名可用性、发布主体、许可证尚未确认；没有发布 npm。Linux/Windows及最低Node版本未实机验证。

详细逐宿主证据见 compatibility-hooks.md / compatibility-native.md。未实现闲时补传、超大单消息拆分、广泛异常恢复，符合当前边界；不是隐藏的后台重试。

## 产物与范围

- 代码：本插件目录 `src/`、`viewer/`、`skills/`、`dev/`、`scripts/`、`tests/`、`docs/`。
- 历史独立包验证已完成；2026-11-18 按开发阶段要求删除 `.tgz` 及临时打包记录，后续使用源码部署，不执行打包。
- 浏览器截图：`.omx/state/viewer/overview.png`、`agents.png`；视觉检查95分，通过。
- 未修改相邻 `memos-local-plugin`；未实际安装到用户宿主配置，未提交 Git，未发布服务。

## 从 Viewer 移出的适配器开发备注（2026-11-18）

以下为原始实现备注快照，不代表新增实机验证结果。用户操作提示保留在各 profile 的 limitations；协议、源码和验收细节仅保留在开发文档。

| Agent | 原始备注 |
|---|---|
| Codex CLI | Native /hooks trust approval required; transcript format is version-specific. |
| Cursor CLI | Enable transcripts. beforeSubmitPrompt cannot append context; sessionStart is asynchronous. |
| GitHub Copilot CLI | userPromptTransformed from rolling docs appends context; availability in target 1.0.112 requires native verification. userPromptSubmitted stdout is ignored. |
| Grok Build | First-token injection unavailable; prompt identity and transcript capture supported. Source baseline 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8 differs from release. |
| Kimi Code | New kimi-code only; remote execution needs local service bridge. |
| ZCode | Desktop profile; temporary transcript read synchronously during hook. |
| TRAE CN desktop | Desktop CN only; exact version and full transcript source unverified. Not TRAE CLI. |
| Antigravity CLI | PreInvocation is a model request, not a user turn; user turns derive from transcript message identities. |
| Devin CLI | Full assistant transcript source unverified; hook events retain available records only. |
| Deep Agents Code | Hooks v2; projection read by stable record identity. |
| WorkBuddy desktop | Local macOS desktop 5.3.14 bundles engine 2.115.0; source-verified hooks and transcript, model end-to-end validation pending. |
| OpenCode v1 | Protocol fixture verified; real host/model integration requires acceptance testing. |
| OpenCode v2 | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Kilo CLI | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Cline CLI | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Pi | Protocol fixture verified; real host/model integration requires acceptance testing. |
| Prime Agent | Protocol fixture verified; real host/model integration requires acceptance testing. |
| DeepSeek Harness | Protocol fixture verified; real host/model integration requires acceptance testing. |

## 任务轨迹范围调整（2026-11-18）

- 新规则：轨迹入库和上传只保留用户任务、工具调用与结果、助手回复。系统及临时注入提示、运行状态不生成轨迹和待上传消息。
- 修复 DSH 嵌套助手回复的角色解析；同一原生用户消息按 ID 去重。工具名称、参数和完整结果保留。
- 本机 DSH 样例迁移：24 条旧记录 → 用户任务、助手回复各 1 条，正文逐项一致；24 个待上传批次清理为 2 个，迁移前自动生成本地 SQLite 恢复快照。原样例没有工具调用。
- Mock HTTP 验证有效任务内容上传，注入内容及运行日志不上传。56 项测试、类型检查、lint、构建通过；不构成其余宿主与真实云端的全量实机认证。

## 白色轮次轨迹展示（2026-11-18）

- 轮次摘要列表 + 右侧详情；所有内容框为白色，步骤默认折叠。
- 新增回归覆盖：30 条记录的一轮保持完整、缺失轮次记录独立分组、摘要不展示完整回复、折叠保留完整正文。
- 59 项测试、类型检查、lint、构建通过；未打包。
- 本机 Viewer 实测：1 个轮次摘要包含2条记录；展开正文高度280px、内容高度508px，内部滚动；Esc关闭并回到列表；浏览器无错误日志。
- 截图保存在 `.omx/state/turn-view/`。

## 五类轨迹展示（2026-11-18）

- 62 项测试通过，新增覆盖混合 reasoning/text/tool 块顺序、thinking 字段、analysis channel、脱敏思考和多工具结果。
- 当前 DSH 会话实测 user/thinking/answer 独立展示；answer 展开时 thinking 仍收起，正文不再混合。
- 截图：`.omx/state/five-trace-types/viewer.png`。此次仅修改 Viewer 与文档、测试。

## 完整轨迹确定后创建上传任务（2026-11-18）

- 采集期间批次为0；真实结束信号到达且最终记录保存后，一轮创建一个完整消息快照。上传与重试复用快照，不再按采集次数组批。
- 78 项测试、类型检查、lint、构建通过；涵盖拆次采集、重复结束、服务重启、旧轮结束晚到、子会话、超限保留、旧发送历史保留、原生持久化回放去重。
- 本机迁移前备份：`~/.memos-project-memory/memory.sqlite.before-turn-batches-1794987526493.sqlite`。从原始备份核实 DSH turn/end（turn=1，seq=22）后补录结束信号；1轮/2个旧片段变为1轮/1个pending批次，2条消息正文逐项一致，发送次数0。
- 本地服务已重启，URL不变。DSH磁盘入口引用本仓库dist；运行中的DSH须重启以加载新的结束信号处理。未执行真实云上传。

## DSH 命名运行上下文修复（2026-11-18）

- 修复前，已对照问题会话确认 `runtime-context → memos-project-memory 裸标识 → skill-catalog` 的顺序；新增回归先在旧实现上失败。
- 动态 ID 现在进入宿主统一封装的 `memos-project-memory:call-context`，异步登记后通过 admission refresh 生效。初始化概览不混入 ID，只在实际历史提交后确认交付；确认失败可重试且不重复追加。
- DSH 专项 8/8 通过；本机 `0.2.2-rc.4` 的真实 Cordis/SystemPrompt/运行快照/Session/Skill 目录/provider 序列化组合 4/4 通过，源码入口和构建后的 dist 入口分别验证。覆盖首请求刷新、新轮、工具续推、两种注册顺序、会话隔离和服务不可用。
- 组合测试捕获离线模型请求体，驱动 admission 与本地运输为模拟，不构成真实模型执行或真实 MemOS 联调。`rc.3` 已核对官方 npm 源码的对应 API 和时序，未运行该版本。
- 最终工作树完整检查：100 项测试通过、零失败、零跳过；typecheck、lint（语法检查）、build 通过。该总数包含并行完成的项目管理测试，不将其计为本修复新增测试。本次新增 DSH 回归为 8 项单元测试和 4 项真实组件组合测试。
- 使用 `MEMOS_PM_DSH_ROOT` 显式启用真实组件测试；未指定时这四项明确跳过，不能当作宿主兼容验收通过。未执行 npm 打包、发布、数据库迁移或真实云上传。
- 独立架构审查通过；限定 ai-slop-cleaner 检查零额外修改，之后重新完成全量测试、typecheck、lint、build 和 dist 入口的 4 项组合验证。
- 已通过现有安装器修复本机 DSH 接入并更新已安装 Skill／CLI 说明，校验三个受管理文件的所有权哈希，确认 DSH 配置受管理区块之外的文本完全一致。运行中的 DSH 未被停止或重启，须由用户重启后加载新入口；既有会话历史不回写。

本修复修改范围：`src/adapters/deepseek-harness/extension/index.ts`、`tests/adapters/dsh-context.test.ts`、`tests/adapters/dsh-host.test.ts`、`tests/adapters/native.test.ts` 中 DSH 用例、`skills/project-memory/SKILL.md`、`skills/project-memory/references/cli-contract.md`、`docs/contracts.md`、`docs/compatibility-native.md`、本验证记录。

## Hook Node 稳定路径（2026-11-18）

- 仅调整公共Hook安装器的Node路径选择：验证稳定Homebrew链接与当前运行程序一致后保留链接路径；复用已生成的Kimi条目。未新增部署目录、启动脚本或配置参数。
- 97项测试通过，4项需DSH环境的集成测试跳过；类型检查、lint、构建通过。新回归模拟Homebrew版本切换、不同Node目标与无稳定链接。
- 本机Codex9项MemOS hook已更新为 `/opt/homebrew/opt/node/bin/node`，原脚本路径保留；其他hook保持一致，无重复项。Stop命令已通过隔离本地HTTP端点执行验证。
- 修改前配置备份：`~/.memos-project-memory/backups/codex-node-path-1794989897372/`。本地服务已重启，Codex需重新加载配置并按其提示复核变更的hook。
