# Local API implementation contract

## Project overview cache (API 10)

No new route. `POST /api/events` uses the existing `session-start` event and Agent identity to apply the six-hour cache rule; blocking capability is registered in the adapter profile, never supplied as a request flag. Normal events only read SQLite. Create/bind responses add `overview` (string or null). `POST /api/context-delivery` accepts `{sessionId}` or existing host identity `{agentType,nativeSessionId}` when a pure opening signal has no task session yet. See [overview cache](overview-cache.md).

## Cloud connection settings (API 9)

`GET /api/config` additionally returns `apiMode` (algorithm/engineering), `authMode` (none/token/bearer), `cloudProjectId`, `connectionConfigured` and `connectionError`, never the Key. `PUT /api/config` accepts the corresponding settings; omitted apiKey retains it, explicit empty string clears it. Invalid input does not partially change the active configuration.

`POST /api/connection-test` uses saved settings and an optional `{spaceId:string}`. It returns `{ok,reachable,verified,message,apiMode,baseUrl}`. With an existing ID it reads that space to validate protocol access; without an ID it only probes HTTP reachability. It never creates a space or uploads messages.

Binding state adds `active`, true only for a nonempty binding on the current connection with an open capture window. Retained old bindings are not counted as currently active. See [cloud access](cloud-access.md).

Dialog creation adds `POST /api/create-context` (identity-only host metadata → `{createContext,createIdentifiers}`) and `POST /api/create` (`{context,name,domain}` → CLI-shaped business result). The latter resolves routing from the current native session and reuses `bindProject`; it never accepts caller-supplied project/Agent routing. Existing Viewer routes are unchanged. See [dialog creation contract](create-project-space.md) for result states, durable no-retry behavior and full-round upload admission.

JSON over loopback. GET /api/config returns {baseUrl,userId,keyConfigured,paused}; PUT /api/config accepts {baseUrl,apiKey,paused} (never return key). GET/POST /api/projects (name,root); POST /api/bind {objectId,spaceId}; GET /api/state returns {projects,tasks,sessions,batches,recalls,diagnostics}; GET /api/sessions/:id returns {session,turns,traces,recalls,batches}. POST /api/events accepts AgentEvent, returns EventResult (src/adapters/types.ts). /api/search accepts {sessionId,conversationId,query}, returns CLI JSON. POST /api/sync manually runs pending sync (not failed batches).
GET /api/adapters lists detection status; POST /api/adapters/:id/install and /uninstall call installer. Parent implements server/storage/cloud/CLI. Hook agent owns registry/installer/hook and transcript shared; native agent owns extension/rpc dirs and tests. Viewer/mock agent owns viewer, dev/memos-mock and respective tests.
HTTP source imports .ts; build strips to JS and rewrites .ts import suffix. Node built-ins only runtime. Client helper src/adapters/_shared/client.ts exports serviceRequest<T>(path,body?,method?) and ensureService(); use it in adapter entry points. MEMOS_PM_DATA_DIR selects instance; MEMOS_PM_URL optional local service override for tests. Server state fields camelCase. Source IDs stable per native record; never hash content alone for identity. turnKey is reliable source user-message/event identity when nativeTurnId unavailable; do not assign a turn for each model/tool event.

`GET /api/state` returns batch metadata only: IDs, ownership, Space IDs, status, attempts, errors and timestamps. It does not select or parse `batches.messages`. Upload and session-detail paths continue reading complete snapshots through the existing store API; no `includeMessages` or lightweight-mode request parameter is added. Viewer routes use the existing five page names in the URL hash. A project-page bootstrap loads `/api/bind` immediately; switching to a page that needs session state loads `/api/state`. A request-order counter discards stale reload results without maintaining a second page state.

`GET /api/health` returns `{ok,service,apiVersion,runtimeRevision,pid}`. The local API version is 8; the runtime revision is captured when the server is created, so rebuilding files cannot make an old process claim the new revision. Viewer checks the API version before interpreting state. An old single-Space response must produce an explicit service-update message, never be interpreted as empty `spaceIds` or missing Agent ownership.

`GET /api/projects?agentType=<profile.agentId>` lists that agent's existing projects from supported host metadata, recorded Agent associations and captured session directories. Candidate fields reuse `name` and `root`, plus `id`, `spaceIds`, `bindingStatus` when registered. Registered parent project roots follow the same longest-directory matching as capture. A GET without `agentType` continues to list registered projects. State project rows include `agentTypes` and `spaceIds`; neither uses a duplicate singular `spaceId` alias.

