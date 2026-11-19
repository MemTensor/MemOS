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


## 2026-11-18：Agent＋项目绑定准入与历史补传

- 完整回归：307 项，303 通过、4 项既有宿主环境测试跳过、0 失败。`typecheck`、`lint`、`build`、`git diff --check` 通过。
- 隔离 HTTP＋Mock：未绑定不入库；绑定后扫描不导入正文；点击历史上传才入库并发送；重复点击幂等；新增 Space 仅补缺失目标；暂停排队与恢复发送；最后解绑拒绝新工作且旧详情保留。
- 绑定边界：进行中轮次只采新增内容；重绑不补采停用间隙；读云或上传等待中解绑不会复活旧工作；不同 Agent 与跨目录子会话路由隔离。
- 实际数据库迁移及修复前均备份。构建触发宿主自动更新时，发现旧 Codex reader 过滤会使旧轨迹丢失来源关联；已停服，从自动迁移前快照恢复来源关联，保留更新后的新增正文，并修复重绑后的冻结逻辑。恢复演练及上线后复核：旧轨迹 session/conversation 关联变化为 0，已确认上传快照变化为 0，既有 272 条孤立来源没有新增。未删除历史记录。
- 备份：`~/.memos-project-memory/backups/before-binding-activation-1795007581803.sqlite`；最近迁移前快照：`~/.memos-project-memory/memory.sqlite.before-agent-bindings-1795007838149.sqlite`；恢复前含新增内容快照：`~/.memos-project-memory/backups/before-source-association-recovery-1795008017094.sqlite`。
- 本地 API v4 已在原端口 60500 运行；Viewer 实际核验“历史会话上传”列、Agent＋项目行、已完成扫描后的可用按钮。当前 Codex 与 DSH 两个 scope 扫描均 ready。原暂停上传设置保留，没有点击实际历史上传。
- 已更新现有 Codex 和 DSH 接入及 Skill。已运行的 DSH 进程需重启以重新加载原生扩展。
- 边界：真实云端未做新增上传验收；无可验证原生历史读取器的宿主只支持补传插件已采集完整轮次，界面明确提示范围；整轮超出既有上传容量仍保留 blocked，不截断内容。


## 2026-11-19：历史上传完成与失败状态

- 完成显示灰色禁用“已上传历史”；暂停、配置缺失、连接不一致、发送失败、超限或云端处理失败显示红色禁用“上传历史失败”，同时显示原因。扫描失败仍单独提供重试扫描。
- 使用现有配置与逐Space回执推导状态，仅补充history.uploadError；无新配置、数据库表或依赖。已成功历史不会因后来暂停而被误标失败；被成功补传覆盖的旧失败回执不再阻塞展示。
- Viewer保留POST/网络错误，不被后续状态刷新或成功提示覆盖。实际localhost页面已核验红色禁用按钮及暂停说明。
- 完整回归最终316项：312通过、4项既有跳过、0失败；typecheck、lint、build、diff检查通过。首次全量运行有一项既有并发启动端口用例波动，单独10项runtime测试及最终全量重跑均通过。
- 当前本地paused=true保持不变，2项历史投递仍pending、attempts=0、无接收确认。本次没有解除暂停或发送用户历史。配置默认paused=false，上传错误不自动修改该开关；现有配置没有变更审计，无法追溯最早开启暂停的操作者及时间。

## 2026-11-19：Agent 项目缓存与轻量刷新

- 仅已完成接入的 Agent 可以发现项目；当前 Agent 的请求只检查其自身接入状态。首次无缓存时发现，之后复用后台服务缓存；显式刷新合并新增目录。Claude、Pi、DSH 的项目目录取得有效头部身份后不再逐会话读取。未绑定项目不读取历史正文。
- Viewer 为各 Agent 保留项目列表及选择；刷新期间保留可用选项，绑定/解绑只合并绑定状态。项目页使用 GET /api/bind，不再等待会话、标题、完整批次与检索数据；版本探测只在 Agent 接入页执行。GET /api/adapters/installed 只读取接入元数据。
- 新项目首次绑定后台扫描历史；已知项目只从 SQLite 更新已完成轮次索引。新增 Space、状态轮询及普通刷新不重扫宿主历史；提供显式“扫描历史”操作。服务重启后项目缓存重新建立，已有 scope 先使用 SQLite 索引，未导入历史可手动扫描。无新增数据库表、依赖或定时任务。
- 修改范围：src/adapters/{projects,installer}.ts、src/server/{service,http,history}.ts、viewer/{app,view}.js；新增 tests/core/project-cache.test.ts、tests/viewer-project-cache.test.ts，并更新 bound-codex-history、multispace、viewer-history 与 viewer 回归；同步 README、contracts 与 local-api 文档。
- 新增回归先在旧实现失败；最终全量 327 项，323 通过、4 项既有 DSH 环境测试跳过、0 失败。typecheck、lint（语法检查）、build、git diff --check 通过。测试使用临时宿主目录、临时数据库与隔离 HTTP 服务。
- 浏览器工具不可用（没有可用 browser/native surface），未完成真实浏览器交互验收；项目选择、缓存、刷新期间可用性、切换恢复、过期响应与绑定状态通过 DOM/VM 交互回归和实际 HTTP 测试验证。未重启现有服务、未修改宿主接入配置、未发送真实云端请求。源码构建已更新，重新通过 Viewer 入口打开后受管服务会检查构建版本。


