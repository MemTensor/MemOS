# MemOS Cloud OpenClaw Plugin (Lifecycle)

Official plugin maintained by MemTensor.

A minimal OpenClaw lifecycle plugin that **recalls** memories from MemOS Cloud before each run and **adds** new messages to MemOS Cloud after each run.

## Features
- **Recall**: `before_agent_start` → `/search/memory`
- **Add**: `agent_end` → `/add/message`
- **Config UI**: starting the gateway also starts a local plugin config page for editing `plugins.entries.memos-cloud-openclaw-plugin.config`
- Uses **Token** auth (`Authorization: Token <MEMOS_API_KEY>`)

## Config UI
- On gateway start, the plugin launches a local config page and prints the URL in the terminal (default: `http://127.0.0.1:38463`).
- The page reads and writes the host config file directly:
  - OpenClaw: `~/.openclaw/openclaw.json`
  - Moltbot: `~/.moltbot/moltbot.json`
  - ClawDBot: `~/.clawdbot/clawdbot.json`
- If the preferred UI port is already in use, the plugin automatically picks the next free port.
- Saving changes writes `plugins.entries.memos-cloud-openclaw-plugin.config`. (Note: you may need to manually restart the gateway after saving for settings to take effect).

## Install

### Option A — NPM (Recommended)
```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

> **Note for Windows Users**:
> If you encounter `Error: spawn EINVAL`, this is a known issue with OpenClaw's plugin installer on Windows. Please use **Option B** (Manual Install) below.

Make sure it’s enabled in `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    }
  }
}
```

### Option B — Manual Install (Workaround for Windows)
1. Download the latest `.tgz` from [NPM](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin).
2. Extract it to a local folder (e.g., `C:\Users\YourName\.openclaw\extensions\memos-cloud-openclaw-plugin`).
3. Configure `~/.openclaw/openclaw.json` (or `%USERPROFILE%\.openclaw\openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    },
    "load": {
      "paths": [
        "C:\\Users\\YourName\\.openclaw\\extensions\\memos-cloud-openclaw-plugin"
      ]
    }
  }
}
```
*Note: The extracted folder usually contains a `package` subfolder. Point to the folder containing `package.json`.*

Restart the gateway after config changes.

## Environment Variables
The plugin resolves runtime config in this order: **plugin config → env files**. Due to strict security sandboxing, it **does not** read credentials from process environment variables.
For env files, it tries them in order (**openclaw → moltbot → clawdbot**). For each key, the first file with a value wins.

**Where to configure**
- Files (priority order):
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- Each line is `KEY=value`

**Quick setup (shell / Windows)**
```bash
echo 'MEMOS_API_KEY="mpg-..."' >> ~/.openclaw/.env
```

If `MEMOS_API_KEY` is missing, the plugin will warn with setup instructions and the API key URL.

**Minimal config**
```env
MEMOS_API_KEY=YOUR_TOKEN
```

**Optional config**
- `MEMOS_BASE_URL` (default: `https://memos.memtensor.cn/api/openmem/v1`)
- `MEMOS_API_KEY` (required; Token auth) — get it at https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID` (optional; default: `openclaw-user`)
- `MEMOS_USE_DIRECT_SESSION_USER_ID` (default: `false`; when enabled, direct session keys like `agent:main:<provider>:direct:<peer-id>` use `<peer-id>` as MemOS `user_id`)
- `MEMOS_CONVERSATION_ID` (optional override)
- `MEMOS_KNOWLEDGEBASE_IDS` (optional; comma-separated global knowledge base IDs for `/search/memory`, e.g., `"kb-123, kb-456"`)
- `MEMOS_ALLOW_KNOWLEDGEBASE_IDS` (optional; comma-separated knowledge base IDs for `/add/message`, e.g., `"kb-123"`)
- `MEMOS_TAGS` (optional; comma-separated tags for `/add/message`, default: `"openclaw"`, e.g., `"openclaw, dev"`)
- `MEMOS_RECALL_GLOBAL` (default: `true`; when true, search does **not** pass conversation_id)
- `MEMOS_MULTI_AGENT_MODE` (default: `false`; enable multi-agent data isolation)
- `MEMOS_ALLOWED_AGENTS` (optional; comma-separated allowlist for multi-agent mode, e.g. `"agent1,agent2"`; empty means all agents enabled)
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX` (optional)
- `MEMOS_CONVERSATION_SUFFIX_MODE` (`none` | `counter`, default: `none`)
- `MEMOS_CONVERSATION_RESET_ON_NEW` (default: `true`, requires hooks.internal.enabled)
- `MEMOS_RECALL_FILTER_ENABLED` (default: `false`; run model-based memory filtering before injection)
- `MEMOS_RECALL_FILTER_BASE_URL` (OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`)
- `MEMOS_RECALL_FILTER_API_KEY` (optional; required if your endpoint needs auth)
- `MEMOS_RECALL_FILTER_MODEL` (model name used to filter recall candidates)
- `MEMOS_RECALL_FILTER_TIMEOUT_MS` (default: `30000`)
- `MEMOS_RECALL_FILTER_RETRIES` (default: `1`)
- `MEMOS_RECALL_FILTER_CANDIDATE_LIMIT` (default: `30` per category)
- `MEMOS_RECALL_FILTER_MAX_ITEM_CHARS` (default: `500`)
- `MEMOS_RECALL_FILTER_FAIL_OPEN` (default: `true`; fallback to unfiltered recall on failure)
- `MEMOS_CAPTURE_STRATEGY` (default: `last_turn`)
- `MEMOS_ASYNC_MODE` (default: `true`; non-blocking memory addition)
- `MEMOS_THROTTLE_MS` (default: `0`; throttle memory requests)
- `MEMOS_INCLUDE_ASSISTANT` (default: `true`; include assistant messages in memory)
- `MEMOS_MAX_MESSAGE_CHARS` (default: `20000`; max characters for message history)

## Optional Plugin Config
In `plugins.entries.memos-cloud-openclaw-plugin.config`:
```json
{
  "baseUrl": "https://memos.memtensor.cn/api/openmem/v1",
  "apiKey": "YOUR_API_KEY",
  "userId": "memos_user_123",
  "useDirectSessionUserId": false,
  "conversationId": "openclaw-main",
  "queryPrefix": "important user context preferences decisions ",
  "recallEnabled": true,
  "recallGlobal": true,
  "addEnabled": true,
  "captureStrategy": "last_turn",
  "maxItemChars": 8000,
  "includeAssistant": true,
  "conversationIdPrefix": "",
  "conversationIdSuffix": "",
  "conversationSuffixMode": "none",
  "resetOnNew": true,
  "knowledgebaseIds": [],
  "memoryLimitNumber": 6,
  "preferenceLimitNumber": 6,
  "includePreference": true,
  "includeToolMemory": false,
  "toolMemoryLimitNumber": 6,
  "relativity": 0.45,
  "tags": ["openclaw"],
  "agentId": "",
  "multiAgentMode": false,
  "allowedAgents": [],
  "asyncMode": true,
  "recallFilterEnabled": false,
  "recallFilterBaseUrl": "http://127.0.0.1:11434/v1",
  "recallFilterApiKey": "",
  "recallFilterModel": "qwen2.5:7b",
  "recallFilterTimeoutMs": 30000,
  "recallFilterRetries": 1,
  "recallFilterCandidateLimit": 30,
  "recallFilterMaxItemChars": 500,
  "recallFilterFailOpen": true,
  "throttleMs": 0,
  "maxMessageChars": 20000
}
```

## How it Works
- **Recall** (`before_agent_start`)
  - Builds a `/search/memory` request using `user_id`, `query` (= prompt + optional prefix), and optional filters.
  - Default **global recall**: when `recallGlobal=true`, it does **not** pass `conversation_id`.
  - Optional second-pass filtering: if `recallFilterEnabled=true`, candidates are sent to your configured model and only returned `keep` items are injected.
  - Injects a stable MemOS recall protocol via `appendSystemContext`, while the retrieved `<memories>` block remains in `prependContext`.

- **Add** (`agent_end`)
  - Builds a `/add/message` request with the **last turn** by default (user + assistant).
  - Sends `messages` with `user_id`, `conversation_id`, and optional `tags/info/agent_id/app_id`.

## Multi-Agent Support
The plugin provides native support for multi-agent architectures (via the `agent_id` parameter):
- **Enable Mode**: Set `"multiAgentMode": true` in config or `MEMOS_MULTI_AGENT_MODE=true` in env variables (default is `false`).
- **Dynamic Context**: When enabled, it automatically captures `ctx.agentId` during OpenClaw lifecycle hooks. (Note: the default OpenClaw agent `"main"` is ignored to preserve backwards compatibility for single-agent users).
- **Data Isolation**: The `agent_id` is automatically injected into both `/search/memory` and `/add/message` requests. This ensures completely isolated memory and message histories for different agents, even under the same user or session.
- **Static Override**: You can also force a specific agent ID by setting `"agentId": "your_agent_id"` in the plugin's `config`.

### Per-Agent Memory Toggle

In multi-agent mode, you can use `MEMOS_ALLOWED_AGENTS` to control exactly which agents have memory enabled. Agents not in the allowlist will skip both memory recall and memory capture entirely.

**Environment variable** (in `~/.openclaw/.env`):
```env
MEMOS_MULTI_AGENT_MODE=true
MEMOS_ALLOWED_AGENTS="agent1,agent2"
```

Separate multiple agent IDs with commas.

**Plugin config** (in `openclaw.json`):
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "enabled": true,
        "config": {
          "multiAgentMode": true,
          "allowedAgents": ["agent1", "agent2"]
        }
      }
    }
  }
}
```

**Behavior**:
| Config | Effect |
|--------|--------|
| `MEMOS_ALLOWED_AGENTS` unset or empty | All agents have memory enabled |
| `MEMOS_ALLOWED_AGENTS="agent1,agent2"` | Only `agent1` and `agent2` are enabled; others are skipped |
| `MEMOS_ALLOWED_AGENTS="agent1"` | Only `agent1` is enabled; all other agents are skipped |
| `MEMOS_MULTI_AGENT_MODE=false` | Allowlist has no effect; all requests use single-agent mode |

> **Note**: The allowlist only takes effect when `multiAgentMode=true`. When multi-agent mode is off, memory works for all agents and the allowlist is ignored.

### Per-Agent Configuration (agentOverrides)

Beyond simple on/off toggles, you can configure **different memory parameters for each agent** using `agentOverrides`. Each agent can have its own knowledge base, recall limits, relativity threshold, and more.

**Plugin config** (in `openclaw.json`):
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": {
        "enabled": true,
        "config": {
          "multiAgentMode": true,
          "allowedAgents": ["default", "research-agent", "coding-agent"],
          "knowledgebaseIds": [],
          "memoryLimitNumber": 6,
          "relativity": 0.45,

          "agentOverrides": {
            "research-agent": {
              "knowledgebaseIds": ["kb-research-papers", "kb-academic"],
              "memoryLimitNumber": 12,
              "relativity": 0.3,
              "includeToolMemory": true,
              "captureStrategy": "full_session",
              "queryPrefix": "research context: "
            },
            "coding-agent": {
              "knowledgebaseIds": ["kb-codebase", "kb-api-docs"],
              "memoryLimitNumber": 9,
              "relativity": 0.5,
              "addEnabled": false
            }
          }
        }
      }
    }
  }
}
```

**Environment variable** (in `~/.openclaw/.env`):
You can use `MEMOS_AGENT_OVERRIDES` to configure a JSON string to override global parameters. Note: `.env` configuration has a lower priority than `agentOverrides` in `openclaw.json`.
```env
MEMOS_AGENT_OVERRIDES='{"research-agent": {"memoryLimitNumber": 12, "relativity": 0.3}, "coding-agent": {"memoryLimitNumber": 9}}'
```

**How it works**:
- Fields in `agentOverrides.<agentId>` override the global defaults for that specific agent.
- Only the fields you specify are overridden; all other parameters inherit from the global config.
- If no override exists for an agent, it uses the global config as-is.

**Overridable fields**:

| Field | Description |
|-------|-------------|
| `knowledgebaseIds` | Knowledge base IDs for `/search/memory` |
| `memoryLimitNumber` | Max memory items to recall |
| `preferenceLimitNumber` | Max preference items to recall |
| `includePreference` | Enable preference recall |
| `includeToolMemory` | Enable tool memory recall |
| `toolMemoryLimitNumber` | Max tool memory items |
| `relativity` | Relevance threshold (0-1) |
| `recallEnabled` | Enable/disable recall for this agent |
| `addEnabled` | Enable/disable memory capture for this agent |
| `captureStrategy` | `last_turn` or `full_session` |
| `queryPrefix` | Prefix for search queries |
| `maxItemChars` | Max chars per memory item in prompt |
| `maxMessageChars` | Max chars per message when adding |
| `includeAssistant` | Include assistant messages in capture |
| `recallGlobal` | Global recall (skip conversation_id) |
| `recallFilterEnabled` | Enable model-based recall filtering |
| `recallFilterModel` | Model for recall filtering |
| `recallFilterBaseUrl` | Base URL for recall filter model |
| `recallFilterApiKey` | API key for recall filter |
| `allowKnowledgebaseIds` | Knowledge bases for `/add/message` |
| `tags` | Tags for `/add/message` |
| `throttleMs` | Throttle interval |

## Direct Session User ID
- **Default behavior**: the plugin still uses the configured `userId` (or `MEMOS_USER_ID`) and stays fully backward compatible.
- **Enable mode**: set `"useDirectSessionUserId": true` in plugin config or `MEMOS_USE_DIRECT_SESSION_USER_ID=true` in env.
- **What it does**: when enabled, session keys like `agent:main:<provider>:direct:<peer-id>` reuse `<peer-id>` as MemOS `user_id`.
- **What it does not do**: non-direct session keys such as `agent:main:<provider>:channel:<channel-id>` keep using the configured fallback `userId`.
- **Request paths affected**: the same resolver is used by both `buildSearchPayload()` and `buildAddMessagePayload()`, so recall and add stay consistent.
- **Config precedence**: runtime config still follows the same rule as the rest of the plugin - plugin config first, then `.env` files (`~/.openclaw/.env` -> `~/.moltbot/.env` -> `~/.clawdbot/.env`).


## Notes
- `conversation_id` defaults to OpenClaw `sessionKey` (unless `conversationId` is provided). **TODO**: consider binding to OpenClaw `sessionId` directly.
- Optional **prefix/suffix** via env or config; `conversationSuffixMode=counter` increments on `/new` (requires `hooks.internal.enabled`).

## Acknowledgements
- Thanks to @anatolykoptev (Contributor) — LinkedIn: https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
