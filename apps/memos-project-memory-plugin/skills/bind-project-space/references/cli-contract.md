# Project Binding CLI Contract

`memos-pm bind --space-id '<user-provided Space ID>'`

Accept exactly one nonblank Space ID. Do not accept context, project, Agent, session, or turn parameters. The host execution environment or current-turn launcher supplies identity automatically. The local service resolves the fixed project directory from the current turn of the native session; it must not guess from the most recent session or a tool's working directory. A current-turn launcher expires when that turn ends or the next user turn starts.

stdout contains one JSON object. Exit 0 when `ok:true`; otherwise exit 1.

- BOUND / ALREADY_BOUND: `{ok:true,status,data:{spaceId,spaceName,agentType,root,projectId,scopeId,uploadStartsNextTurn:true,overview},error:null}`. `overview` is a string or null; consume nonempty project background in the current turn without a separate cloud request. Unavailable overview content does not invalidate binding success.
- INVALID_INPUT / CONTEXT_MISSING / UNAVAILABLE: `{ok:false,status,data:null,error:{message}}`.

Bind only an existing space; do not call create/space. Reuse the existing space-access, Domain-mapping, and maximum-20-spaces checks for each Agent–project pair. Add the space to existing bindings. A repeated binding must not change the original binding time or upload boundary. Before a project is bound, register identity metadata only; doing so does not enable conversation-content collection.

The binding tool call and results associated by a reliable call ID are excluded from task traces and uploads. Preserve mixed task scripts or content that cannot be proved to be an independent binding operation; do not filter by text keywords. A new destination receives complete turns that begin after binding completes. Do not automatically upload history. Previously sent snapshots and receipts remain unchanged.

Do not retry automatically after a network response is lost. Binding changes a local association and does not create a remote resource. After the user checks the result, binding the same space again returns ALREADY_BOUND.