## 显式新建 Space 与项目绑定（2026-11-19）

- 沿用已采纳的 Viewer 草稿：Agent／项目选择在上方，下方切换新建与已有 Space；新建必须输入名称并确认，请求期间锁定目标与重复提交。成功后更新绑定关系；名称、完整 ID、复制与解绑复用原 Space 列表。已检查桌面与 390px 手机断点，并修正窄屏目录和历史提示的列对齐。
- 扩展已有 `POST /api/projects` 与 `bindProject`，只增加必要的 `spaceName`，与 `spaceId` 互斥。创建请求只有 `space_name`；直接用创建响应的 ID、名称调用既有 Store 事务，不再查询一次 `get/space`。无新增依赖、数据库表、字段或迁移，无任意名称长度常量、创建重试队列或补偿删除。
- 创建成功但绑定失败时 HTTP 保留已知 ID，Viewer 转到已有 Space 绑定并保留该 ID；创建失败保留输入，结果未确认不自动重试。成功提交后即清空输入，后续刷新失败会明确提示已保存，避免误操作再次创建。
- 本地 API 由 v4 升到 v5，继续使用现有版本与构建标记升级机制。原因是旧进程可能读取新 Viewer 静态文件，却将 `spaceName` 当作纯项目注册并返回假成功。回归先证明旧实现接受 v4，再证明新版拒绝 v4、接受 v5；真实浏览器也观察到旧实例的更新提示。

### 本轮修改文件

- 产品：`src/server/service.ts`、`src/server/http.ts`、`src/runtime/revision.ts`、`viewer/index.html`、`viewer/app.js`、`viewer/style.css`、`viewer/view.js`。
- 新增测试：`tests/core/create-space.test.ts`、`tests/viewer-space-create.test.ts`。
- 适配既有测试：`tests/core/http.test.ts`、`tests/core/runtime.test.ts`、`tests/viewer-history.test.ts`、`tests/viewer-project-cache.test.ts`、`tests/viewer.test.ts`。旧布局哈希改成新布局结构与行为要求。
- 文档：`README.md`、`docs/local-api.md`、`docs/contracts.md`、本文件。

### 实际验证

- 后端新增6项测试先全部失败，再实现后通过。Viewer新增模式、确认、取消、防重、恢复及刷新失败测试也先验证缺失行为；没有将 Mock 创建接入到真实个人数据目录。
- 最终 `npm test`：340 项，336 通过、0 失败、4 跳过。4项跳过仍是缺少 `MEMOS_PM_DSH_ROOT` 的既有真实组件组合测试，不作为本功能的验收证据。
- `npm run typecheck`、`npm run lint`、`npm run build`、限定插件目录的 `git diff --check` 均通过。lint 仍仅代表语法检查。
- 真实 Viewer＋独立本地 Mock HTTP 联调：取消确认后创建请求为0；确认一次后创建请求为1，body仅 `space_name`；列表中出现绑定，Space详情显示完整名称和返回的ID。
- 在同一独立测试 SQLite 上重启服务、刷新页面，原名称与ID完整保留。随后用编译后的 API v5 在新进程打开该数据库，再通过 Viewer 新建第二个 Space，关系从1个变为2个，不覆盖原空间；重启编译后服务并重新读取，两个名称及ID仍一致。Mock重建时显式预置前一阶段fixture空间，以保留对外服务端fixture状态；持久化证据来自原SQLite重新打开，不是重新提交绑定。
- 任务工作区 `drafts/space-create-mock-evidence.json` 保存实际创建请求和重启后的绑定；`space-create-viewer-implemented.jpg` 为最终绑定页，`space-persisted-mock.jpg` 为首次重启后的名称／ID详情，`space-mobile-mock.jpg` 为窄屏检查截图。
- 验证仅覆盖 Mock，不代表真实 MemOS 联调或22宿主完整实机验收。创建请求超时的远端结果仍可能未知；不声称云端创建与本地事务具备原子性或严格幂等。没有打包、发布或修改用户现有记忆库。