`POST /api/projects {name,root,spaceId,agentType}` verifies the supplied Space via `get/space`, then registers/reuses the directory project and appends its binding atomically in SQLite. The existing `agentType` records ownership even when the Agent has no captured sessions yet. Only the selected Agent’s existing sessions and batches join the new scope, preserving raw traces, identities, payloads and send counters; old independent Space bindings do not grant new authorization. Existing nested project ownership is retained. Cross-connection bindings or uncertain creation roll back the operation. The registration-only `{name,root}` request remains available.

`POST /api/projects {name,root,agentType,spaceName,domain}` explicitly creates and binds a Space after Viewer confirmation. `spaceName` and `spaceId` are mutually exclusive; creation requires a trimmed, nonblank `domain` of at most 24 Unicode code points. Invalid input fails before any cloud request. The service calls `create/space` with `{space_name,domains:[{domain}]}`, validates the returned ID, and reuses the existing binding transaction with its ID and name, without another `get/space`. Viewer offers fixed choices 编程, 办公 and 自定义; custom entry uses a dialog with the same character limit. No `list/domains` or Mock request is made to load options. Binding an existing Space requires no Domain selection. No new local route is introduced. The registration-only request remains compatible.

Each Agent + project scope can bind at most 20 distinct Spaces. Both binding service entries reject a new target before cloud calls when full; the existing SQLite binding transaction rechecks the count to prevent concurrent overflow. Existing targets are idempotent and remain allowed; removing a binding frees one slot. Viewer checks current bindings before submission and again after creation confirmation, alerting `单个项目绑定空间不能超过20个`. The same alert handles server overflow errors while preserving any returned created `spaceId`. This is a local binding limit, not a per-user cloud Space quota. No new configuration, columns or request parameters are introduced.

Space domain mappings are internal SQLite metadata keyed by `(baseUrl,spaceId)`. Creation persists its selected domain before local binding, preserving it if binding fails. Both existing-Space binding paths retain access checks and load `list/domains {space_id}` only when the mapping is missing or empty; invalid responses, request failures or an empty list prevent a new binding. Already-bound requests also repair missing metadata. Cached names are shared across Agent/project bindings and survive restart and unbinding. External names do not inherit the 24-character local-input restriction. No new local request parameters or routes are introduced.

`add/message` always omits `domains`, allowing the cloud to use all registered domains of its target Space as candidates. Upload preparation does not read the local domain mapping or call `list/domains`; a missing local mapping cannot block an upload. Live and historical delivery share the same message projection and frozen message body. Existing domain mappings remain binding metadata only, and no new local parameters or configuration are added.

Delivery-domain snapshots are no longer created or used. An existing `batch_deliveries.domains` column is retained for compatibility but ignored; new databases do not create it. Upload-projection migration advances SQLite `user_version` to 4 once, blocking legacy attempted-but-unconfirmed requests without rewriting their messages or send counters; accepted receipts remain intact. Business code 40089 follows ordinary send failure handling without domain refresh or a dedicated retry branch. Unbinding continues to cancel blocked destinations, so rebinding cannot restore old upload authorization.

A known cloud-connection or uncertain-binding conflict rejects creation before calling the cloud. A connection change after creation prevents binding. If creation returned an ID but binding fails, HTTP 400 includes `{error,spaceId}`; Viewer preserves that ID and switches to existing-Space binding. Creation failures and unknown outcomes are never retried automatically. API v6 is required: a v5 process would silently ignore `domain` and create a Space without its selected domain. The existing managed-service upgrade mechanism replaces an old process; a stale browser prompts the user to reopen Viewer before allowing operations.

`GET /api/projects/:id/spaces` returns `[{spaceId,name}]`, resolving cloud Space names and retaining cached names on temporary lookup failure. `POST /api/bind {objectId,spaceId}` appends an accessible Space idempotently. `DELETE /api/bind {objectId,spaceId}` removes only the selected local association; no cloud deletion is performed. Empty lists preserve the project and do not automatically create a replacement Space. Existing cloud task tracking and historical payload snapshots remain intact.

`POST /api/search {sessionId,conversationId,query}` still powers the sole CLI command. The service supplies all bound `space_ids` in one cloud request. Both cloud `search/memory` and `add/message` use the persisted `session.id` as `conversation_id`, across turns, retries, restarts and historical deliveries. The local `conversationId` still validates the current input turn. Uploads omit `session_id` and task-status fields; existing `get/status` polling remains unchanged. Models do not receive Space management parameters.

