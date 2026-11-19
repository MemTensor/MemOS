# 实现契约

## 身份、路由与上下文

- `sessionId`：本地 UUID，唯一对应 `(agentType, nativeSessionId)`。
- `conversationId`：当前用户输入轮的本地 UUID，稳定边界为原生 turn ID 或宿主用户提交事件。工具循环不产生新轮。
- CLI 必须匹配会话当前轮；缺失或旧轮不回退“最近会话”。
- 项目按工作目录最长路径匹配；同一 Agent＋项目共用 Space 列表，不同 Agent 独立绑定。原生父会话 ID 单独保留。
- Viewer 轨迹页优先按已保存的项目 ID 分组；未登记项目但已有可靠绝对 `cwd` 的主会话，按完整目录显示本地项目，名称取目录末段，不要求先绑定 Space。同名不同目录分别展示；缺少可靠目录的会话仍列为“未归属项目”。目录分组仅用于展示和筛选，不写入项目表、不改动任务归属或上传空间。
- Codex 主会话目录以原始 `session_meta.cwd` 为准，轮次或工具执行目录不覆盖会话归属。采集对账在源目录可靠且无冲突时纠正历史 `sessions.cwd` 和未登记项目的任务名称，保留会话、任务、Space 与上传批次身份；多个源目录矛盾或与已登记项目冲突时记录诊断并保留原归属。启动后的首次采集即对账，无需等待新消息；旧读取缓存复用现有版本机制升级，正常追加与源文件替换仍分别处理。
- Viewer 通过 Agent 筛选已有项目及目录，可输入 Space ID 后校验追加，或输入 Space 名称并确认后显式创建并绑定。复用 `name/root/spaceId/objectId/agentType`：`bindings` 以 `(objectId,spaceId)` 唯一保存每条关联，`project_agents` 保存项目与已有 `agentType` 的关系。接入已有独立会话时仅迁入对应 Agent 的会话归属，旧独立空间不自动成为新授权；跨云连接或创建结果待确认时整体回滚。
- 列表可以为空；解绑只删除指定关联，最后一个删除后保留 unbound 空标记，避免自动创建替代空间。历史批次及原文保留，新的检索与上传仅使用当前绑定。
- 旧单 Space 数据升级前生成 `memory.sqlite.before-multi-space-*.sqlite` 恢复快照；旧关联及批次目标迁入列表，批次 `spaceId` 列替换为 JSON `spaceIds`，不同时维护两套参数。
- `get/memory` 是单 Space 接口，初始化按各绑定空间读取第 1 页、10 条并合并概览。主动 search 始终一次请求携带完整 `space_ids` 列表。绑定变化使本地概览缓存失效；已交付历史消息不回删。
- `/api/context-delivery {sessionId}` 标记已向宿主交付，不代表模型已消费。history 宿主首次交付概览，后续只更新标识；request-view 宿主每次附加本地缓存。读云次数不随工具轮次增加。
- DSH 的动态标识通过 `systemPrompt.context()` 注册为 `memos-project-memory:call-context`（order 220、required、禁止模板插值），按当前 Agent/session 读取隔离缓存；异步 pre-step 登记身份后，由宿主请求前 `refreshContext()` 更新运行快照。适配器不再追加仅含标识的独立 user 消息，也不改写 Skill 目录。
- DSH 的初始概览作为一次性历史资料交付，与动态参数分开。只有观察到同一会话中对应消息 ID 的 `user/message` 提交后才确认 delivered；被拒绝或丢弃的候选不确认。历史快照的替代语义由 DSH 维护，不删除既有会话记录。

## 上传

- 轨迹仅保留真实用户任务、工具调用与结果、助手回复。系统提示、插件/宿主注入内容、权限与运行配置、生命周期、标题生成、交付/上传状态不进入 `traces`，也不进入上传消息。未知且无法识别为上述三类的事件不以 JSON 兜底上传。
- 有效轨迹保留正文及工具名称、参数、结果；DSH 嵌套助手消息正确解析，同一原生用户消息按稳定消息 ID 去重，不按正文去重。Viewer 只读取同一规范化消息，上传状态独立保留在批次管理中。
- 旧版数据库首次升级会先生成 `memory.sqlite.before-task-traces-*.sqlite` 恢复快照，再清理旧轨迹并重建尚未获云端接收确认的批次；保留批次重试次数。已接收批次的历史发送记录不改写、不重发，也不会自动删除云端既有数据。
- 上传 POST `add/message`：`user_id`、稳定 profile `agent_id`、当前目标的 `space_ids:[spaceId]`、`messages`、`allow_memory_view:["project"]`、`async_mode:true`。未绑定时不采集、不入库、不建新上传任务，也不自动创建 Space。
- 不传 `domains`，不传云端 `session_id` / `conversation_id`，不添加未经确认的幂等头。
- 每批每个 Space 最多发送两次，发前持久化次数。接收必须 `success:true` 且含 `task_id`，随后 `uploaded=true`。处理失败保留此确认；两次失败终止，重启/暂停恢复不重置。
- 首次发送持久化目标列表；重试仅保留快照内仍绑定的目标，不向已解绑空间发送。不因后来新增 Space 而重发已接收批次。
- 采集只写入轨迹，不创建上传任务。宿主明确结束整轮任务后，按 `conversationId` 读取完整有序消息，生成一次不可变上传快照；上传端直接使用该快照，不再次拼接。重复结束通知、重复回放和服务重启不重复建任务。
- 正常完成轮次保留一个原始上传快照；历史补传或绑定时间裁剪通过补充批次投递缺失内容，保留原快照。整轮超过当前 UTF-8 保守容量时保留为一个 blocked 任务，不拆分、不截断。
- 轮次批次升级先生成 `memory.sqlite.before-turn-batches-*.sqlite` 备份；从未发送的旧采集片段恢复为待确定轨迹，在收到真实结束信号后创建整轮任务。已尝试/已接收的旧批次保留原发送历史，不重组重发。
- 采集和上传通路不创建 Space。Viewer 中只有用户明确确认新建时才调用 `create/space`，且只传 `space_name`；直接使用返回的 ID、名称复用既有绑定事务，不额外查询 `get/space`。创建成功但绑定失败返回已知 `spaceId`，供普通绑定恢复；创建结果未确认不自动重试。历史创建结果不明的遗留记录仅保留审计。

