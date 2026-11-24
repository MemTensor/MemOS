# 项目概览缓存

概览按既有 Agent＋项目范围、云连接和 Space 分开保存在 SQLite。`project_overviews` 唯一键为 `(scopeId,connectionId,spaceId)`，内容 `data` 和上次成功时间 `fetchedAt` 均可为 null。未获取与成功返回空主题列表有区别。旧 `sessions.overview` 字段保留兼容，不再作为概览来源，不反拆旧合并文本。

## 刷新与消费

- 新建／绑定 Space 成功后立即读取该 Space 的 `get_memory` 第1页、10条，覆盖对应缓存；云端失败保留成功绑定，记录既有诊断，保留旧数据与成功时间。
- 对话内创建／绑定通过原响应的 `data.overview` 返回当前项目各绑定空间的合并概览。null 表示尚无成功数据；空字符串表示已有成功缓存但无可注入主题。重复绑定沿用缓存；创建结果重放时按当前绑定重新投影概览，不返回已解绑内容，不重复创建。
- `POST /api/events` 收到可靠 `session-start` 后检查各 Space。未获取或距上次成功超过6小时才刷新。恰好6小时仍使用缓存。
- 已确认阻塞的宿主等待各 Space 并发刷新、落库后返回；非阻塞宿主先返回刷新前的缓存，后台覆盖。没有新增请求等待参数、TTL配置或周期刷新任务。
- `overview()` 只读 SQLite；普通用户轮、工具调用、结束通知不触发云概览请求。会话开启无需用户轮、正文或上传批次。
- 同一绑定并发刷新共用现有 `overviewLoads`；绑定时间区分解绑重绑。请求返回后复核连接、配置修订与绑定，失效结果不落库。解绑事务删除对应缓存，晚到结果不能恢复它。

## 宿主能力与交付

`AdapterProfile.sessionStartBlocking` 只为已核实的 Claude Code 和 Codex CLI 设为 true；未核实宿主默认非阻塞，不由 retention 推断。

- [Claude 同步与异步 Hook](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)
- [Codex Hook](https://developers.openai.com/codex/hooks)
- [Cursor SessionStart](https://cursor.com/docs/hooks#sessionstart)

现有安装器仅将已核实阻塞宿主的 SessionStart 等待预算设为20秒，普通Hook维持10秒；云请求仍使用既有15秒超时。已安装接入配置需通过 Viewer 更新才能应用安装器变化。

纯会话开启还没有本地任务会话 ID 时，复用 `create_hosts` 身份元数据的 `overviewDelivered`，不创建虚假任务。原 `/api/context-delivery` 同时接受已有 `{sessionId}` 或 `{agentType,nativeSessionId}`。交付后首个真实用户轮继承标记，避免重复注入；同一原生会话收到新的开启信号会重置本次交付，再按原方式确认。确认只表示交付宿主，不保证模型已消费。

没有可靠开启信号的入口不把每轮 turn-start 冒充 session-start。现有 DSH 实时入口、OpenCode v2 当前事件流、Cline setup、Prime 原生 Skill 暂无该信号；其概览仍可读绑定时已保存的缓存，不会因此增加定时刷新。其他入口继续使用其已有真实开启事件。

不做 Topic 结果复查，不改变主动记忆检索、轨迹采集和上传。