`POST /api/context-delivery` accepts `{sessionId}` or `{agentType,nativeSessionId}` and returns `{ok:true}`. The adapter calls it after actually handing initial context to the host. Events return `overviewDelivered` so history hosts omit the cached overview on later turns, while request-view hosts keep mounting cached context. Delivery acknowledgement is not proof of model consumption.

Session `title` is the host's native name, never inferred from task text. Optional
`AgentEvent.title` updates that same SQLite/API field. `titleRevision` is the
host's ordering value (DSH event/checkpoint sequence; Codex index update timestamp),
so an older disk checkpoint cannot undo a live rename. Missing or blank names do
not erase a known title; unversioned updates cannot replace a versioned title.
Metadata-only `trace-available` events create neither task traces nor rounds.

The service reads Codex `session_index.jsonl` and DSH's versioned title projection
for existing session IDs during capture and viewer refresh, including names of
historical sessions and renames without new messages. The DSH extension also
forwards live `session/title` changes and the current name when resuming a session.
Other adapters without a verified native naming source remain unnamed; the viewer
uses a short session ID instead of guessing from message text. List, detail and
search all use the same native `title`. Workspace navigation is unchanged.

Session admission requires task evidence. For non-Codex hosts, an unknown session's
lifecycle/title notification does not create a session or task; a normalized task
record or an explicitly identified user submission does. For Codex, a rollout
containing only initialization/control metadata stays in an in-memory reader until
execution content arrives. It creates no persistent session, task, source snapshot
or completed notification receipt. An actual user submission may reserve its stable
recall IDs before the corresponding rollout write; discovery alone cannot do so.

Startup and reconciliation remove proven legacy initialization-only Codex entries
and their unused task/source bookkeeping. Executions, source gaps, orphan trace
provenance, upload history, bindings, child references and submitted reservations
protect existing work. A previously populated source becoming empty is treated as
missing evidence, not as an unused session. Viewer visibility follows SQLite state;
there is no additional frontend empty-session filter.

## Agent + project activation (API v4)

`GET /api/activation?agentType=...&cwd=...&nativeSessionId=...&parentNativeSessionId=...` returns `{active:boolean}` without reading transcript bodies or creating a session. Codex validates the native session header; known child sessions inherit their same-Agent parent scope.

`GET /api/state` adds `bindings`, one row per Agent＋project: `{id,projectId,agentType,name,root,baseUrl,spaceIds,enabledAt,history}`. `id` is the scope ID; `projects` remains the directory navigation list. `history` contains `status`, `recordCount`, `pending`, `uploading`, optional `warning/error`. Scope IDs are used by `/api/bind` and `/api/projects/:id/spaces`.

`POST /api/projects/:scopeId/history/scan` refreshes the historical source inventory. `POST /api/projects/:scopeId/history` explicitly imports complete history and queues only missing content for the current target snapshot; it never expands that request to newly attached Spaces. Existing pause configuration still controls network sending. Scan status and per-Space receipts remain separate; a successful HTTP request alone does not mean cloud processing completed.

Unbound `/api/events` returns empty context/IDs; `/api/search` rejects stale unbound contexts normally without diagnostic noise. Unbound context-delivery acknowledgements are ignored. Last unbind freezes retained trajectories and cancels unsent target work. A bind or rebind establishes a fresh capture boundary; old content requires explicit history upload.

`history.uploadError` supplies an actionable local blocker or unresolved per-Space upload failure. A blocked history job has `uploading:false`; pending queues do not imply network activity while paused. Completed delivery with no remaining content renders “已上传历史”; errors render a disabled red “上传历史失败” with the reason. Pausing later does not turn already accepted history into failure.

## Project discovery and cached lists

`GET /api/adapters/installed` returns configured adapter profiles with `installed:true`, using installation metadata without running host version commands. Only these Agents may discover project directories. Full detection remains `GET /api/adapters` on the Agent management page.

`GET /api/projects?agentType=...` uses the Agent's service-memory project cache, discovering metadata only on a cache miss. `refresh=1` explicitly discovers and merges project metadata by root; binding state is projected fresh from SQLite. Concurrent discoveries for the same Agent share one request. Browser reloads reuse the service cache; service restarts begin with an empty metadata cache. No new cache table is introduced.