## 绑定准入与历史补传

- 项目选择只发现已完成接入的 Agent；各 Agent 独立保留服务内存项目缓存。首次无缓存才发现，显式刷新才重新读取目录/项目索引并合并新增项。页面重绘、绑定和解绑不清空列表、不触发项目重扫。项目页单独读取绑定关系，不等待会话标题、轨迹或全部宿主版本探测。
- 新 Agent 项目首次绑定后后台扫描历史；未绑定不读取历史正文。已有 scope 的状态刷新只合并 SQLite 中的已完成轮次，不因新增 Space 或新轮次重扫宿主历史。手动“扫描历史”可更新原生来源索引，扫描不上传。服务重启后，项目元数据缓存首次读取重建，已有 scope 的历史概览先使用 SQLite 记录，不自动重扫未导入的宿主历史。

- `project_agents.id` 是 Agent＋项目 scope；不增加独立 enabled 开关。当前 Space 列表非空才启用记忆。`bindings.boundAt` 记录各目标加入时刻，`capture_windows` 记录启停边界。
- 未绑定只发现项目元数据。适配器预检与服务端同时守住采集、注入、检索、上传入口；未启用是正常状态，不写诊断事件。已解绑的会话保留在 Viewer 中。
- 自动采集只接受当前启用窗口内有可靠时间的内容。实时回调缺少原时间时可用接收时间；历史回放不得补当前时间。新增 Space 只自动接收其绑定后的内容。
- 历史扫描目录及来源索引与上传成功分开。扫描不把历史正文写入 SQLite，显式上传才导入完整轮次。无法读取全部原生历史时必须展示范围提示。
- `batch_traces` 关联批次与来源轨迹；`batch_deliveries` 按批次＋云连接＋Space 保存尝试次数、接收确认和处理状态。成功目标不重复上传，失败目标可通过历史按钮补传。
- 解绑取消对应未发送目标；已发网络请求仍记录真实回执。重新绑定不恢复已取消队列，同一 Space 既有成功回执持续有效。
- 迁移备份为 `memory.sqlite.before-agent-bindings-*.sqlite`。只迁移明确存在的 Agent 关联，保留历史内容与已发送批次，不凭旧项目目录自动启用其他 Agent。

## CLI JSON

成功：`{ok:true,status:"FOUND"|"EMPTY",data:{topics:Topic[]},error:null}`。
失败：`{ok:false,status:"INVALID_QUERY"|"CONTEXT_MISSING"|"UNAVAILABLE",data:null,error:{message:string}}`。

Topic 投影：`id,title,summary,description,decisions,experiences,timeline,relativity,updateTime`。决策/经验的作者、时间、history/conflicts 保留原始嵌套归属，不提升到全局混合列表。不返回 Space 路由字段、sources、云端诊断或配置 Key。

## 云端待核对

六接口当前共用 POST JSON 与 `{code:0,data}` 响应封装。`add/message` 文档参考已核对，其余未完整明确的方法/字段按接口清单的暂定契约实现，Mock 验证不构成生产接口证明。

1. 省略 domains 合法，不等于新建的空领域 Space 一定允许项目写入。
2. 工具返回、特殊事件、结构化多模态内容及工具关联字段的真实服务接收/保留能力未证实。不能以本地原文完整推断云端完整。
3. 40k token 单条超限、云端幂等与完整任务状态枚举待服务端确认。
4. 真实 Key 未提供，尚未执行实际创建/上传/检索联调。

## Viewer 轮次分页

`GET /api/sessions/:id?unit=turn&page=1&size=10` 返回完整轮次的 `groups: [{ id, traces }]`，`total` 为分组数量；以存储的 `conversationId` 归组。缺少轮次标识的记录独立保留，避免错误合并。省略 `unit` 时沿用逐条轨迹分页。此变更不修改采集和上传内容。

## Viewer 轨迹分类

显示类型为 `user`、`tool use`、`tool result`、`thinking`、`answer`，均采用独立白色折叠框。依据消息块类型及显式 reasoning/thinking 字段、analysis channel 分类；不从自然语言猜测思考与回答的边界。宿主未提供思考内容时不生成 thinking，明确的 redacted_thinking 只显示不可读提示。图片、附件保持所属消息分类，工具错误属于 tool result。此分类只改变展示，不重写已存消息或上传内容。

## 轨迹确定信号

- Hook：Stop/stop、Copilot agentStop；SessionEnd 可结束会话中剩余轮次。SubagentStop 只结束对应子会话。
- DSH：turn/end；Pi：agent_settled；Prime：agent_end；Cline：afterRun。
- OpenCode V1/Kilo：session.idle/status=idle；V2：execution succeeded/failed/interrupted，shutdown 中断留待恢复。
- 工具结束、模型步骤结束不确定整轮轨迹。所有最终记录须先保存，再发送 turn-end。
