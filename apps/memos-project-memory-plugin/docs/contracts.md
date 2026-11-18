# 实现契约

## 身份、路由与上下文

- `sessionId`：本地 UUID，唯一对应 `(agentType, nativeSessionId)`。
- `conversationId`：当前用户输入轮的本地 UUID，稳定边界为原生 turn ID 或宿主用户提交事件。工具循环不产生新轮。
- CLI 必须匹配会话当前轮；缺失或旧轮不回退“最近会话”。
- 项目按工作目录最长路径匹配；项目内多会话、不同 Agent 共用同一 Space 列表，独立任务自行绑定。原生父会话 ID 单独保留。
- Viewer 轨迹页优先按已保存的项目 ID 分组；未登记项目但已有可靠绝对 `cwd` 的主会话，按完整目录显示本地项目，名称取目录末段，不要求先绑定 Space。同名不同目录分别展示；缺少可靠目录的会话仍列为“未归属项目”。目录分组仅用于展示和筛选，不写入项目表、不改动任务归属或上传空间。
- Codex 主会话目录以原始 `session_meta.cwd` 为准，轮次或工具执行目录不覆盖会话归属。采集对账在源目录可靠且无冲突时纠正历史 `sessions.cwd` 和未登记项目的任务名称，保留会话、任务、Space 与上传批次身份；多个源目录矛盾或与已登记项目冲突时记录诊断并保留原归属。启动后的首次采集即对账，无需等待新消息；旧读取缓存复用现有版本机制升级，正常追加与源文件替换仍分别处理。
- Viewer 通过 Agent 筛选已有项目及目录，输入 Space ID 后校验并追加到列表。复用 `name/root/spaceId/objectId/agentType`：`bindings` 以 `(objectId,spaceId)` 唯一保存每条关联，`project_agents` 保存项目与已有 `agentType` 的关系。接入已有独立会话时合并其空间、任务和批次；跨云连接或创建结果待确认时整体回滚。
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
- 上传 POST `add/message`：`user_id`、稳定 profile `agent_id`、全部当前绑定的 `space_ids`、`messages`、`allow_memory_view:["project"]`、`async_mode:true`。空列表的已登记项目保持待上传，不自动创建 Space。
- 不传 `domains`，不传云端 `session_id` / `conversation_id`，不添加未经确认的幂等头。
- 每批最多发送两次，发前持久化次数。接收必须 `success:true` 且含 `task_id`，随后 `uploaded=true`。处理失败保留此确认；两次失败终止，重启/暂停恢复不重置。
- 首次发送持久化目标列表；重试仅保留快照内仍绑定的目标，不向已解绑空间发送。不因后来新增 Space 而重发已接收批次。
- 采集只写入轨迹，不创建上传任务。宿主明确结束整轮任务后，按 `conversationId` 读取完整有序消息，生成一次不可变上传快照；上传端直接使用该快照，不再次拼接。重复结束通知、重复回放和服务重启不重复建任务。
- 一轮轨迹对应一个上传批次。整轮超过当前 UTF-8 保守容量时保留为一个 blocked 任务，不拆分、不截断。
- 轮次批次升级先生成 `memory.sqlite.before-turn-batches-*.sqlite` 备份；从未发送的旧采集片段恢复为待确定轨迹，在收到真实结束信号后创建整轮任务。已尝试/已接收的旧批次保留原发送历史，不重组重发。
- 创建 Space 失败可能结果不明，保持本地 uncertain，避免自动制造新空间；未实现人工协调工具。

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
