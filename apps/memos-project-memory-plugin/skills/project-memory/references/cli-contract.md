# Search CLI Contract

```sh
memos-pm search --session-id '<session_id>' --conversation-id '<conversation_id>' --query 'question'
```

All three arguments are required. `session_id` identifies the current host session; `conversation_id` identifies the current user-input turn. They are used for local routing and search attribution and are not the cloud API parameters with the same names. The adapter supplies them for each turn; do not place live identifiers in this static Skill.

One command searches all Spaces currently bound to the project: the local service supplies the complete `space_ids` list in a single cloud request. Do not issue a separate search for each Space or have the model supply or manage Space IDs. An empty binding list returns `UNAVAILABLE`.

The host's runtime context may supply these arguments. Old context retained in history is not the current invocation context. Use the currently effective session and turn identifiers; do not fall back to historical ones when this turn's identifiers are unavailable. Neither the Skill description nor dynamic parameters replace the full usage instructions.

stdout contains only JSON; stderr may contain a short diagnostic. A successful response has this shape:

```json
{
  "ok": true,
  "status": "FOUND",
  "data": {
    "topics": []
  },
  "error": null
}
```

The empty array above illustrates the schema, not an actual match. Topics may include decisions, experiences, a timeline, and history or conflicts attached to particular decisions. Preserve these relationships rather than flattening multiple conclusions into a single fact. Cite only authors and timestamps actually returned; do not invent provenance.

| status | Exit code | Handling |
|---|---:|---|
| FOUND | 0 | Matches were returned; check applicability before using them |
| EMPTY | 0 | The search succeeded without matching results |
| UNAVAILABLE | Nonzero | Search is unavailable; do not present this as absence of memory |
| INVALID_QUERY | Nonzero | query is missing or blank; correct it |
| CONTEXT_MISSING | Nonzero | Identifiers are missing, unknown, mismatched, or expired; use the current adapter-supplied identifiers |

No additional configuration arguments or management subcommands are provided by this Skill. The local service resolves the user, Agent, and project. Unavailable memory does not prevent the host from continuing the original task.
