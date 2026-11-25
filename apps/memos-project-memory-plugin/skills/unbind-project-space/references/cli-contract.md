# Project Unbinding CLI Contract

```sh
memos-pm unbind --space-id '<user-specified Space ID>'
```

Accept exactly one nonblank Space ID. Do not accept context, directory, Agent, session, or turn parameters. The host's native environment, execution-time bridge, or current-turn launcher supplies the current identity automatically. A dedicated launcher uses `'<node>' '<existing current-turn launcher>' unbind --space-id '<user-specified ID>'`. Reject missing, conflicting, or expired identity; do not guess the project from the most recent session or a tool's working directory.

stdout contains one JSON object. UNBOUND and NOT_BOUND have `ok:true` and exit 0; all other states have `ok:false` and exit 1.

- UNBOUND / NOT_BOUND: `{ok:true,status,data:{agentType,root,spaceId,name,spaces:[{spaceId,name}]},error:null}`. name is the destination's cached name, or an empty string if unavailable. spaces contains the bindings remaining after the operation.
- INVALID_INPUT / CONTEXT_MISSING / UNAVAILABLE: `{ok:false,status,data:null,error:{message}}`.

UNBOUND means the specified association was removed from the current Agent–project pair. NOT_BOUND means that ID was never bound to this pair or has already been unbound. Repeated operations do not create a project or an empty association. Missing or expired identity and lookup errors must not be reported as NOT_BOUND.

Operate only on local SQLite. Do not require a cloud Key or call cloud deletion, creation, or lookup endpoints. Reuse the existing unbinding transaction: cancel this destination's unfinished queued deliveries and close the collection window when the final binding is removed. Preserve existing traces, snapshots, receipts, and the cloud Space. An already issued request cannot be recalled, and its actual response is still recorded. Other projects, Agents, and Spaces remain unchanged. Rebinding does not automatically restore cancelled queues.

Exclude explicit standalone unbinding tool calls and results associated by a reliable call ID from task traces. Preserve mixed scripts when they cannot be separated reliably; do not delete other task content in the same turn. Do not retry automatically after a network response is lost. Check the actual binding state first.
