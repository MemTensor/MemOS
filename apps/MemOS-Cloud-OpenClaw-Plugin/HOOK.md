---
name: memos-cloud-openclaw-plugin
description: "OpenClaw lifecycle plugin for MemOS Cloud (add + recall memory)"
homepage: https://github.com/MemTensor/MemOS-Cloud-OpenClaw-Plugin
metadata: {
  "openclaw": {
    "emoji": "🧠",
    "events": ["before_agent_start", "agent_end", "command:new"],
    "requires": {
      "bins": ["node"]
    }
  }
}
---

# MemOS Cloud OpenClaw Plugin Hooks

This plugin registers the following OpenClaw lifecycle hooks to interact with MemOS Cloud:

- `before_agent_start`: Intercepts the agent startup sequence to recall relevant memories from MemOS Cloud and injects them into the agent's context.
- `agent_end`: Intercepts the agent termination sequence to capture the completed conversation turn and saves it to MemOS Cloud.
- `command:new`: Increments a numeric conversation suffix when the `/new` command is issued to keep MemOS contexts distinct.
