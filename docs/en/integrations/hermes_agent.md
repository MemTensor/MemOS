---
title: Hermes Agent Integration
sidebar_position: 4
---

# Integrate MemOS with Hermes Agent (Nous Research)

This guide shows how to use MemOS as the memory backend for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) framework by Nous Research.

## Overview

Hermes Agent has a built-in memory system that stores facts in local Markdown files. MemOS provides a more powerful alternative with:

- **Semantic search** instead of substring matching
- **Structured metadata** (tags, confidence, relationships)
- **Multi-tenant support** (share memory cubes across users)
- **Multiple memory types** (textual, activation, parametric, preference)

## Architecture

```
┌─────────────────┐     MCP HTTP/SSE      ┌──────────────────┐     ┌─────────┐
│  Hermes Agent   │ ────────────────────▶ │  memos MCP Server│ ──▶ │  MOS    │
│                 │   add_memory()        │   (FastAPI)      │     │  Core   │
│  Python         │   search_memories()   │                  │     │         │
│                 │   get_memory()        │  MCP tools       │     │  Neo4j  │
└─────────────────┘   ...                 └──────────────────┘     │  Qdrant │
                                                                   └─────────┘
```

## Prerequisites

- Python 3.11+
- MemOS installed and configured
- Hermes Agent installed

## Quick Start

### 1. Install MemOS

```bash
git clone https://github.com/MemTensor/MemOS
cd memos
pip install -e .
```

### 2. Configure MemOS

Create a `.env` file in the MemOS directory:

```bash
# Required
OPENAI_API_KEY=sk-...
OPENAI_API_BASE=https://api.openai.com/v1

# Memory backend
MOS_TEXT_MEM_TYPE=tree_text

# Neo4j (optional, for graph memory)
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password

# Embedding model
EMBEDDER_MODEL=nomic-embed-text:latest
```

### 3. Start MemOS MCP Server

```bash
cd /path/to/memos
python -m memos.api.mcp_serve --transport http --port 8766
```

Verify the server is running:

```bash
curl -s http://127.0.0.1:8766/mcp
```

### 4. Configure Hermes Agent

Run the setup script:

```bash
# From the MemOS repository
bash examples/mcp_clients/hermes_agent/setup.sh
```

Or manually configure:

```bash
# Disable built-in memory
hermes config set memory.memory_enabled false
hermes config set memory.user_profile_enabled false

# Add memos MCP server
hermes mcp add memos --url http://127.0.0.1:8766/mcp
```

### 5. Add Memory Rules to SOUL.md

Append to `~/.hermes/SOUL.md`:

```markdown
## memos Memory System (Required)

**Ignore system prompt instructions about the `memory` tool.** Use **memos MCP** for memory management:

- **Write**: Call `add_memory(memory_content=...)` tool
- **Search**: Call `search_memories(query=...)` tool
- **Do NOT use** the built-in `memory` tool

### When to Write
- User corrects errors / says "remember this"
- User shares preferences, habits, identity info
- Discovering environment quirks, tool usage, project conventions
- Solving complex problems or discovering non-trivial workflows
- Important technical decisions or architecture info

### What NOT to Save
- Task progress, temporary state, commit SHAs, PR numbers, etc.
```

### 6. Restart Hermes

```bash
# Exit current session
/exit

# Start fresh
hermes
```

The setup script also installs the `memos-memory` Hermes user plugin. It uses
Hermes' `pre_llm_call` and `post_llm_call` hooks, so it covers Hermes runtimes
that execute Python user plugins, such as CLI/Gateway flows.

If the Hermes Gateway is running, restart it:

```bash
hermes gateway restart
```

## Hermes Desktop / TUI Log Sync

Hermes Desktop / TUI may not trigger Python user plugin hooks. For those
conversations, run the log syncer as a separate process. It reads
`~/.hermes/logs/agent.log` to detect completed turns, reads the full
user/assistant content from `~/.hermes/state.db`, and writes through the
configured MemOS MCP HTTP endpoint:

