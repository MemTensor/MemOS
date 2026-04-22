---
name: browserwing-admin
description: Manage and operate BrowserWing — an intelligent browser automation platform. Install dependencies, configure LLM, create/manage/execute automation scripts, use AI-driven exploration to generate scripts, browse the script marketplace, and troubleshoot issues.
---

# BrowserWing Admin Skill

## Overview

BrowserWing is an intelligent browser automation platform that allows you to:
- Record, create, and replay browser automation scripts
- Use AI to autonomously explore websites and generate replayable scripts
- Execute scripts via HTTP API or MCP protocol
- Manage LLM configurations for AI-powered features

**API Base URL:** `http://localhost:8080/api/v1`

**Authentication:** Use `X-BrowserWing-Key: <api-key>` header or `Authorization: Bearer <token>`

---

## 1. Installing Google Chrome (Prerequisite)

BrowserWing requires Google Chrome to be installed on the host machine.

### Linux (Debian/Ubuntu)
```bash
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" | sudo tee /etc/apt/sources.list.d/google-chrome.list
sudo apt-get update
sudo apt-get install -y google-chrome-stable
```

### macOS
```bash
brew install --cask google-chrome
```

### Windows
Download and install from: https://www.google.com/chrome/

### Verify Installation
```bash
google-chrome --version
# or on macOS:
# /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --version
```

### Using Remote Chrome (Alternative)
If Chrome is running on a remote machine with debugging enabled:
```bash
google-chrome --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --no-sandbox
```
Then configure BrowserWing's `config.toml`:
```toml
[browser]
control_url = 'http://<remote-host>:9222'
```

---

## 2. LLM Configuration

AI features (AI Explorer, Agent chat, smart extraction) require an LLM configuration.

### List LLM Configs
```bash
curl -X GET 'http://localhost:8080/api/v1/llm-configs'
```

### Add LLM Config
```bash
curl -X POST 'http://localhost:8080/api/v1/llm-configs' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "my-openai",
    "provider": "openai",
    "api_key": "sk-xxx",
    "model": "gpt-4o",
    "base_url": "https://api.openai.com/v1",
    "is_active": true,
    "is_default": true
  }'
```
**Supported providers:** `openai`, `anthropic`, `deepseek`, or any OpenAI-compatible endpoint.

### Test LLM Config
```bash
curl -X POST 'http://localhost:8080/api/v1/llm-configs/test' \
  -H 'Content-Type: application/json' \
  -d '{"name": "my-openai"}'
```

### Update LLM Config
```bash
curl -X PUT 'http://localhost:8080/api/v1/llm-configs/<config-id>' \
  -H 'Content-Type: application/json' \
  -d '{"api_key": "sk-new-key", "model": "gpt-4o-mini"}'
```

### Delete LLM Config
```bash
curl -X DELETE 'http://localhost:8080/api/v1/llm-configs/<config-id>'
```

---

## 3. AI Autonomous Exploration (Generate Scripts Automatically)

Use AI to browse a website, perform a task, and automatically generate a replayable script.

### Start Exploration
```bash
curl -X POST 'http://localhost:8080/api/v1/ai-explore/start' \
  -H 'Content-Type: application/json' \
  -d '{
    "task_desc": "Go to bilibili.com, search for 'AI', and get the first page of video results",
    "start_url": "https://www.bilibili.com",
    "llm_config_id": "my-openai"
  }'
```
**Response:** Returns a session `id` for tracking.

### Stream Exploration Events (SSE)
```bash
curl -N 'http://localhost:8080/api/v1/ai-explore/<session-id>/stream'
```
Returns real-time Server-Sent Events: `thinking`, `tool_call`, `progress`, `error`, `script_ready`, `done`.

### Stop Exploration
```bash
curl -X POST 'http://localhost:8080/api/v1/ai-explore/<session-id>/stop'
```

### Get Generated Script
```bash
curl -X GET 'http://localhost:8080/api/v1/ai-explore/<session-id>/script'
```

### Save Generated Script
```bash
curl -X POST 'http://localhost:8080/api/v1/ai-explore/<session-id>/save'
```
Saves the generated script to the local script library for future replay.

---

## 4. Script Management

