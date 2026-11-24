---
name: memos-list-project-spaces
description: Show the names and IDs of MemOS spaces bound or linked to the current conversation's project. Use for natural questions about connected projects, spaces, organizations, or where project memory is stored; users need not say Space precisely.
---

# List Project Spaces

Interpret the user's request in context as a question about the current project's MemOS bindings. Accept informal references to a project, space, organization, what it is linked to, or where memory is stored, in the user's language. When the MemOS binding intent is clear, query directly without asking the user to use the exact term or confirm again. Reply in the user's language.

General project introductions, code-structure questions, and questions about actual enterprise organizations, members, or permissions are outside this Skill. Treat an organization as a Space only when the context refers to project memory bindings.

```sh
memos-pm spaces
```

The command takes no arguments. The host supplies the current Agent, project directory, and user-turn identity automatically. Do not provide directory, Agent, session, context, or Space ID parameters, and do not set identity environment variables yourself. If the host supplies a current-turn space-listing launcher, prefer that exact launcher with its `spaces` command. Do not reuse launchers from other sessions or earlier turns. Do not infer the target from a tool's temporary working directory or the most recent session.

The plugin reads only the current Agent–project pair's existing bindings in local SQLite and returns cached space names and IDs. Do not read API Keys, access the cloud, look up or guess missing names, or perform creation, binding, unbinding, or history uploads.

## Report the Result

- FOUND: Explain that these are the current Agent and project's local bindings. List each space's name and complete Space ID. If a name is empty, describe it as not cached in the user's language and retain the actual ID.
- EMPTY: State clearly that the current Agent–project pair has no bound spaces. Do not include bindings belonging to other Agents or projects.
- CONTEXT_MISSING: Explain that the current host identity is missing or expired and requires an integration update or a new user turn. Do not interpret this as having no bindings.
- UNAVAILABLE: Explain that the local lookup is temporarily unavailable and report the actual error. Do not claim there are no bindings or switch to a cloud lookup.
- INVALID_INPUT: Use the zero-argument command above; do not ask the user for routing parameters.

Present the result as a natural-language answer or a list of names and IDs, rather than only showing raw JSON. Names are local cached values; they have not been verified against the latest cloud names.

See the [CLI contract](references/cli-contract.md) for the response structure and exit codes.
