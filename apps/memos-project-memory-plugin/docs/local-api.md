# Local API implementation contract
JSON over loopback. GET /api/config returns {baseUrl,userId,keyConfigured,paused}; PUT /api/config accepts {baseUrl,apiKey,paused} (never return key). GET/POST /api/projects (name,root); POST /api/bind {objectId,spaceId}; GET /api/state returns {projects,tasks,sessions,batches,recalls,diagnostics}; GET /api/sessions/:id returns {session,turns,traces,recalls,batches}. POST /api/events accepts AgentEvent, returns EventResult (src/adapters/types.ts). /api/search accepts {sessionId,conversationId,query}, returns CLI JSON. POST /api/sync manually runs pending sync (not failed batches).
GET /api/adapters lists detection status; POST /api/adapters/:id/install and /uninstall call installer. Parent implements server/storage/cloud/CLI. Hook agent owns registry/installer/hook and transcript shared; native agent owns extension/rpc dirs and tests. Viewer/mock agent owns viewer, dev/memos-mock and respective tests.
HTTP source imports .ts; build strips to JS and rewrites .ts import suffix. Node built-ins only runtime. Client helper src/adapters/_shared/client.ts exports serviceRequest<T>(path,body?,method?) and ensureService(); use it in adapter entry points. MEMOS_PM_DATA_DIR selects instance; MEMOS_PM_URL optional local service override for tests. Server state fields camelCase. Source IDs stable per native record; never hash content alone for identity. turnKey is reliable source user-message/event identity when nativeTurnId unavailable; do not assign a turn for each model/tool event.

`GET /api/health` returns `{ok,service,apiVersion,runtimeRevision,pid}`. The local API version is 5; the runtime revision is captured when the server is created, so rebuilding files cannot make an old process claim the new revision. Viewer checks the API version before interpreting state. An old single-Space response must produce an explicit service-update message, never be interpreted as empty `spaceIds` or missing Agent ownership.

`GET /api/projects?agentType=<profile.agentId>` lists that agent's existing projects from supported host metadata, recorded Agent associations and captured session directories. Candidate fields reuse `name` and `root`, plus `id`, `spaceIds`, `bindingStatus` when registered. Registered parent project roots follow the same longest-directory matching as capture. A GET without `agentType` continues to list registered projects. State project rows include `agentTypes` and `spaceIds`; neither uses a duplicate singular `spaceId` alias.

`POST /api/projects {name,root,spaceId,agentType}` verifies the supplied Space via `get/space`, then registers/reuses the directory project and appends its binding atomically in SQLite. The existing `agentType` records ownership even when the Agent has no captured sessions yet. Only the selected Agent’s existing sessions and batches join the new scope, preserving raw traces, identities, payloads and send counters; old independent Space bindings do not grant new authorization. Existing nested project ownership is retained. Cross-connection bindings or uncertain creation roll back the operation. The registration-only `{name,root}` request remains available.

`POST /api/projects {name,root,agentType,spaceName}` explicitly creates and binds a Space after Viewer confirmation. `spaceName` and `spaceId` are mutually exclusive; invalid input fails before creation. The service calls `create/space` with only `{space_name}`, validates the returned ID, and reuses the existing binding transaction with its ID and name, without another `get/space`. No schema change or new route is introduced. The registration-only request remains compatible.

A known cloud-connection or uncertain-binding conflict rejects creation before calling the cloud. A connection change after creation prevents binding. If creation returned an ID but binding fails, HTTP 400 includes `{error,spaceId}`; Viewer preserves that ID and switches to existing-Space binding. Creation failures and unknown outcomes are never retried automatically. API v5 is required: a v4 process would otherwise misinterpret `spaceName` as registration only. The existing managed-service upgrade mechanism replaces an old process; a stale browser prompts the user to reopen Viewer before allowing operations.

`GET /api/projects/:id/spaces` returns `[{spaceId,name}]`, resolving cloud Space names and retaining cached names on temporary lookup failure. `POST /api/bind {objectId,spaceId}` appends an accessible Space idempotently. `DELETE /api/bind {objectId,spaceId}` removes only the selected local association; no cloud deletion is performed. Empty lists preserve the project and do not automatically create a replacement Space. Existing cloud task tracking and historical payload snapshots remain intact.

`POST /api/search {sessionId,conversationId,query}` still powers the sole CLI command. The service supplies all bound `space_ids` in one cloud request. Models do not receive Space management parameters.

`POST /api/context-delivery` accepts `{sessionId}` and returns `{ok:true}`. The adapter calls it after actually handing initial context to the host. Events return `overviewDelivered` so history hosts omit the cached overview on later turns, while request-view hosts keep mounting cached context. Delivery acknowledgement is not proof of model consumption.

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

`GET /api/bind` returns the binding rows used by the project page, without loading all sessions, titles, batches or recall payloads. Project page reloads and history polling use this endpoint instead of `/api/state`.

First binding of a new Agent project starts a native history scan in the background. Repeat binding, additional Spaces and state polling do not rescan native history. History refresh merges newly completed local records into the existing catalog. Existing scopes after service restart use their SQLite records until an explicit `POST /api/projects/:scopeId/history/scan`; unbound scopes never read native history.