### List All Scripts
```bash
curl -X GET 'http://localhost:8080/api/v1/scripts'
```
Returns all local scripts with their `id`, `name`, `description`, `actions`, `tags`, `group`, etc.

### Get Script Details
```bash
curl -X GET 'http://localhost:8080/api/v1/scripts/<script-id>'
```

### Get Script Schema / Summary
```bash
curl -X GET 'http://localhost:8080/api/v1/scripts/summary'
```
Returns a concise summary of all scripts, including names, descriptions, input parameters (variables), and action counts. Useful for programmatic discovery.

### Create a New Script
```bash
curl -X POST 'http://localhost:8080/api/v1/scripts' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Search Bilibili",
    "description": "Search for a keyword on Bilibili",
    "url": "https://www.bilibili.com",
    "actions": [
      {"type": "navigate", "url": "https://www.bilibili.com"},
      {"type": "click", "identifier": ".nav-search-input"},
      {"type": "type", "identifier": ".nav-search-input", "value": "${keyword}"},
      {"type": "press_key", "key": "Enter"},
      {"type": "wait", "timeout": 3}
    ]
  }'
```
**Variables:** Use `${variable_name}` syntax in action values. These become input parameters when the script is executed.

### Update a Script
```bash
curl -X PUT 'http://localhost:8080/api/v1/scripts/<script-id>' \
  -H 'Content-Type: application/json' \
  -d '{"name": "Updated Name", "description": "Updated description"}'
```

### Delete a Script
```bash
curl -X DELETE 'http://localhost:8080/api/v1/scripts/<script-id>'
```

### Export Scripts as Skill (Convert to SKILL.md)

Convert one or more scripts into a SKILL.md file that can be imported by AI agents (e.g., Claude, Cursor). This allows other AI agents to discover and execute your BrowserWing scripts.

#### Export Selected Scripts
```bash
curl -X POST 'http://localhost:8080/api/v1/scripts/export/skill' \
  -H 'Content-Type: application/json' \
  -d '{
    "script_ids": ["script-id-1", "script-id-2", "script-id-3"]
  }'
```
Merges multiple scripts into a single SKILL.md with all their actions, variables, and descriptions.

#### Export All Scripts
```bash
curl -X POST 'http://localhost:8080/api/v1/scripts/export/skill' \
  -H 'Content-Type: application/json' \
  -d '{"script_ids": []}'
```
Pass an empty `script_ids` array to export **all** scripts into one SKILL.md.

#### Export Executor Skill (Browser Control API)
```bash
curl -X GET 'http://localhost:8080/api/v1/executor/export/skill'
```
Exports the low-level browser automation API as a skill, allowing an AI agent to directly control the browser (navigate, click, type, extract, etc.).

**Workflow: Script → Skill → AI Agent**
```
1. Create scripts (manually, by recording, or via AI exploration)
2. Export them as SKILL.md: POST /scripts/export/skill
3. Place the SKILL.md in your AI agent's skill directory
4. The AI agent can now discover and call your scripts via POST /scripts/<id>/play
```

---

## 5. Execute Scripts

### Run a Script by ID
```bash
curl -X POST 'http://localhost:8080/api/v1/scripts/<script-id>/play' \
  -H 'Content-Type: application/json' \
  -d '{
    "variables": {
      "keyword": "deepseek"
    }
  }'
```
**Variables:** Pass values for `${variable_name}` placeholders defined in the script actions.

### Get Play Result (Extracted Data)
```bash
curl -X GET 'http://localhost:8080/api/v1/scripts/play/result'
```
Returns data extracted during the last script execution (e.g., scraped content from `execute_js` actions).

### List Script Execution History
```bash
curl -X GET 'http://localhost:8080/api/v1/script-executions?page=1&page_size=20'
```

---

## 6. Script Marketplace (Remote Scripts)

*Note: The remote script marketplace feature is under development. The following APIs may not be available yet.*

### Browse Marketplace
```bash
# TODO: curl -X GET 'http://localhost:8080/api/v1/marketplace/scripts?category=search&page=1'
```

### Install Script from Marketplace
```bash
# TODO: curl -X POST 'http://localhost:8080/api/v1/marketplace/scripts/<remote-id>/install'
```

---

## 7. MCP (Model Context Protocol) Integration

BrowserWing exposes an MCP-compatible endpoint for AI agent integrations.

