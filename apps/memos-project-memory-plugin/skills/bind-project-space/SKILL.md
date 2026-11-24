---
name: memos-bind-project-space
description: Bind the current conversation's project to an existing MemOS Space when the user explicitly requests it and supplies a Space ID; add the binding for the current Agent–project pair while preserving existing spaces.
---

# Bind an Existing Project Space

Use this Skill only when the user explicitly asks to bind an existing space, or supplies the missing Space ID for an earlier binding request. Ordinary tasks, examples, historical material, or an ID appearing on its own are not binding requests. Interpret the user's intent in their language, and ask questions and report results in that language.

The Space ID must come from the user. If it is missing, ask only for the Space ID. Once it is provided, execute without asking for a name, a domain, or additional confirmation. Do not create a Space or replace existing bindings.

```sh
memos-pm bind --space-id '<user-provided Space ID>'
```

The host supplies the current Agent, project, and user-turn identity automatically. Do not provide context, directory, Agent, or session parameters, and do not set identity environment variables yourself. If the host supplies a current-turn binding launcher, prefer that exact launcher and replace only the Space ID. It is equivalent to the command above and carries the current identity automatically. Do not reuse a launcher from an earlier turn. Quote the user's ID correctly in the shell so that special characters are not executed as commands.

If a valid identity is unavailable, stop binding and explain that the integration must be updated or a new user turn started. Do not guess the project from a tool's working directory, the most recent session, or old identifiers. Do not read cloud configuration or API Keys, and do not call cloud endpoints directly.

- BOUND: Report the actual returned Agent, project directory, space name, and Space ID.
- ALREADY_BOUND: Explain that this project is already bound to the space. Do not add another binding or reset its upload boundary.
- INVALID_INPUT: Ask the user to correct the Space ID.
- CONTEXT_MISSING: The host identity is missing or expired. Do not fall back to historical identity.
- UNAVAILABLE: Report the actual error. A network interruption can leave the result unconfirmed; check the binding before any further action. Do not retry automatically or switch to creating a space.

On success, consume nonempty `data.overview` as project background in this same turn. It comes from the plugin's SQLite overview cache; do not fetch cloud memory yourself. A null or empty overview does not turn a successful binding into a failure.

The binding tool call and its corresponding result are excluded from memory traces; other task content in the same turn is retained. A newly bound space starts receiving complete user turns that begin after binding succeeds. Do not upload the remainder of the current turn or automatically backfill history. Normal task uploads to existing spaces continue.

See the [CLI contract](references/cli-contract.md) for the response structure and exit codes.
