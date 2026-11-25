# Create CLI Contract

```sh
memos-pm create --context '<current host-provided creation context>' --name '<user-confirmed name>' --domain '<user-confirmed domain>'
```

All three arguments are required. Do not pass project-root, Agent, Space ID, cloud connection, or Key arguments. context is the creation identity supplied by the host for this user turn, not the session-id/conversation-id used by search. The name and domain must not be blank; the trimmed domain must contain 1-24 Unicode code points.

stdout is one JSON object. CREATED exits 0; all other statuses exit 1:

```json
{
  "ok": true,
  "status": "CREATED",
  "data": {
    "spaceId": "actual-cloud-space-id",
    "spaceName": "Actual Space name",
    "agentType": "current-agent",
    "root": "/project-directory-owned-by-the-session",
    "projectId": "local-project-id",
    "scopeId": "agent-project-binding-id",
    "uploadStartsNextTurn": true
  },
  "error": null
}
```

Failures have the shape `{ok:false,status,data:null,error:{message,spaceId?}}`. Statuses include INVALID_INPUT, CONTEXT_MISSING, UNAVAILABLE, CREATE_UNCERTAIN, and BINDING_FAILED. If BINDING_FAILED includes spaceId, preserve and show that ID to the user; do not automatically create another Space. Never automatically retry an operation whose result is uncertain.

## Consume results and answer the user

Successful results additionally include `data.overview` (string or null). A nonempty overview is project background to consume immediately in the same turn, without an extra cloud request. Missing overview content does not change the creation/binding result.

Wait for the command to finish, parse the JSON on stdout, and report the outcome according to the [Skill's results and upload boundaries](../SKILL.md#results-and-upload-boundaries). If the tool returns a running execution identifier, continue waiting for that same execution rather than submitting creation again.

Success requires `ok:true`, `status:"CREATED"`, and a nonempty string `data.spaceId`. The final answer must include the complete ID, the actual Space name, and the bound project. For binding failure, a known Space ID comes from `error.spaceId`. Interpret fields together with the status; never mistake the local projectId, scopeId, or host context identifier for a Space ID.

`error.message` remains available in the tool result and does not have to be repeated to the user. Distinguish definite failure, partial success, and an unconfirmed result. Invalid output is not success. Choose the wording naturally in the user's language, without a fixed script, troubleshooting guidance, proactive cause analysis, or diagnostic actions. No result authorizes an automatic retry.

Creation reuses the plugin's existing Space-creation and binding flow, preserving existing bindings. The entire creation turn is excluded from upload. Upload starts with the next user turn, and add/message sends only to bindings that are still active. Scanning history does not upload it; history is not automatically backfilled.