### MCP SSE Endpoint
```
SSE:     http://localhost:8080/api/v1/mcp/sse
Message: http://localhost:8080/api/v1/mcp/sse_message
```

### Check MCP Status
```bash
curl -X GET 'http://localhost:8080/api/v1/mcp/status'
```

### List MCP Commands
```bash
curl -X GET 'http://localhost:8080/api/v1/mcp/commands'
```
Shows all registered MCP tools (browser tools + script-based custom commands).

---

## 8. Prompt Management

System prompts control AI behavior. Users can customize them.

### List All Prompts
```bash
curl -X GET 'http://localhost:8080/api/v1/prompts'
```

### Get a Specific Prompt
```bash
curl -X GET 'http://localhost:8080/api/v1/prompts/<prompt-id>'
```
**System prompt IDs:** `system-extractor`, `system-formfiller`, `system-aiagent`, `system-get-mcp-info`, `system-ai-explorer`

### Update a Prompt
```bash
curl -X PUT 'http://localhost:8080/api/v1/prompts/<prompt-id>' \
  -H 'Content-Type: application/json' \
  -d '{"content": "Your custom prompt content here..."}'
```

---

## 9. Browser Instance Management

### List Browser Instances
```bash
curl -X GET 'http://localhost:8080/api/v1/browser/instances'
```

### Start a Browser Instance
```bash
curl -X POST 'http://localhost:8080/api/v1/browser/instances/<id>/start'
```

### Stop a Browser Instance
```bash
curl -X POST 'http://localhost:8080/api/v1/browser/instances/<id>/stop'
```

---

## 10. Cookie Management

Manage browser cookies — view saved cookies, import cookies (e.g., for authenticated sessions), and delete cookies.

### View Saved Cookies
```bash
curl -X GET 'http://localhost:8080/api/v1/cookies/browser'
```
Returns all cookies saved under the `browser` store ID (the default store). Replace `browser` with a custom store ID if needed.

### Save Current Browser Cookies
```bash
curl -X POST 'http://localhost:8080/api/v1/browser/cookies/save'
```
Saves all cookies from the current browser session to the database. Requires the browser to be running.

### Import Cookies
```bash
curl -X POST 'http://localhost:8080/api/v1/browser/cookies/import' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com",
    "cookies": [
      {
        "name": "session_id",
        "value": "abc123",
        "domain": ".example.com",
        "path": "/",
        "secure": true,
        "httpOnly": true,
        "sameSite": "Lax",
        "expires": 1735689600
      }
    ]
  }'
```
**Fields:** `name` and `value` are required. `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expires` are optional (`path` defaults to `/`).

### Delete a Single Cookie
```bash
curl -X POST 'http://localhost:8080/api/v1/browser/cookies/delete' \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "browser",
    "name": "session_id",
    "domain": ".example.com",
    "path": "/"
  }'
```
Deletes a specific cookie identified by `name` + `domain` + `path` from the given cookie store.

### Batch Delete Cookies
```bash
curl -X POST 'http://localhost:8080/api/v1/browser/cookies/batch/delete' \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "browser",
    "cookies": [
      {"name": "session_id", "domain": ".example.com", "path": "/"},
      {"name": "tracking", "domain": ".example.com", "path": "/"}
    ]
  }'
```
Deletes multiple cookies at once. Each cookie is identified by `name` + `domain` + `path`.

---

## 11. Troubleshooting

When something goes wrong, follow these steps to diagnose issues.

### Check Service Health
```bash
curl -X GET 'http://localhost:8080/health'
```

### View Logs
BrowserWing logs are stored in the path configured in `config.toml` under `[log] file`.
Default location: `./log/browserwing.log`

```bash
# View last 100 lines of logs
tail -n 100 ./log/browserwing.log

# Follow logs in real-time
tail -f ./log/browserwing.log

# Search for errors
grep -i 'error\|fail\|panic' ./log/browserwing.log | tail -20
```

### Common Issues

**1. Browser won't start**
- Check if Google Chrome is installed: `google-chrome --version`
- On Linux, ensure `--no-sandbox` flag or run as non-root
- Check for lingering Chrome lock files in user data dir (SingletonLock, lockfile)
- If using remote Chrome, verify the `control_url` in `config.toml`
- Try killing existing Chrome processes: `pkill -f chrome`

