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
    "content": "- Keep build reports for 14 days.\n  Update the report index after every successful build."
  },
  "error": null
}
```

Each entry contains the returned summary followed by its indented description when available. Entries appear in cloud response order, separated by a blank line. A successful search with no usable text returns `EMPTY` and `data.content` is an empty string.

| status | Exit code | Handling |
|---|---:|---|
| FOUND | 0 | Matches were returned; check applicability before using them |
| EMPTY | 0 | No usable summary or description was returned |
| UNAVAILABLE | Nonzero | Search is unavailable; do not present this as absence of memory |
| INVALID_QUERY | Nonzero | query is missing or blank; correct it |
| CONTEXT_MISSING | Nonzero | Identifiers are missing, unknown, mismatched, or expired; use the current adapter-supplied identifiers |

No additional configuration arguments or management subcommands are provided by this Skill. The local service resolves the user, Agent, and project. Unavailable memory does not prevent the host from continuing the original task.
