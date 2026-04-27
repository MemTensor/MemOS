# Hermes MemOS Memory Plugin

MemOS Platform as a standalone Hermes memory-provider plugin.

This plugin gives Hermes server-side memory extraction and semantic search through
[MemOS](https://memos.openmem.net/). It exposes memory search and explicit memory
write tools, and it can persist completed conversation turns into MemOS in the
background.

## Install From the MemOS Repository

This plugin lives inside the MemOS monorepo at
`apps/MemOS-Cloud-Hermes-Plugin`. Install the whole MemOS project with Hermes's
official plugin installer first:

```bash
hermes plugins install MemTensor/MemOS
pip install MemoryOS
```

Then link the MemOS app directory into Hermes's memory provider directory so
`hermes memory setup` can discover it:

```bash
mkdir -p ~/.hermes/hermes-agent/plugins/memory
ln -s ~/.hermes/plugins/MemOS/apps/MemOS-Cloud-Hermes-Plugin \
      ~/.hermes/hermes-agent/plugins/memory/memos
```

Hermes currently discovers memory providers from `plugins/memory/` inside the
Hermes source tree. The symlink points the memory-provider discovery path at the
MemOS app that was installed by `hermes plugins install`.

Finally, configure it:

```bash
hermes memory setup
```

Choose `memos` in the setup wizard.

If the plugin is already installed and you want to refresh the MemOS checkout:

```bash
hermes plugins update MemOS
```

## Local Development Install

If you already have a local MemOS checkout, use its app directory directly:

```bash
cd /path/to/MemOS
pip install MemoryOS
mkdir -p ~/.hermes/hermes-agent/plugins/memory
ln -s "$(pwd)/apps/MemOS-Cloud-Hermes-Plugin" ~/.hermes/hermes-agent/plugins/memory/memos
hermes memory setup
```

For this workspace, the plugin path is:

```text
/Users/geyunhang/Documents/demos/MemOS-Plugin-dev/MemOS/apps/MemOS-Cloud-Hermes-Plugin
```

## Requirements

- Hermes with the memory-provider plugin system
- `MemoryOS`
- A MemOS API key from the [MemOS Dashboard](https://memos-dashboard.openmem.net)

## What It Adds

Tools:

- `memos_search`: search the user's MemOS memories.
- `memos_add_message`: explicitly store a fact or message in MemOS memory.

Memory integration:

- `prefetch`: recalls relevant MemOS memories before a turn.
- `sync_turn`: stores completed user/assistant turns in MemOS asynchronously.
- `queue_prefetch`: present for the Hermes memory-provider lifecycle; currently a no-op.

## Config

Secret config can be set through environment variables:

- `MEMOS_API_KEY`: required MemOS API key.
- `MEMOS_USER_ID`: optional user ID, defaults to `hermes_user`.

Non-secret config is stored in `$HERMES_HOME/memos.json`:

- `api_key`: MemOS API key. Usually written to `.env` by `hermes memory setup`.
- `user_id`: MemOS user identifier. Defaults to `hermes_user`.
- `knowledgebase`: optional knowledgebase ID or list of IDs for search.
- `allowedAgents`: optional list of Hermes agent IDs allowed to use memory.
- `multiAgentMode`: when true, search is filtered by Hermes agent ID.

Example:

```json
{
  "user_id": "hermes_user",
  "knowledgebase": ["kb-123", "kb-456"],
  "allowedAgents": ["coder", "researcher"],
  "multiAgentMode": true
}
```

## Validation

From a Hermes checkout with this plugin linked into `plugins/memory/memos`, run:

```bash
python -m py_compile ~/.hermes/plugins/MemOS/apps/MemOS-Cloud-Hermes-Plugin/__init__.py
hermes memory setup
```

If you are developing inside the Hermes source tree, you can also run:

```bash
python -m py_compile memos-memory-plugin/__init__.py
```

## Notes

- This repository is laid out as a Hermes directory plugin, so the repo root is
  the plugin root.
- The installed plugin name is `memos`, matching `plugin.yaml`.
- Hermes currently does not install `pip_dependencies` from memory-provider
  plugins automatically, so install `MemoryOS` into the Hermes runtime
  environment yourself.
