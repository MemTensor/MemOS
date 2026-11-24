# 对话创建项目空间

用户明确提出创建要求是操作授权。独立 Skill 按 name、domain 的顺序，分别一轮补齐缺失项；已明确的项目不重复询问，无默认值，两项齐全才调用 `memos-pm create`。交互轮之间使用最新创建上下文，不沿用此前的轮次标识。

## 身份接口

`POST /api/create-context` 接收纯宿主元数据：`agentType,nativeSessionId,cwd,event,nativeTurnId/turnKey,parentNativeSessionId?,occurredAt?`。不传任务正文、records 或 raw。返回 `{createContext,createIdentifiers}`，没有可靠当前轮时两者为空。只有真实 `turn-start` 签发当前 token，工具／模型步骤沿用当前轮；结束通知撤销 token，旧提交和旧结束通知不回滚当前身份。

这条路径不依赖 Space 绑定，不创建业务 sessions/tasks/traces，也不调用云端。项目目录由宿主 session 确定并固定；Codex 额外只读原生 `session_meta` 头确定目录与主／子来源，矛盾或头缺失不使用工具 cwd 兜底。原生扩展和 Hook 只向服务发送白名单元数据。Prime 从 `RLM_SESSION_ID` 指定的原生记录提取身份、当前用户轮及源时间；Antigravity 从 Hook 指定来源流式投影原生用户 ID、角色及时间，不能识别或文件半写时拒绝，均不传正文。

## 创建接口

`POST /api/create {context,name,domain}` 使用当前 token 解析 Agent 和项目，不接受 root、project-root、agentType、Space ID 等覆盖参数。名称须非空，领域去除首尾空白后为 1–24 个 Unicode 字符。

业务响应为 HTTP 200 的 `{ok,status,data,error}`。成功 `CREATED` 返回 `spaceId,spaceName,agentType,root,projectId,scopeId,uploadStartsNextTurn:true`。错误包括 `INVALID_INPUT,CONTEXT_MISSING,UNAVAILABLE,CREATE_UNCERTAIN,BINDING_FAILED`，已知云端空间编码放入 `error.spaceId`。元数据格式错误仍为 HTTP 400。

创建复用 Viewer 的 `PluginService.bindProject`：相同的配置、Domain、20 个 Space 上限、云连接检查、创建 API、绑定事务与历史扫描条件。新绑定和下一轮准入边界在同一 SQLite 事务内提交，失败回滚本地绑定并保留云端已知 ID。既有绑定不替换，不自动上传历史，不更改 Viewer 的原有绑定时刻规则。

当前轮首次创建请求在网络调用前持久化。相同参数的并发请求共享执行，后续同轮重试及重启返回原结果；参数改变不在同轮再建。进程在请求后崩溃、超时或无法确认响应时，不自动重发创建请求。真实云端不假设支持幂等键。

## 上传边界

创建命令所在轮的全部 Space 投递均跳过，包含命令前已保存的任务输入、创建后的回答和迟到子任务。以原生轮次身份、用户轮开始时间与执行完成边界对账，并持久化确认的排除归属；后续用户输入、源补读或服务重启不重新授权这些结果。

对话创建的新 Space 仅接收绑定完成后开始的完整用户轮；已有其他会话在绑定前开始、绑定后完成的轮次不将后半段发送给新空间。批次生成、实时排队、历史排队和发送前共用排除规则。未绑定项目始终不调用 `add/message`。暂停仍只控制发送。

`create_hosts/create_contexts` 仅保存身份、轮次、请求状态和创建结果，`create_space_boundaries/create_turn_exclusions` 保存投递边界及确认的归属，不保存任务正文。首次为有业务数据的旧库添加表前生成 `memory.sqlite.before-create-contexts-*.sqlite` 备份；既有轨迹和已接收请求不重写、不重传。

## 验证范围

回归覆盖服务 HTTP、CLI 子进程、真实 Hook 子进程到隔离 Mock、多 Space、重启、并发、迟到事件、子任务、历史绕过、源轮次与通知标识差异、Prime 原生下一轮工具过程和双 Skill 安装管理。Fixture/Mock 不替代全部宿主的真实模型交互或真实 MemOS 验收。
