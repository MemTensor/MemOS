# Local API implementation contract
JSON over loopback. GET /api/config returns {baseUrl,userId,keyConfigured,paused}; PUT /api/config accepts {baseUrl,apiKey,paused} (never return key). GET/POST /api/projects (name,root); POST /api/bind {objectId,spaceId}; GET /api/state returns {projects,tasks,sessions,batches,recalls,diagnostics}; GET /api/sessions/:id returns {session,turns,traces,recalls,batches}. POST /api/events accepts AgentEvent, returns EventResult (src/adapters/types.ts). /api/search accepts {sessionId,conversationId,query}, returns CLI JSON. POST /api/sync manually runs pending sync (not failed batches).
GET /api/adapters lists detection status; POST /api/adapters/:id/install and /uninstall call installer. Parent implements server/storage/cloud/CLI. Hook agent owns registry/installer/hook and transcript shared; native agent owns extension/rpc dirs and tests. Viewer/mock agent owns viewer, dev/memos-mock and respective tests.
HTTP source imports .ts; build strips to JS and rewrites .ts import suffix. Node built-ins only runtime. Client helper src/adapters/_shared/client.ts exports serviceRequest<T>(path,body?,method?) and ensureService(); use it in adapter entry points. MEMOS_PM_DATA_DIR selects instance; MEMOS_PM_URL optional local service override for tests. Server state fields camelCase. Source IDs stable per native record; never hash content alone for identity. turnKey is reliable source user-message/event identity when nativeTurnId unavailable; do not assign a turn for each model/tool event.

`GET /api/health` returns `{ok,service,apiVersion,runtimeRevision,pid}`. The local API version is 3; the runtime revision is captured when the server is created, so rebuilding files cannot make an old process claim the new revision. Viewer checks the API version before interpreting state. An old single-Space response must produce an explicit service-update message, never be interpreted as empty `spaceIds` or missing Agent ownership.

`GET /api/projects?agentType=<profile.agentId>` lists that agent's existing projects from supported host metadata, recorded Agent associations and captured session directories. Candidate fields reuse `name` and `root`, plus `id`, `spaceIds`, `bindingStatus` when registered. Registered parent project roots follow the same longest-directory matching as capture. A GET without `agentType` continues to list registered projects. State project rows include `agentTypes` and `spaceIds`; neither uses a duplicate singular `spaceId` alias.

`POST /api/projects {name,root,spaceId,agentType?}` verifies the supplied Space via `get/space`, then registers/reuses the directory project and appends its binding atomically in SQLite. The existing `agentType` records ownership even when the Agent has no captured sessions yet. Standalone tasks, sessions, their existing spaces and batches under the directory join the project in the same transaction, preserving raw traces, identities, payloads and send counters. Existing nested project ownership is retained. Cross-connection bindings or uncertain creation roll back the operation. The registration-only `{name,root}` request remains available.

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