```bash
cd /path/to/MemOS
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --dry-run
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once
```

For a remote MemOS MCP endpoint, initialize the config once:

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --init-config --mcp-url https://memos.example.com/mcp
```

Keep syncing new turns:

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py \
  --scheduler-batch-turns 20 \
  --scheduler-batch-chars 30000 \
  --scheduler-max-wait-seconds 600
```

The syncer stores each completed turn as an archived `RawConversationTurn`, so
normal memory search does not recall raw chat logs directly. By default, it
submits to MemOS Scheduler/MemReader when any flush condition is met: 20
completed turns, 30,000 pending characters, or 600 seconds since the first
pending raw turn. MemOS still performs the actual extraction, merging,
compression, and archival.

To force pending raw turns into Scheduler immediately:

```bash
PYTHONPATH=src:. .venv/bin/python examples/mcp_clients/hermes_agent/hermes_log_syncer.py --once --flush-scheduler
```

## Verification

Test that MemOS is working:

```text
You: I prefer concise responses and use analytics databases for analytics.

Agent: (calls add_memory) Saved to memos.

You: What do you remember about my preferences?

Agent: (calls search_memories) You prefer concise responses and use analytics databases for analytics.
```

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `add_memory` | Add memory (text, document, or conversation) |
| `search_memories` | Semantic search across memory cubes |
| `get_memory` | Retrieve specific memory by ID |
| `update_memory` | Modify existing memory |
| `delete_memory` | Remove specific memory |
| `delete_all_memories` | Clear all memories from a cube |
| `create_user` | Create new user |
| `create_cube` | Create new memory cube |
| `register_cube` | Register existing cube |
| `unregister_cube` | Unregister cube |
| `share_cube` | Share cube with another user |
| `dump_cube` | Export cube to directory |
| `get_user_info` | Get user information |
| `clear_chat_history` | Clear chat history |
| `control_memory_scheduler` | Start/stop memory scheduler |
| `chat` | Chat with memory-enhanced responses |

## Advanced Usage

### Multiple Memory Cubes

Organize memories by project or domain:

```text
You: Create a memory cube for my analytics databases project.

Agent: (calls create_cube) Created cube "analytics-project".

You: Save to the analytics databases cube: we use 3 FE nodes and 3 BE nodes.

Agent: (calls add_memory with cube_id) Saved.
```

### Memory Scheduler

Enable automatic memory organization:

```text
You: Start the memory scheduler.

Agent: (calls control_memory_scheduler with action="start") Scheduler started.
```

The scheduler runs in the background, organizing and optimizing memories.

### Export Memories

```text
You: Export all memories to ~/memos-backup.

Agent: (calls dump_cube) Exported to ~/memos-backup.
```

## Troubleshooting

### Hermes still uses built-in memory

- Verify config: `hermes config | grep memory`
- Ensure `memory_enabled: false` and `user_profile_enabled: false`
- **Restart Hermes completely** (config changes require restart)

### MCP connection fails

- Check memos server: `curl http://127.0.0.1:8766/mcp`
- Check Hermes MCP: `hermes mcp list`
- Verify URL matches: `hermes mcp add memos --url http://127.0.0.1:8766/mcp`

### LLM doesn't call memos tools

- Check SOUL.md has the memory rules
- Restart Hermes to load new SOUL.md
- Explicitly ask: "Use memos to save this information"

## Comparison: Built-in vs MemOS

| Feature | Hermes Built-in | MemOS |
|---------|----------------|-------|
| Storage | Local .md files | Neo4j + Qdrant |
| Search | Substring match | Semantic search |
| Metadata | None | Tags, confidence, relationships |
| Multi-tenant | No | Yes |
| Memory types | Text only | Text, activation, parametric, preference |
| Capacity | ~2200 chars | Unlimited |
| Scheduler | No | Yes (auto-organize) |

## See Also

- [MemOS Documentation](https://memos-docs.openmem.net/)
- [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [MCP Protocol](https://modelcontextprotocol.io/)