Copilot CLI project discovery reads only the top-level `cwd` in `<COPILOT_HOME or ~/.copilot>/session-state/<sessionId>/workspace.yaml`. It uses the recorded working directory rather than the conversation name or `git_root`, deduplicates normalized roots, and supports the plain, quoted and literal-block scalar forms emitted by the host. It does not read `events.jsonl`, register sessions, create bindings or import historical task content. Missing/invalid metadata and linked entries are skipped; explicit test `home` remains isolated from `COPILOT_HOME`.

`GET /api/bind` returns the binding rows used by the project page, without loading all sessions, titles, batches or recall payloads. Project page reloads and history polling use this endpoint instead of `/api/state`.

First binding of a new Agent project starts a native history scan in the background. Repeat binding, additional Spaces and state polling do not rescan native history. History refresh merges newly completed local records into the existing catalog. Existing scopes after service restart use their SQLite records until an explicit `POST /api/projects/:scopeId/history/scan`; unbound scopes never read native history.


## Viewer 运行概览与云服务诊断（2026-11-19）

此增量沿用本地 API v5。四个主导航为运行概览、项目与空间、会话轨迹和 Agent 接入；云连接配置由左下角设置抽屉管理。原 `#settings` 地址兼容为运行概览上的设置抽屉。移除手动同步按钮，后台同步及 `POST /api/sync` 的既有能力保留；暂停只停止发送，恢复不重置失败投递。

- `GET /api/diagnostics?endpoint=&page=1&size=20` 返回 `{items,total,page,size}`。仅查询新的云调用失败记录；`endpoint` 可为 `create/space`、`get/space`、`get/memory`、`search/memory`、`add/message`、`get/status`、`list/domains`。页码最小1，页长1–100。列表不返回响应正文。
- `GET /api/diagnostics/:id` 返回完整记录，不存在返回404。记录字段为 `id,endpoint,method,kind,message,httpStatus,businessCode,context,responseBody,createdAt,lastOccurredAt,occurrences`。
- `context` 包含已知的 `sessionId,conversationId,agentType,projectId,projectName,scopeId,batchId,spaceId,taskId`。会话与轮次为插件本地ID；上传及轮询归属来自原批次，不能使用会话后来推进的新轮次。历史补传通过来源轨迹恢复轮次关联。空间创建等管理操作没有会话、轮次时明确为空，不猜测标识。
- `kind` 为 `http/business/timeout/network/response/processing`。未收到HTTP响应时 `httpStatus`、`responseBody` 为null；收到空响应体时 `responseBody` 为空字符串。云端任务返回 `failed` 记录 processing，同时保留既有 uploaded 与处理状态语义。
- `GET /api/diagnostics/export` 导出全部新式云诊断（包括详情）。不导出旧本地纯文本日志。
- `GET /api/state` 增加 `cloudDiagnosticCount`。原 `diagnostics` 保持兼容；Viewer 新诊断页不把旧日志、服务启动事件或本地容量阻塞混入云错误列表。

错误上下文在发起请求时快照传递；响应正文保留收到的文本并脱敏已知Key和凭据字段，不保存请求正文或认证头。相同接口、错误、响应和关联对象在60秒窗口内合并计数，保留首次与最近发生时间；不同会话、轮次、目标Space或批次不合并。`cloud_diagnostics` 单独持久化，首次升级且旧库有数据时生成 `memory.sqlite.before-cloud-diagnostics-*.sqlite`；旧记录不删除，也不补造过去没有保存的响应正文。

## Upload message projection

Upload continues to omit `domains`; binding-domain metadata never gates network sends. Host metadata preserves native message IDs and occurrence times plus explicit member IDs/names. The shared upload projection retains only business fields, converts native calls to function tool_calls and splits results with their actual tool_call_id. Object outputs are losslessly JSON encoded; mixed prose/thinking/tool blocks keep their order. Missing required tool fields or invalid explicit metadata block the batch while retaining local source evidence. No new CLI parameters or identity settings are introduced.

SQLite upload-format migration uses the existing user_version mechanism (version 4). Never-attempted tasks can be projected from their known source records; attempted pending requests are blocked for explicit reconciliation; accepted snapshots/receipts are preserved. Source-to-batch matching accounts for one-to-many projection, stable IDs and equivalent timestamp offsets. Old already-sanitized records cannot recover metadata that was never retained; no source-wide replay is forced.

## 对话绑定已有 Space

