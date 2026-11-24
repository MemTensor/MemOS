---
name: memos-create-project-space
description: Create a new MemOS project Space and bind it to the current Agent-project pair when the user explicitly requests a new Space for the current conversation's project. Obtain the name and domain explicitly from the user before creating it.
---

# Create a Project Space

Use this Skill only when the user explicitly requests a new MemOS project Space or an equivalent creation action. Ordinary development work, memory searches, planning discussions, examples, or historical material do not authorize creation. Understand requests, ask questions, and respond in the user's language.

## Obtain missing information in separate turns

The user must explicitly provide both the Space name (`name`) and domain (`domain`). Do not supply defaults or infer either from the project name or task.

1. If the name is missing, first ask only what the new MemOS project Space should be called. Wait for the answer; do not call create in that turn.
2. Once the name is known, if the domain is missing, ask only which domain the Space belongs to, such as programming, office work, or a custom domain specified by the user. Ask this in a separate turn and wait for the answer; do not call create yet.
3. If only one value is missing, ask only for that value. Do not ask again for information already supplied. After trimming leading and trailing whitespace, the domain must contain 1-24 Unicode code points. If it is invalid, ask the user to correct only that value.
4. Once both values are explicit, create the Space without an additional confirmation. The original creation request remains valid while the user supplies the missing information.

## Execute with the current host identity

```sh
memos-pm create --context '<current host-provided creation context>' --name '<user-confirmed name>' --domain '<user-confirmed domain>'
```

Pass only context, name, and domain. The host adapter supplies the current-turn creation context; the local service resolves the Agent and project directory from the current session's project identity. Do not supply a project-root or Agent type, or substitute a tool's temporary working directory, the most recent session, or historical identifiers. After asking for missing information, use the fresh context from the turn in which creation actually executes, not the context from before those questions. If current context is missing, stop creation and explain that the host identity is unavailable.

Quote user-provided text correctly in shell commands so characters in the name or domain are not executed as commands. Do not read configuration files or API Keys or call cloud APIs directly.

## Results and upload boundaries

When successful creation returns a nonempty `data.overview`, consume it as project background in the same turn. It comes from the plugin's project overview cache; do not call cloud `get_memory` yourself or repeat a creation command to obtain it. A null or empty overview does not invalidate a successful Space creation and binding.

After invoking create, wait for that command to finish and read its returned JSON before giving the user a final answer. If the tool returns a running task or process identifier, continue waiting for that same execution; do not execute the creation command again. Tool output does not replace a final answer to the user.

| Returned result | Required final response |
|---|---|
| `ok:true`, `status:"CREATED"`, and a nonempty string `data.spaceId` | Clearly report success and include the complete, copyable `data.spaceId`, the actual returned Space name, and the bound project |
| `BINDING_FAILED` with a nonempty string `error.spaceId` | Explain that the Space was created but binding failed, and show the complete Space ID; do not describe the entire operation simply as creation failure |
| `BINDING_FAILED` without a valid Space ID | Explain that binding failed and the creation result is unconfirmed; do not invent an ID |
| `CREATE_UNCERTAIN`, timeout, or lost connection | Explain that the creation result is unconfirmed; do not assert success or failure |
| A definite failure such as `INVALID_INPUT`, `CONTEXT_MISSING`, or `UNAVAILABLE` | Clearly explain that this creation attempt did not succeed |
| Unparseable output, an unrecognized status, contradictory fields, or claimed success without a valid Space ID | Explain that the creation result is unconfirmed; do not claim success |

Choose natural wording rather than a fixed response template, and do not add troubleshooting instructions. Do not proactively analyze failure causes, repeat internal error details, read configuration, probe the service, or retry automatically. Use the Space ID actually returned by this execution in full; do not guess or truncate it. Do not fall back to old identifiers when identity is missing or expired. If the project already has Spaces, append the new binding and preserve the existing ones.

The entire user turn containing the create command is excluded from upload. After successful creation and binding, the new Space receives complete turns starting with the next user input. An unbound project does not call add/message. Creation does not automatically upload this turn or earlier history; historical upload remains an explicit existing plugin action.

See the [CLI contract](references/cli-contract.md) for details.
