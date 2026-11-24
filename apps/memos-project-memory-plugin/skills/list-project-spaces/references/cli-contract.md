# Project Space Listing CLI Contract

```sh
memos-pm spaces
```

The command accepts no arguments. The host's native environment, execution-time bridge, or current-turn launcher supplies the current Agent, project, and user-turn identity automatically. A dedicated launcher uses `'<node>' '<host-provided current-turn launcher>' spaces`; do not add identity parameters or copy a launcher from history. Reject missing, conflicting, or expired identity rather than guessing from a tool's working directory or the most recent session.

Read only `name` and `spaceId` from the current Agent–project pair's bindings in local SQLite. Do not access the cloud, require a cloud Key, or modify bindings, names, configuration, or upload state. Exclude unbound spaces. Keep an uncached name as an empty string; do not fabricate it. Return the complete list without pagination arguments.

stdout contains one JSON object. FOUND and EMPTY have `ok:true` and exit 0; all other states have `ok:false` and exit 1.

- FOUND / EMPTY: `{ok:true,status,data:{agentType,root,spaces:[{spaceId,name}]},error:null}`. EMPTY has an empty spaces array.
- INVALID_INPUT / CONTEXT_MISSING / UNAVAILABLE: `{ok:false,status,data:null,error:{message}}`.

FOUND means at least one current local binding exists. EMPTY means the current project was reliably identified and has no bindings; it must not represent identity or lookup failure. Returned names and IDs are locally saved values, not proof of synchronization with current cloud names. When users refer to projects, spaces, organizations, or similar terms, the Skill follows the contextual binding-query intent. Do not add synonym tables or keyword parameters to the code.