- `POST /api/bind-context {agentType,nativeSessionId}`：从当前原生会话的有效用户轮取得内部 context；无匹配返回空字符串，不采集正文、不建任务、不访问云端。
- `POST /api/bind-project {context,spaceId}`：内部入口，固定会话项目与 Agent，拒绝额外路由字段。返回 BOUND、ALREADY_BOUND、INVALID_INPUT、CONTEXT_MISSING 或 UNAVAILABLE，JSON 与退出语义见绑定 Skill 契约。context 由适配器自动传递，不是 CLI 参数。

Viewer 原有 `/api/bind` 和 `/api/projects` 契约保持不变。

## 当前对话项目的本地空间列表

`POST /api/project-spaces {context}` 仅供自动身份桥使用；CLI `memos-pm spaces` 不接收参数。服务确认当前轮身份后，优先使用已知会话的固定项目，否则按目录最长匹配，读取 `Store.spaces(scopeId)`，不调用云端补查名称、不要求 Key。

返回 `{ok:true,status:"FOUND"|"EMPTY",data:{agentType,root,spaces:[{spaceId,name}]},error:null}`；名称为空保持空字符串，EMPTY 的 spaces 为空。非法额外字段、身份缺失／过期和查询错误分别由 INVALID_INPUT、CONTEXT_MISSING、UNAVAILABLE 表示。查询不改变本地绑定或上传状态。

已有 `GET /api/projects/:id/spaces` 保留 Viewer 的云端名称刷新行为，不用于该 CLI。

## 当前对话项目解绑

`POST /api/unbind-project {context,spaceId}` 为自动身份桥内部接口；CLI只接收 `--space-id`。拒绝额外路由字段，按当前会话身份定位 Agent＋项目，复用 Store.unbind 本地事务，不调用云端或校验云 Key。

成功 `{ok:true,status:"UNBOUND"|"NOT_BOUND",data:{agentType,root,spaceId,name,spaces:[{spaceId,name}]},error:null}`。name 为移除前缓存值，spaces 为剩余列表；NOT_BOUND 不修改数据库且 name 为空。失败为 INVALID_INPUT、CONTEXT_MISSING、UNAVAILABLE。最后解绑关闭采集窗口，保留轨迹和回执；网络中请求不能撤回。

原有 Viewer `DELETE /api/bind {objectId,spaceId}` 保持不变。

## 历史容量与进度

`GET/PUT /api/config` 增加 `uploadMaxBytes`（正安全整数，默认39000，单位UTF-8字节）；设置抽屉可修改。大小包括最终上传 JSON 请求体的全部字段。

历史上传仍使用 `POST /api/projects/:scopeId/history {}`，不新增批量大小、分页游标或确认参数。Viewer 提交前通过既有 `GET /api/bind` 读取最新 `history.pending`：口径为独立待处理轨迹数，同一记录多个 Space 只计一次；大于配置项 `historyUploadConfirmCount` 才确认。取消不 POST。

`history.uploading` 覆盖逐会话物化、待发送及云端处理阶段；已确认的静默 skipped 不计 pending，不进入 uploadError。按钮上传中禁用，最终显示已完成。批次回执保留 skipped 的零尝试、空任务 ID，不将其当成 uploaded=true。实际云错误仍通过现有诊断和错误状态呈现。

本地 API 版本为8，新 Viewer 拒绝缺少上传能力字段的旧版后台；沿用受管服务更新流程，不清理数据库。

`GET /api/bind` 的 `history.canUpload` 表示当前允许发起上传：扫描完成、有绑定和待处理记录、无进行中的任务，且未暂停、Key 和云连接可用。失败文字不直接决定按钮是否禁用；可补传的失败显示“重试上传”，提交仍复用原接口及数量确认。运行中的本次任务优先显示“上传中”，旧失败不覆盖进度；扫描不会清除失败或隐式上传。

新任务只因本次批次及其容量调整替代批次的失败而停止，旧失败保留回执但不阻断后续分批。已确认接收及静默跳过的消息不重传；已获 task_id 后的云端处理失败继续显示错误，不作为未接收内容再次发送。

## 历史上传确认数量配置

`GET/PUT /api/config` 增加 `historyUploadConfirmCount`（正安全整数，默认100），设置抽屉“历史上传确认条数”可修改。`GET /api/bind` 的各 scope.history 同时返回该字段，Viewer 用同一次预检得到的最新独立 pending 数量与该阈值比较，避免使用旧页面缓存；只有 pending 大于阈值才确认。缺少有效阈值时拒绝提交并提示更新后台，不回退硬编码值。

测试时可设为2：2条不弹窗，3条弹窗；之后设回100即可，无需修改代码。多空间不重复计数，上传字节上限独立保持不变。