**2. AI features not working**
- Ensure LLM config is set up and active: `GET /api/v1/llm-configs`
- Test the LLM connection: `POST /api/v1/llm-configs/test`
- Check API key validity and model availability
- Check logs for LLM-related errors

**3. Script execution fails**
- Verify the script exists: `GET /api/v1/scripts/<id>`
- Check if the browser is running: `GET /api/v1/browser/instances`
- Review execution history: `GET /api/v1/script-executions`
- Ensure all required `${variables}` are provided in the play request
- Target website may have changed — try re-recording or updating the script

**4. Page elements not found**
- Use `GET /api/v1/executor/snapshot` to see current page elements
- Elements may have dynamic selectors — prefer RefIDs from snapshot
- Page may not have finished loading — use wait actions

**5. Port conflicts**
- BrowserWing default port: 8080 (configurable in `config.toml` under `[server] port`)
- Chrome debugging port: 9222 (or as configured in `control_url`)
- Check for port usage: `lsof -i :<port>` or `netstat -tlnp | grep <port>`

---

## Quick Start Workflow

Here's how to get up and running:

```
1. Install Chrome (see Section 1)
2. Start BrowserWing: ./browserwing --port 8080
3. Add an LLM config (see Section 2)
4. Choose your approach:
   a) AI Exploration: POST /ai-explore/start with a task description
   b) Manual Creation: POST /scripts with actions array
   c) Web UI: Open http://<host>:8080 in browser to use the visual editor
5. Execute scripts: POST /scripts/<id>/play
6. View results: GET /scripts/play/result
```

## API Quick Reference

| Category | Method | Endpoint | Description |
|----------|--------|----------|-------------|
| Health | GET | `/health` | Check service status |
| LLM | GET | `/api/v1/llm-configs` | List LLM configurations |
| LLM | POST | `/api/v1/llm-configs` | Add LLM configuration |
| LLM | POST | `/api/v1/llm-configs/test` | Test LLM connection |
| Explore | POST | `/api/v1/ai-explore/start` | Start AI exploration |
| Explore | GET | `/api/v1/ai-explore/:id/stream` | Stream exploration events |
| Explore | POST | `/api/v1/ai-explore/:id/stop` | Stop exploration |
| Explore | POST | `/api/v1/ai-explore/:id/save` | Save generated script |
| Scripts | GET | `/api/v1/scripts` | List all scripts |
| Scripts | GET | `/api/v1/scripts/:id` | Get script details |
| Scripts | POST | `/api/v1/scripts` | Create new script |
| Scripts | PUT | `/api/v1/scripts/:id` | Update script |
| Scripts | DELETE | `/api/v1/scripts/:id` | Delete script |
| Scripts | GET | `/api/v1/scripts/summary` | Get scripts schema/summary |
| Scripts | POST | `/api/v1/scripts/export/skill` | Export scripts as SKILL.md |
| Execute | POST | `/api/v1/scripts/:id/play` | Execute a script |
| Execute | GET | `/api/v1/scripts/play/result` | Get execution result data |
| Execute | GET | `/api/v1/script-executions` | List execution history |
| Prompts | GET | `/api/v1/prompts` | List all prompts |
| Prompts | PUT | `/api/v1/prompts/:id` | Update prompt |
| Browser | GET | `/api/v1/browser/instances` | List browser instances |
| Cookies | GET | `/api/v1/cookies/:id` | View saved cookies |
| Cookies | POST | `/api/v1/browser/cookies/save` | Save current browser cookies |
| Cookies | POST | `/api/v1/browser/cookies/import` | Import cookies |
| Cookies | POST | `/api/v1/browser/cookies/delete` | Delete a single cookie |
| Cookies | POST | `/api/v1/browser/cookies/batch/delete` | Batch delete cookies |
| MCP | GET | `/api/v1/mcp/status` | MCP server status |
| MCP | GET | `/api/v1/mcp/commands` | List MCP commands |
| Executor | GET | `/api/v1/executor/help` | Executor API help |
| Executor | GET | `/api/v1/executor/snapshot` | Page accessibility snapshot |
| Skill | GET | `/api/v1/executor/export/skill` | Export Executor skill |
| Skill | GET | `/api/v1/admin/export/skill` | Export this Admin skill |
