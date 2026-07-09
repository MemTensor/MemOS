---
title: Multi-Agent Memory Isolation
---

## Cloud Plugin

The MemOS OpenClaw Cloud plugin supports complete isolation of memory and message history across multiple Agents. Each Agent can only access its own memory, preventing cross-agent interference.

### How to Use in Cloud Plugin

With a simple configuration, different Agents can have independent memory spaces. Both auto-detection and static assignment are supported.

#### 1. Enable Multi-Agent Mode

Add the following to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "config": {
          "multiAgentMode": true
        }
      }
    }
  }
}
```

Or set the environment variable:

```bash
MEMOS_MULTI_AGENT_MODE=true
```

#### 2. Auto-detect Agent

Once enabled, the plugin automatically reads `ctx.agentId` and isolates memory for each Agent. No extra configuration is required.

#### 3. Statically Assign Agent (Optional)

If you need to pin a specific Agent ID, set it in the config:

```json
{
  "config": {
    "agentId": "marketing_agent"
  }
}
```

### Principles

- **/search/memory**: Memory retrieval — returns only the current Agent's memories
- **/add/message**: Record insertion — automatically tags data for the current Agent
- **Backward compatibility**: Default Agent `"main"` is ignored to keep existing single-Agent data unaffected

### Use Cases

- **Multi-role collaboration**: Strategy, business, marketing, and engineering Agents can work in parallel
- **Business-line isolation**: Agents from different business lines run independently without interference
- **Persona consistency**: Preserve each Agent's long-term persona and behavior style

---

## Local Plugin

`@memtensor/memos-local-plugin` supports both OpenClaw and Hermes. By default, each agent uses its own runtime home and local database. If multiple sessions / agents share one runtime, retrieval is scoped toward the current agent context. For cross-instance collaboration, enable team sharing from **Viewer → Settings → Team Sharing**.

### Rules

- **Isolated by default**: OpenClaw uses `~/.openclaw/memos-plugin/`, while Hermes uses `~/.hermes/memos-plugin/`. They do not share databases automatically.
- **Current agent first**: retrieval prioritizes the current agent / session's Traces, Policies, World Models, and Skills.
- **Optional sharing**: when `hub.enabled` is on, instances can share locally crystallized Skills and optional trace excerpts over a LAN / VPN.
- **Graceful fallback**: Hub is not on the algorithm critical path. If sharing is unavailable, the plugin falls back to local-only memory.

### Example Workflow

```text
OpenClaw:
  memory_search("deploy config")
  → prioritizes OpenClaw's local Skill / Trace / World Model store

Hermes:
  memory_search("deploy config")
  → prioritizes Hermes' local Skill / Trace / World Model store

With Hub enabled:
  OpenClaw / Hermes can pull team-shared Skills
  private Traces remain local to each machine and runtime home by default
```

### Expected Results

- OpenClaw and Hermes do not read each other's local database by default
- Team members can explicitly share high-value Skills to avoid repeating mistakes
- Local writes, retrieval, and skill lookup continue to work even if Hub is unavailable
