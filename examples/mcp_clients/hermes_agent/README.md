# Hermes Agent Integration

This directory contains examples and tools for integrating MemOS with the [Hermes Agent](https://github.com/NousResearch/hermes-agent) framework by Nous Research.

## Quick Setup

Run the automated setup script:

```bash
bash setup.sh [MCP_URL]
```

Where `MCP_URL` can be a local or remote MemOS MCP endpoint and defaults to
`http://127.0.0.1:8766/mcp`. The setup script also writes
`~/.hermes/memos-log-syncer.json`, so the Desktop/TUI log syncer uses the same
endpoint without passing `--mcp-url` every time.

## Manual Setup

If you prefer manual configuration, follow these steps:

### 1. Disable Built-in Memory

```bash
hermes config set memory.memory_enabled false
hermes config set memory.user_profile_enabled false
```

### 2. Add MemOS MCP Server

```bash
hermes mcp add memos --url http://127.0.0.1:8766/mcp
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --init-config --mcp-url http://127.0.0.1:8766/mcp
```

### 3. Update SOUL.md

Append the memory rules from `soul_template.md` to `~/.hermes/SOUL.md`.

### 4. Restart Hermes

```bash
/exit
hermes
```

The setup script also installs the `memos-memory` Hermes user plugin. It uses
Hermes' official `pre_llm_call` and `post_llm_call` hooks, so it works for
Hermes runtimes that execute Python user plugins, such as CLI/Gateway flows:

- Before each turn, relevant MemOS memories are injected into the model context.
- After each turn, the user message and assistant response are submitted to
  MemOS for MemReader extraction and scheduler processing.
- Network failures fail open and do not block Hermes responses.

Restart the Hermes Gateway after installation:

```bash
hermes gateway restart
```

## Hermes Desktop / TUI Log Sync

Hermes Desktop does not currently trigger the Python user plugin hooks. For
Desktop/TUI conversations, run the lightweight log syncer instead. It reads the
MCP endpoint from `--mcp-url`, `MEMOS_MCP_URL`, then
`~/.hermes/memos-log-syncer.json`, falling back to
`http://127.0.0.1:8766/mcp`.

```bash
cd /path/to/MemOS
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --dry-run
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once
```

For a remote MemOS MCP service, initialize once:

```bash
cd /path/to/MemOS
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --init-config --mcp-url https://memos.example.com/mcp
```

To keep syncing new turns:

```bash
cd /path/to/MemOS
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py
```

The syncer uses `~/.hermes/logs/agent.log` to detect completed turns, reads the
full user/assistant content from `~/.hermes/state.db`, and writes them through
the configured MemOS MCP tool `add_raw_conversation_turn`. These records are stored as
`memory_type="RawConversationTurn"` with `status="archived"`, so normal memory
search does not recall raw chat logs directly.

By default, raw turns are submitted to MemOS Scheduler/MemReader when any flush
condition is met: 20 completed turns, 30,000 pending characters, or 600 seconds
since the first pending raw turn:

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py \
  --scheduler-batch-turns 20 \
  --scheduler-batch-chars 30000 \
  --scheduler-max-wait-seconds 600
```

To force any pending raw turns into Scheduler immediately:

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --flush-scheduler
```

This keeps every original turn available for audit/backfill while letting MemOS
perform extraction, merging, compression, and archival in batches instead of
processing every single message immediately.

## Files

- `setup.sh` - Automated setup script
- `hermes_log_syncer.py` - Desktop/TUI log-to-MemOS raw turn syncer
- `soul_template.md` - SOUL.md template with memory rules
- `README.md` - This file

## Documentation

See the full integration guide:
- English: `docs/en/integrations/hermes_agent.md`
- 中文: `docs/cn/integrations/hermes_agent.md`

## Architecture

```
Hermes Agent Plugin or Hermes Log Syncer
    ↓ MCP HTTP/SSE
MemOS MCP Server (FastAPI)
    ↓
MOS Core
    ↓
Neo4j + Qdrant
```

## Features

- ✅ Semantic memory search
- ✅ Structured metadata (tags, confidence, relationships)
- ✅ Multi-tenant support
- ✅ Multiple memory types (textual, activation, parametric, preference)
- ✅ Memory scheduler for auto-organization
- ✅ Unlimited capacity (vs 2200 char limit in built-in)

## Comparison

| Feature | Hermes Built-in | MemOS |
|---------|----------------|-------|
| Storage | Local .md files | Neo4j + Qdrant |
| Search | Substring match | Semantic search |
| Metadata | None | Tags, confidence, relationships |
| Multi-tenant | No | Yes |
| Memory types | Text only | Text, activation, parametric, preference |
| Capacity | ~2200 chars | Unlimited |
| Scheduler | No | Yes |

## Troubleshooting

### Hermes still uses built-in memory

- Verify config: `hermes config | grep memory`
- Ensure both `memory_enabled` and `user_profile_enabled` are `false`
- **Restart Hermes completely**

### LLM doesn't call memos tools

- Check SOUL.md has the memory rules
- Restart Hermes to reload SOUL.md
- Explicitly ask: "Use memos to save this"

### MCP connection fails

- Check server: `curl http://127.0.0.1:8766/mcp`
- Check registration: `hermes mcp list`
- Re-add: `hermes mcp add memos --url http://127.0.0.1:8766/mcp`
