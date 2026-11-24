---
name: memos-unbind-project-space
description: Unbind a specified MemOS Space from the current project when the user asks to remove or disconnect that association and provides a Space ID; remove only the current Agent–project pair's local binding.
---

# Unbind a Project Space

Understand natural requests to unbind, remove a link, or stop connecting to a space, project, or organization in the user's language. The user must clearly intend to remove a binding. Ordinary discussion, code examples, an ID on its own, or a question about existing bindings is not an unbinding request. Interpret organization as a Space only in the context of MemOS space associations, not actual enterprise organization management. Ask questions and report results in the user's language.

The Space ID must be explicitly supplied by the user. If it is missing, ask only which Space ID to unbind. Do not infer it from a space name or recent records. Once the intent and ID are clear, execute without additional confirmation. The original unbinding request remains valid while the user supplies the missing ID.

```sh
memos-pm unbind --space-id '<user-specified Space ID>'
```

Provide only the Space ID. The host supplies the current Agent, project directory, and user-turn identity automatically. Do not pass context, directory, Agent, or session parameters, and do not set identity environment variables yourself. If the host supplies a current-turn unbinding launcher, prefer that exact launcher and replace only the Space ID. Do not reuse a launcher from another session or an earlier turn. Do not guess the project from a tool's temporary working directory or the most recent session.

Quote the user's ID correctly in the shell so that special characters are not executed as commands. Do not read configuration or API Keys, call cloud endpoints directly, delete a cloud Space, or delete memories.

## Report the Result

- UNBOUND: Report the actual returned Agent, project, unbound Space ID, and cached name, together with the remaining bindings. If the name is empty, describe it as not cached in the user's language.
- NOT_BOUND: Explain that the current Agent–project pair was already not bound to this ID and no change was needed. Do not claim that an association was just removed.
- INVALID_INPUT: Ask the user to correct the Space ID, not to provide routing parameters.
- CONTEXT_MISSING: The current host identity is missing or expired. Do not fall back to old identifiers; explain that the integration must be updated or a new user turn started.
- UNAVAILABLE: Report the actual error. A network interruption may leave the result unconfirmed; check the current bindings first. Do not retry automatically or claim success.

Remove only the local association between the current Agent–project pair and the specified Space. Preserve other spaces and bindings of the same Space belonging to other Agents or projects. Preserve the cloud Space, existing traces, and upload receipts. Cancel this destination's unfinished queued deliveries. An already issued network request cannot be recalled; its actual result is still recorded.

If spaces remain, collection and memory operations continue with those spaces. Removing the final space stops collection, memory injection, retrieval, and upload for this Agent–project pair. Rebinding does not automatically restore cancelled queues. The unbinding tool call and its corresponding result are excluded from memory traces; other task content in the same turn is retained.

See the [CLI contract](references/cli-contract.md) for the response structure and exit codes.
