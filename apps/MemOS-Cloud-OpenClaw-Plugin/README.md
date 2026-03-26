# MemOS Cloud OpenClaw Plugin (Lifecycle)

Official plugin maintained by MemTensor.

A minimal OpenClaw lifecycle plugin that **recalls** memories from MemOS Cloud before each run and **adds** new messages to MemOS Cloud after each run.

## Features
- **Recall**: `before_agent_start` → `/search/memory`
- **Add**: `agent_end` → `/add/message`
- Uses **Token** auth (`Authorization: Token <MEMOS_API_KEY>`)

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
        "C:\\Users\\YourName\\.openclaw\\extensions\\memos-cloud-openclaw-plugin\\package"
      ]
    }
  }
}
```
*Note: The extracted folder usually contains a `package` subfolder. Point to the folder containing `package.json`.*

Restart the gateway after config changes.

## Environment Variables
The plugin tries env files in order (**openclaw → moltbot → clawdbot**). For each key, the first file with a value wins.
If none of these files exist (or the key is missing), it falls back to the process environment.

**Where to configure**
- Files (priority order):
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- Each line is `KEY=value`

**Quick setup (shell)**
```bash
echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.zshrc
source ~/.zshrc
# or

echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.bashrc
source ~/.bashrc
```

**Quick setup (Windows PowerShell)**
```powershell
[System.Environment]::SetEnvironmentVariable("MEMOS_API_KEY", "mpg-...", "User")
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
- `MEMOS_CONVERSATION_ID` (optional override)
- `MEMOS_RECALL_GLOBAL` (default: `true`; when true, search does **not** pass conversation_id)
- `MEMOS_MULTI_AGENT_MODE` (default: `false`; enable multi-agent data isolation)
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX` (optional)
- `MEMOS_CONVERSATION_SUFFIX_MODE` (`none` | `counter`, default: `none`)
- `MEMOS_CONVERSATION_RESET_ON_NEW` (default: `true`, requires hooks.internal.enabled)
- `MEMOS_RECALL_FILTER_ENABLED` (default: `false`; run model-based memory filtering before injection)
- `MEMOS_RECALL_FILTER_BASE_URL` (OpenAI-compatible base URL, e.g. `http://127.0.0.1:11434/v1`)
- `MEMOS_RECALL_FILTER_API_KEY` (optional; required if your endpoint needs auth)
- `MEMOS_RECALL_FILTER_MODEL` (model name used to filter recall candidates)
- `MEMOS_RECALL_FILTER_TIMEOUT_MS` (default: `6000`)
- `MEMOS_RECALL_FILTER_RETRIES` (default: `0`)
- `MEMOS_RECALL_FILTER_CANDIDATE_LIMIT` (default: `30` per category)
- `MEMOS_RECALL_FILTER_MAX_ITEM_CHARS` (default: `500`)
- `MEMOS_RECALL_FILTER_FAIL_OPEN` (default: `true`; fallback to unfiltered recall on failure)

## Optional Plugin Config
In `plugins.entries.memos-cloud-openclaw-plugin.config`:
```json
{
  "baseUrl": "https://memos.memtensor.cn/api/openmem/v1",
  "apiKey": "YOUR_API_KEY",
  "userId": "memos_user_123",
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
  "asyncMode": true,
  "recallFilterEnabled": false,
  "recallFilterBaseUrl": "http://127.0.0.1:11434/v1",
  "recallFilterApiKey": "",
  "recallFilterModel": "qwen2.5:7b",
  "recallFilterTimeoutMs": 6000,
  "recallFilterRetries": 0,
  "recallFilterCandidateLimit": 30,
  "recallFilterMaxItemChars": 500,
  "recallFilterFailOpen": true
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

## Notes
- `conversation_id` defaults to OpenClaw `sessionKey` (unless `conversationId` is provided). **TODO**: consider binding to OpenClaw `sessionId` directly.
- Optional **prefix/suffix** via env or config; `conversationSuffixMode=counter` increments on `/new` (requires `hooks.internal.enabled`).

## Acknowledgements
- Thanks to @anatolykoptev (Contributor) — LinkedIn: https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
