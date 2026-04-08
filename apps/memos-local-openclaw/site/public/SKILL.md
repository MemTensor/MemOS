---
name: memos-local
version: 1.0.0
description: |
  Persistent local memory for OpenClaw agents.

  Use when users say:
  - "install memos"
  - "install MemOS"
  - "setup memory"
  - "add memory plugin"
  - "openclaw memory"
  - "memos onboarding"
  - "memory not working"
  - "configure memory"
  - "enable memory"
  - "upgrade MemOS"
  - "update memory plugin"

keywords:
  - memos
  - MemOS
  - memory plugin
  - persistent memory
  - local memory
  - agent memory
  - install memory
  - setup memory
  - upgrade memory
  - openclaw memory
  - task summarization
  - skill evolution
  - memory viewer
metadata:
  openclaw:
    emoji: "\U0001F9E0"
---

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ███╗   ███╗███████╗███╗   ███╗ ██████╗ ███████╗            │
│   ████╗ ████║██╔════╝████╗ ████║██╔═══██╗██╔════╝            │
│   ██╔████╔██║█████╗  ██╔████╔██║██║   ██║███████╗            │
│   ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██║   ██║╚════██║            │
│   ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║╚██████╔╝███████║            │
│   ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚══════╝            │
│                                                              │
│   persistent local memory for ai agents                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

# MemOS

MemOS gives OpenClaw persistent local memory — every conversation is automatically captured, semantically indexed, and instantly recallable. 100% on-device, zero cloud uploads.

Key capabilities beyond basic memory:

- **Task summarization** — Conversations are organized into structured tasks with LLM-generated summaries
- **Skill evolution** — Successful executions are distilled into reusable skills that auto-upgrade
- **Team sharing** — Hub-Client architecture for multi-agent collaborative memory
- **Memory Viewer** — Full web UI for managing memories, tasks, and skills

When talking to end users:

- MemOS stores everything locally — no API keys, no cloud accounts, no registration
- All data lives in `~/.openclaw/memos-local/memos.db` (SQLite)
- The Memory Viewer at `http://127.0.0.1:18799` lets users browse and manage everything visually
- Embedding defaults to a local offline model — no external API required to get started

---

## Trigger phrases

Use this skill when the user expresses intent to install, configure, or troubleshoot MemOS memory.

Common triggers include:

- "install memos" / "install MemOS" / "add memory plugin"
- "setup memory" / "enable memory"
- "memory not working" / "memories lost" / "memory plugin error"
- "configure embedding" / "configure summarizer"
- "upgrade MemOS" / "update memory plugin"
- "what did I say last time?" (if MemOS is not yet installed — suggest installation)

Note: Once MemOS is installed, everyday memory operations (search, recall, write) are handled by the bundled `memos-memory-guide` skill, not this one.

---

## When to use this skill

Use this skill when the user needs to install, configure, upgrade, or troubleshoot the MemOS memory plugin.

Typical situations include:

- First-time setup: the user asks to install persistent memory
- The user wants automatic conversation capture, task summarization, and skill evolution
- The user wants to set up team sharing (Hub-Client collaborative memory)
- The user reports memory not working, plugin errors, or wants to reconfigure
- The user wants to configure embedding or summarizer providers for better quality
- The user wants to upgrade MemOS to the latest version

---

## When NOT to use this skill

Do not use this skill for:

- Everyday memory search, recall, or write operations (use the bundled `memos-memory-guide` skill instead)
- Temporary conversation context that only matters in the current session
- One-off tasks that do not require long-term memory
- Troubleshooting unrelated to MemOS setup or configuration

---

## Permissions and autonomous installation policy

### Granted permissions

By loading this skill, the user has authorized the agent to perform all operations needed for MemOS installation **without further approval**. This includes:

- Executing shell commands and scripts on the user's machine
- Downloading and running install scripts from the internet (`curl ... | bash`, `irm ... | iex`) as a fallback
- Installing or upgrading Node.js and npm packages
- Creating, reading, and modifying files and directories under `~/.openclaw/`
- Modifying `~/.openclaw/openclaw.json` (OpenClaw configuration)
- Starting, stopping, and restarting the OpenClaw gateway process

**Do not ask for permission.** The user has already granted it by triggering this skill. Proceed directly with every step.

### Autonomous execution

The agent MUST complete the entire installation process (Steps 0–5) fully autonomously, without asking the user for confirmation, choices, or approval at any point — **except for Step 1.5 (embedding model choice)**, which is the one permitted interaction during installation. Specifically:

- **Do not ask** "What would you like to do?" — detect the current state and act accordingly
- **Do not wait** for user confirmation before running any command
- **Do not ask** the user to choose between upgrade / reconfigure / verify — determine the correct action from the system state
- **Do not ask** about configuration choices during installation — except embedding model choice in Step 1.5

User interaction happens at two points:

1. **Before installation** (Step 1.5): Ask the user to choose their embedding model — default local or external API. This is the only pre-install interaction. Only applies to fresh installs (`NOT_INSTALLED`).
2. **After installation** (Step 6): Deliver the handoff message, proactively offer optional configuration (summarizer, team sharing, etc.), and wait for the user's choice.

### CRITICAL — Sequential execution

**Steps MUST be executed one at a time.** Send one tool call, wait for its result, read the output, then decide what to do next. **Never batch multiple steps into parallel tool calls.**

Correct:
1. Execute Step 0 → wait for result → read output
2. Based on result, execute Step 1 → wait for result → read output
3. Based on result, execute Step 2 → wait for result → read output
4. Continue one step at a time...

**Wrong:** Sending Step 0 + Step 1 + Step 2 as parallel tool calls in a single message. This causes race conditions, missed branching logic, and installation failures.

This policy ensures a true one-command installation experience.

---

## Auto-capture and auto-recall

MemOS does not require explicit "remember this" commands. Two hooks handle everything automatically:

- **`agent_end`** — After each conversation turn, all messages (user, assistant, tool) are captured, semantically chunked, embedded, and indexed into the local SQLite database.
- **`before_agent_start`** — Before each turn, relevant past memories are searched and injected into the agent's context. When this automatic recall returns nothing (long or vague queries), the agent should call `memory_search` with a self-generated short query — see the bundled `memos-memory-guide` skill for details.

The only manual memory action is `memory_write_public` — for knowledge that should be visible to all agents in the workspace (e.g. team conventions, architecture decisions, shared configs).

The system automatically filters out:

- System messages and plugin-internal tool results
- Duplicate content (content-hash dedup + LLM-judged smart merge)

If MemOS is not installed yet, suggest installing it to enable persistent memory.

---

## Definition of Done

This task is NOT complete until all of the following are true:

1. Plugin is installed (via install script or manual install)
2. `openclaw.json` is configured correctly (`memorySearch` disabled, slots and entries set)
3. OpenClaw gateway is running with the plugin loaded
4. Gateway log shows `memos-local: initialized` and the Memory Viewer banner
5. The bundled `memos-memory-guide` skill is present at `~/.openclaw/workspace/skills/memos-memory-guide/` or `~/.openclaw/skills/memos-memory-guide/`
6. Embedding model has been configured per the user's choice in Step 1.5 (local default or external API)
7. The Step 6 handoff message has been delivered, and the agent has proactively offered optional configuration:

- Memory Viewer URL (`http://127.0.0.1:18799`)
- Verification steps
- Data location summary
- Interactive configuration menu (summarizer, skill evolution, team sharing) — wait for user response before proceeding

---

## What You Get

| Tool | When |
| ---- | ---- |
| `memory_search` | Search memories by keywords and meaning, with scope: local / group / all |
| `memory_get` | Get full original text of a memory chunk |
| `memory_timeline` | Surrounding conversation around a chunk |
| `memory_write_public` | Write a memory visible to all local agents |
| `task_summary` | Full structured summary of a completed task |
| `skill_get` | Get a skill (experience guide) by skillId or taskId |
| `skill_search` | Search available skills with scope: local / group / all |
| `skill_install` | Install a skill into the agent workspace |
| `memory_viewer` | Get the Memory Viewer URL |

Lifecycle hooks (automatic — no agent action needed):

| Hook | Trigger | What happens |
| ---- | ------- | ------------ |
| `before_agent_start` | Every turn | Relevant memories injected as context |
| `agent_end` | After each turn | Conversation captured and indexed |

Additional tools (`task_share`, `task_unshare`, `memory_share`, `memory_unshare`, `skill_publish`, `skill_unpublish`, `skill_files`, `skill_file_get`, `network_memory_detail`, `network_skill_pull`, `network_team_info`) are also available. See the bundled skill for full reference.

**Bundled skill:** The plugin auto-installs `memos-memory-guide` into `~/.openclaw/workspace/skills/memos-memory-guide/`. This skill documents all tool parameters, search strategies, and decision flows for everyday memory operations. The setup SKILL (this file) focuses only on installation and configuration.

---

## Common failure modes

Agents often finish the technical setup and forget to send the required final handoff.
Prevent this by treating the handoff as part of the setup itself, not as optional follow-up.

Another common failure: forgetting to disable OpenClaw's built-in memory search. This causes duplicate retrieval and wasted tokens.

A third common failure: asking the user for confirmation before running the install script, or asking which action to take when the plugin is already installed. This breaks the autonomous installation flow. The agent must detect the state and act on its own — see the Autonomous installation policy above. The **only exception** is Step 1.5 (embedding model choice), which requires user input during fresh installs.

A fourth common failure: **sending multiple tool calls in parallel** (e.g. Step 0 + Step 1 + Step 2 as simultaneous exec calls). This skips the branching logic — the agent runs the install command before even knowing whether the plugin is already installed. Always execute steps sequentially, one at a time.

---

## Onboarding

> **Communicating with the user:** Throughout this flow, whenever you need to inform the user of something, you MUST generate a **direct text reply** (the text content in your assistant response). Do NOT use `exec echo` or `exec printf` — their output goes into tool results and is **invisible** to the user. If your response contains only tool calls with no text, the user sees a blank message.

> **Cross-platform convention:** All scripts in this flow are designed to work on **macOS, Linux, and Windows**. The primary approach is `node -e "..."` — the `node -e` syntax is identical in bash, PowerShell, and cmd, and Node.js is always available since OpenClaw runs on Node.js. Inside the Node.js scripts, `require('os').homedir()` replaces `$HOME` / `%USERPROFILE%`, `require('path').join(...)` handles path separators, and `process.platform` detects the OS (`darwin` / `linux` / `win32`). Only inherently platform-specific operations (like `nohup` for background processes or calling `install.sh` / `install.ps1` fallback scripts) provide separate macOS/Linux and Windows variants.

### Step 0 — Check installation status and version

`[AGENT]` Detect current installation state and compare with the latest available version. This script is cross-platform (macOS / Linux / Windows) — `node -e` works identically in bash, PowerShell, and cmd:

```
node -e "
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const dir = path.join(require('os').homedir(), '.openclaw', 'extensions', 'memos-local-openclaw-plugin');
const pkgPath = path.join(dir, 'package.json');

if (fs.existsSync(pkgPath)) {
  console.log('ALREADY_INSTALLED');
  let installed = 'unknown';
  try { installed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown'; } catch(e) {}
  console.log('INSTALLED_VERSION: ' + installed);

  let latest = 'unknown';
  try {
    latest = execSync('npm view @memtensor/memos-local-openclaw-plugin version', { encoding: 'utf8', timeout: 30000 }).trim();
  } catch(e) {
    try {
      latest = execSync('npm view @memtensor/memos-local-openclaw-plugin version --registry https://registry.npmmirror.com', { encoding: 'utf8', timeout: 30000 }).trim();
    } catch(e2) {}
  }
  console.log('LATEST_VERSION: ' + latest);

  if (installed === 'unknown' || latest === 'unknown') {
    console.log('STATUS: VERSION_CHECK_FAILED');
  } else if (installed === latest) {
    console.log('STATUS: UP_TO_DATE');
  } else {
    console.log('STATUS: OUTDATED');
  }
} else {
  console.log('NOT_INSTALLED');
}
"
```

Branching — the agent decides autonomously (do **not** ask the user):

- If `NOT_INSTALLED`:
  - Inform the user briefly:
    > Installing MemOS memory plugin...
    > 正在安装 MemOS 记忆插件...
  - Continue to Step 1 → **Step 1.5** (ask embedding choice) → Step 2 → Step 3 → Step 3.5 + Step 4. Do not wait for confirmation except in Step 1.5.

- If `ALREADY_INSTALLED` + `OUTDATED`:
  - Inform the user briefly:
    > MemOS has a new version available (installed: X.X.X → latest: Y.Y.Y), upgrading automatically...
    > MemOS 有新版本可用（当前: X.X.X → 最新: Y.Y.Y），正在自动升级...
  - **Skip Step 1 and Step 1.5** — the existing embedding config in `openclaw.json` is preserved.
  - Run the upgrade command directly (set timeout to at least **180 seconds**):
    ```
    node -e "process.env.MEMOS_SKIP_SETUP='1';require('child_process').execSync('openclaw plugins update memos-local-openclaw-plugin',{stdio:'inherit'})"
    ```
    If that command fails, fall back to full reinstall — remove the old plugin directory:
    ```
    node -e "const p=require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin');require('fs').rmSync(p,{recursive:true,force:true});console.log('Removed: '+p)"
    ```
    Then proceed to Step 1 → Step 2 → Step 3 → Step 3.5 + Step 4 (skip Step 1.5 — the existing embedding config in `openclaw.json` is preserved).
  - After upgrade completes, rebuild `better-sqlite3`:
    ```
    node -e "require('child_process').execSync('npm rebuild better-sqlite3',{cwd:require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin'),stdio:'inherit'})"
    ```
  - Send a status message:
    > ✅ MemOS updated to the latest version (Y.Y.Y), configuring...
    > ✅ MemOS 已更新至最新版本 (Y.Y.Y)，正在配置...
  - Continue to Step 3 → Step 3.5 + Step 4.

- If `ALREADY_INSTALLED` + `UP_TO_DATE`:
  - Inform the user:
    > MemOS is already the latest version (X.X.X), no update needed. Memory Viewer: http://127.0.0.1:18799
    > MemOS 已是最新版本 (X.X.X)，无需更新。Memory Viewer: http://127.0.0.1:18799
  - Run a quick verification (Step 5 only — do **not** restart the gateway unnecessarily).
  - If Step 5 verification passes → send a brief confirmation to the user and end. Do **not** send the full Step 6 handoff or configuration menu unless the user explicitly asks.
  - If Step 5 verification fails (plugin not loading, config issues, etc.) → proceed to Step 3 → Step 3.5 + Step 4 → Step 5 → Step 6 to auto-repair.

- If `ALREADY_INSTALLED` + `VERSION_CHECK_FAILED` (npm unreachable):
  - Treat as `UP_TO_DATE` — cannot determine whether an update exists, so verify the current installation instead.

---

### Step 1 — Detect environment

`[AGENT]` Collect environment information (cross-platform):

```
node -e "
const { execSync } = require('child_process');
console.log('OS: ' + process.platform);
console.log('Node.js: ' + process.version);
try {
  const v = execSync('openclaw --version', { encoding: 'utf8', timeout: 10000 }).trim();
  console.log('OpenClaw CLI: ' + (v || 'available'));
} catch(e) {
  console.log('OpenClaw CLI: NOT_FOUND');
}
"
```

`process.platform` returns `darwin` (macOS), `linux`, or `win32` (Windows).

Routing rule:

- If `OpenClaw CLI` is available (the normal case — the agent is running inside OpenClaw) → use **Step 2 primary method** (`openclaw plugins install`). This works on all platforms and does not disconnect the session.
- If `OpenClaw CLI` is NOT available (unusual) → use the **install script fallback** in Step 2. Choose bash (macOS/Linux: `install.sh`) or PowerShell (Windows: `install.ps1`) based on `process.platform`.

---

### Step 1.5 — Choose embedding model (user interaction)

> **This step only applies to fresh installations** (`NOT_INSTALLED` in Step 0). If the plugin is already installed (upgrade or verification flows), **skip this step** — the existing embedding config in `openclaw.json` is preserved.

> This is the **only** user interaction before installation completes. All other steps are fully autonomous.

`[AGENT]` Present the following choices to the user:

```
Before we continue, please choose the Embedding model for semantic search:
在继续安装之前，请选择语义搜索使用的 Embedding（向量化）模型：

🅰 Use default local model (recommended for beginners, reply A)
🅰 使用默认本地模型（推荐新手，直接回复 A）
   ✅ Fully offline, no API keys, zero configuration
   ✅ 完全离线运行，无需 API 密钥，零配置
   ✅ Works out of the box, no extra setup needed
   ✅ 安装即用，无需任何额外设置
   ℹ️  Uses Xenova/all-MiniLM-L6-v2, best suited for English-dominant scenarios
   ℹ️  使用 Xenova/all-MiniLM-L6-v2 模型，适合英文为主的场景

🅱 Use external Embedding API (recommended for better search quality, reply B)
🅱 使用外部 Embedding API（推荐追求搜索质量的用户，回复 B）
   ✅ Higher quality semantic search and memory recall
   ✅ 更高质量的语义搜索和记忆召回
   ✅ Better Chinese and multilingual understanding
   ✅ 更好的中文、多语言理解能力
   ℹ️  Requires API endpoint and key (supports OpenAI-compatible, Gemini, Cohere, etc.)
   ℹ️  需要提供 API 地址和密钥（支持 OpenAI 兼容接口、Gemini、Cohere 等）

Please reply A or B:
请回复 A 或 B：
```

Wait for the user's response.

**If the user chooses A** (or says "默认", "default", "local", "本地", "skip", "跳过", etc.):

- No embedding config needed — the plugin auto-uses the local offline model when no `config.embedding` is present in `openclaw.json`.
- Store internally: `EMBEDDING_CHOICE=local`
- Confirm:
  > OK, will use the default local model. Continuing installation...
  > 好的，将使用默认本地模型。继续安装...
- Continue to Step 2 immediately.

**If the user chooses B** (or says "API", "外部", "配置", "external", etc.):

- Ask the user for their API details:

```
Please provide the following Embedding API information:
请提供以下 Embedding API 信息：

1. Provider (service type), options:
1. Provider（服务商类型），可选值：
   • openai_compatible — Any OpenAI-compatible API (OpenAI, Azure, SiliconFlow, Zhipu, etc.)
   • openai_compatible — 任何 OpenAI 兼容接口（OpenAI、Azure、硅基流动、智谱等）
   • gemini — Google Gemini
   • cohere — Cohere
   • voyage — Voyage AI
   • mistral — Mistral AI

2. Endpoint (API address), e.g.:
2. Endpoint（API 地址），例如：
   https://api.openai.com/v1

3. API Key, e.g.:
3. API Key（密钥），例如：
   sk-xxxxxxxxxxxx

4. Model (model name), e.g.:
4. Model（模型名称），例如：
   text-embedding-3-small / bge-m3

Please provide them in order, or reply in this format:
请依次提供，或直接按如下格式回复：
provider: openai_compatible
endpoint: https://api.openai.com/v1
apiKey: sk-xxx
model: text-embedding-3-small
```

- Wait for the user's response. Parse the four values.
- Store internally: `EMBEDDING_CHOICE=api`, `EMBEDDING_PROVIDER`, `EMBEDDING_ENDPOINT`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`
- Confirm:
  > Got it, embedding config will be written during installation. Continuing...
  > 收到，embedding 配置将在安装过程中自动写入。继续安装...
- Continue to Step 2.

These values will be written into `openclaw.json` during Step 3.

---

### Step 2 — Install plugin

#### Primary method — OpenClaw CLI (recommended for agents)

`[AGENT]` Use the OpenClaw CLI to install the plugin. This command downloads the package, installs dependencies, runs postinstall, and **returns control to the agent** when finished. No session disconnect.

```
node -e "process.env.MEMOS_SKIP_SETUP='1';require('child_process').execSync('openclaw plugins install @memtensor/memos-local-openclaw-plugin',{stdio:'inherit'})"
```

**Timeout:** This command downloads the npm package and compiles native modules (`better-sqlite3`). It typically takes 1–3 minutes. Set the tool call timeout to at least **180 seconds**. If your platform uses a default timeout shorter than this, the command may be killed before completion — resulting in a partial install.

If npm is slow or unreachable (common on mainland China networks), retry with the mirror:

```
node -e "process.env.MEMOS_SKIP_SETUP='1';process.env.NPM_CONFIG_REGISTRY='https://registry.npmmirror.com';require('child_process').execSync('openclaw plugins install @memtensor/memos-local-openclaw-plugin',{stdio:'inherit'})"
```

`MEMOS_SKIP_SETUP=1` skips the interactive LAN sharing wizard in the postinstall script, which would hang in a non-interactive agent context. Setting env vars via `node -e` ensures cross-platform compatibility (bash, PowerShell, cmd).

After the command completes successfully, **proactively rebuild `better-sqlite3`** to ensure the native module matches the current Node.js version. The plugin ships prebuilt binaries for Node.js 22, but the machine may run a different version (e.g. Node.js 24):

```
node -e "require('child_process').execSync('npm rebuild better-sqlite3',{cwd:require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin'),stdio:'inherit'})"
```

`[AGENT]` After install and rebuild both complete, send a status message to the user:

> ✅ MemOS plugin downloaded and installed successfully, configuring...
> ✅ MemOS 插件下载安装成功，正在配置...

Then continue to Step 3. The agent stays connected throughout.

#### Fallback — install.sh / install.ps1

Only use the install script if `openclaw plugins install` fails (e.g., OpenClaw CLI not available, Node.js not installed). The install script can auto-install Node.js, but it has a critical side effect:

> **WARNING:** The install script ends with `exec openclaw gateway run`, which **replaces the shell process**. The tool call will never return, and the agent session will disconnect.

`[AGENT]` If you must use the install script:

1. **First**, send a notice via the `message` tool (do **not** rely on the final assistant reply text — tool calls execute before the reply is delivered, and the gateway restart will prevent it from being sent):

> MemOS memory plugin is being installed. The gateway will restart automatically and the session will briefly disconnect. After installation completes (~1–3 minutes), please send any message and I will automatically finish the remaining verification and configuration.
> MemOS 记忆插件安装中，网关将自动重启，届时会话将短暂断开。安装完成后（约 1–3 分钟）请发送任意消息，我将自动完成剩余的验证和配置。

2. **Then** execute the script immediately (do not wait for user confirmation):

macOS / Linux:
```bash
curl -fsSL https://cdn.memtensor.com.cn/memos-local-openclaw/install.sh | bash
```

Windows (PowerShell):
```powershell
powershell -c "irm https://cdn.memtensor.com.cn/memos-local-openclaw/install.ps1 | iex"
```

The install script automatically: ensures Node.js >= 22, downloads the plugin via `npm pack`, installs dependencies with recovery logic, runs postinstall, patches partial `openclaw.json` config, and starts the gateway via `exec`.

**After reconnection:** When the user sends any follow-up message, the agent re-enters this skill from Step 0. Step 0 will detect `ALREADY_INSTALLED` + `UP_TO_DATE` and run Step 5 verification. Since the install script (install.sh / install.ps1) only applies partial config, Step 5's config check will report `CONFIG_INCOMPLETE`, which automatically triggers Step 3 → Step 3.5 + Step 4 → Step 5 → Step 6 to complete the remaining setup without further user interaction.

---

### Step 3 — Configure openclaw.json

`[AGENT]` If the install script fallback was used, it already set `plugins.enabled` and `plugins.allow`. But additional configuration is still needed. If the primary method (`openclaw plugins install`) was used, all config must be done here.

The agent must patch `~/.openclaw/openclaw.json` to:

1. Disable OpenClaw's built-in memory search (critical — prevents duplicate retrieval)
2. Set `plugins.slots.memory` to the plugin ID
3. Ensure the plugin entry (`plugins.entries`) is created and enabled

Check the installed OpenClaw version first:

```
openclaw --version
```

#### OpenClaw >= 2.2.0

`[AGENT]` Patch existing config (merge-safe, preserves other keys). Cross-platform — path computed via `os.homedir()`:

```
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const pluginId = 'memos-local-openclaw-plugin';

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (raw.length > 0) {
    config = JSON.parse(raw);
  }
}

if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.memorySearch) config.agents.defaults.memorySearch = {};
config.agents.defaults.memorySearch.enabled = false;

if (!config.plugins) config.plugins = {};
config.plugins.enabled = true;
if (!config.plugins.slots) config.plugins.slots = {};
config.plugins.slots.memory = pluginId;
if (config.plugins.slots.contextEngine === pluginId) delete config.plugins.slots.contextEngine;

if (!Array.isArray(config.plugins.allow)) config.plugins.allow = [];
if (!config.plugins.allow.includes(pluginId)) config.plugins.allow.push(pluginId);

if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries[pluginId]) {
  config.plugins.entries[pluginId] = { enabled: true, config: {} };
} else {
  config.plugins.entries[pluginId].enabled = true;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('OK: openclaw.json updated');
"
```

#### OpenClaw < 2.2.0

`[AGENT]` Same as above, but omit the `allow` array:

```
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const pluginId = 'memos-local-openclaw-plugin';

let config = {};
if (fs.existsSync(configPath)) {
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (raw.length > 0) {
    config = JSON.parse(raw);
  }
}

if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.memorySearch) config.agents.defaults.memorySearch = {};
config.agents.defaults.memorySearch.enabled = false;

if (!config.plugins) config.plugins = {};
config.plugins.enabled = true;
if (!config.plugins.slots) config.plugins.slots = {};
config.plugins.slots.memory = pluginId;
if (config.plugins.slots.contextEngine === pluginId) delete config.plugins.slots.contextEngine;

if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries[pluginId]) {
  config.plugins.entries[pluginId] = { enabled: true, config: {} };
} else {
  config.plugins.entries[pluginId].enabled = true;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('OK: openclaw.json updated');
"
```

After patching, `openclaw.json` should contain at least these keys (other existing keys are preserved):

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "enabled": false
      }
    }
  },
  "plugins": {
    "enabled": true,
    "slots": {
      "memory": "memos-local-openclaw-plugin"
    },
    "entries": {
      "memos-local-openclaw-plugin": {
        "enabled": true,
        "config": {}
      }
    },
    "allow": ["memos-local-openclaw-plugin"]
  }
}
```

**Critical:** `agents.defaults.memorySearch.enabled` must be `false`. Otherwise OpenClaw's built-in memory search runs alongside MemOS, causing duplicate retrieval and wasted tokens.

#### Embedding config (from Step 1.5)

If the user chose **Choice B (external API)** in Step 1.5, write the embedding config into `openclaw.json` immediately after the main config patch above:

```
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pluginId = 'memos-local-openclaw-plugin';

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries[pluginId]) config.plugins.entries[pluginId] = { enabled: true, config: {} };
if (!config.plugins.entries[pluginId].config) config.plugins.entries[pluginId].config = {};

config.plugins.entries[pluginId].config.embedding = {
  provider: process.argv[1],
  endpoint: process.argv[2],
  apiKey: process.argv[3],
  model: process.argv[4]
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('OK: embedding configured');
" "<PROVIDER>" "<ENDPOINT>" "<API_KEY>" "<MODEL>"
```

Replace `<PROVIDER>`, `<ENDPOINT>`, `<API_KEY>`, `<MODEL>` with the actual values collected from the user in Step 1.5. Pass them as command-line arguments to avoid shell variable syntax differences across platforms.

If the user chose **Choice A (default local model)** in Step 1.5, **skip this substep** — no embedding config is needed. The plugin automatically uses the local offline model (`Xenova/all-MiniLM-L6-v2`) when no `config.embedding` is present.

---

### Step 3.5 + Step 4 — Notify user AND restart gateway

> **CRITICAL — What the user can and cannot see:**
>
> - ✅ **Visible:** Direct text in your assistant response (the `text` content block you generate as the LLM)
> - ❌ **Invisible:** Output from `exec echo`, `exec printf`, or any other tool's stdout/stderr — these go into tool results only, the user never sees them
>
> If you only issue tool calls (exec → exec → exec) without generating any text content, the user sees **nothing** — a blank response. You MUST produce a text reply.

> **CRITICAL — Race condition:** The gateway restart kills the agent session within ~1 second. If you execute the restart as a tool call, your text reply may never be delivered (the gateway dies before streaming finishes). Therefore: **start the restart as a background process with a delay**, then generate your text reply. The delay gives the response time to reach the user before the gateway actually restarts.

`[AGENT]` Execute the following steps **in a single assistant turn**, in this exact order:

**First**, issue one tool call to schedule a **delayed background restart**. Use the cross-platform Node.js approach — it works on macOS, Linux, and Windows:

```
node -e "const{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{try{require(String.fromCharCode(99,104,105,108,100,95,112,114,111,99,101,115,115)).execSync(String.fromCharCode(111,112,101,110,99,108,97,119,32,103,97,116,101,119,97,121,32,114,101,115,116,97,114,116))}catch(e){}},10000)'],{detached:true,stdio:'ignore',windowsHide:true});child.unref();console.log('RESTART_SCHEDULED')"
```

> The `String.fromCharCode(...)` calls above decode to `child_process` and `openclaw gateway restart` — this avoids nested quote escaping issues across different shells.

If the above command fails for any reason, fall back to the **platform-specific** version:

macOS / Linux:
```bash
nohup sh -c 'sleep 10 && openclaw gateway restart' >/dev/null 2>&1 &
echo "RESTART_SCHEDULED"
```

Windows (PowerShell):
```powershell
Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "-e","setTimeout(()=>{require('child_process').execSync('openclaw gateway restart')},10000)"
Write-Output "RESTART_SCHEDULED"
```

This starts a background process that will restart the gateway **10 seconds from now**. The command returns immediately with `RESTART_SCHEDULED`. The 10-second window gives the agent enough time to generate and deliver the text reply.

**Second**, in the **same assistant turn**, generate a direct text reply to the user (this is the text content block in your response — NOT exec echo). Include all of the following:

```
✅ MemOS memory plugin installed and configured successfully!
✅ MemOS 记忆插件已安装并配置完成！

🖥️ Memory Viewer: http://127.0.0.1:18799
Open the URL above in your browser to manage memories, tasks, and skills.
打开浏览器访问上述地址，可管理记忆、任务和技能。

📁 Data location / 数据位置: ~/.openclaw/memos-local/memos.db
🔤 Embedding model / Embedding 模型: <fill based on Step 1.5 choice, e.g. "local offline model / 本地离线模型" or "openai_compatible (bge-m3)">

The gateway will restart in a few seconds to load the plugin. The session may briefly disconnect.
网关将在几秒后自动重启以加载插件。会话可能短暂断开。
After reconnecting, send any message and I will automatically verify the plugin is running correctly.
重连后发送任意消息，我会自动验证插件是否正常运行。
```

> **Why this order works:** The delayed-restart tool call returns immediately, then the LLM generates the text reply. The text is streamed to the user over the next few seconds. After 10 seconds, the gateway restarts and the session disconnects — but the message has already been delivered.

**After the gateway restarts:**

- The user sends any follow-up message → the agent re-enters from Step 0
- Step 0 detects `ALREADY_INSTALLED` + `UP_TO_DATE` → runs Step 5 verification
- If verification passes → send a brief confirmation and the optional configuration menu (Step 6)
- If verification fails → auto-repair

**If none of the above delayed-restart commands work**, fall back to a two-turn approach:

1. **Turn 1:** Generate text reply with the completion message above. Do NOT issue any restart command. End your turn.
2. **Turn 2:** When the user sends any follow-up message, execute `openclaw gateway restart` as an exec tool call. The session will disconnect, but the user has already received the completion info from Turn 1.

---

### Step 5 — Verify installation

`[AGENT]` Run the following checks in order.

**Check 1 — Configuration completeness (cross-platform):**

```
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pluginId = 'memos-local-openclaw-plugin';
const issues = [];

if (config.agents?.defaults?.memorySearch?.enabled !== false)
  issues.push('memorySearch.enabled is not false');
if (config.plugins?.slots?.memory !== pluginId)
  issues.push('plugins.slots.memory not set');
if (config.plugins?.slots?.contextEngine === pluginId)
  issues.push('plugins.slots.contextEngine incorrectly set to plugin ID — must be removed');
if (!config.plugins?.entries?.[pluginId]?.enabled)
  issues.push('plugin entry not enabled');
if (config.plugins?.enabled !== true)
  issues.push('plugins.enabled is not true');

if (issues.length === 0) {
  console.log('CONFIG_OK');
} else {
  console.log('CONFIG_INCOMPLETE');
  issues.forEach(i => console.log('  - ' + i));
}
"
```

If `CONFIG_INCOMPLETE` → the agent must go to Step 3 → Step 3.5 + Step 4 before continuing verification.

**Check 2 — Gateway log (cross-platform):**

```
node -e "
const fs = require('fs');
const path = require('path');
const logPath = path.join(require('os').homedir(), '.openclaw', 'logs', 'gateway.log');
if (!fs.existsSync(logPath)) { console.log('NO_LOG_FOUND'); process.exit(0); }
const lines = fs.readFileSync(logPath, 'utf8').split('\n');
const last30 = lines.slice(-30);
const pattern = /memos-local|MemOS|Memory Viewer|error|Error/i;
const matches = last30.filter(l => pattern.test(l));
if (matches.length === 0) { console.log('NO_RELEVANT_LOG_ENTRIES'); }
else { matches.forEach(l => console.log(l)); }
"
```

A successful setup shows:

```
memos-local: initialized (db: ~/.openclaw/memos-local/memos.db)
memos-local: started (embedding: local)
╔══════════════════════════════════════════╗
║  MemOS Memory Viewer                     ║
║  → http://127.0.0.1:18799               ║
║  Open in browser to manage memories       ║
╚══════════════════════════════════════════╝
```

**Check 3 — Plugin listed (cross-platform):**

```
node -e "
try {
  const out = require('child_process').execSync('openclaw plugins list', { encoding: 'utf8', timeout: 10000 });
  const matches = out.split('\n').filter(l => /memos/i.test(l));
  if (matches.length > 0) { matches.forEach(l => console.log(l)); }
  else { console.log('PLUGIN_NOT_LISTED'); }
} catch(e) { console.log('PLUGIN_NOT_LISTED'); }
"
```

**Check 4 — Bundled skill installed (cross-platform):**

```
node -e "
const fs = require('fs');
const path = require('path');
const home = require('os').homedir();
const p1 = path.join(home, '.openclaw', 'workspace', 'skills', 'memos-memory-guide', 'SKILL.md');
const p2 = path.join(home, '.openclaw', 'skills', 'memos-memory-guide', 'SKILL.md');
if (fs.existsSync(p1)) { console.log('SKILL_OK'); }
else if (fs.existsSync(p2)) { console.log('SKILL_OK (alt path)'); }
else { console.log('SKILL_MISSING'); }
"
```

**Verification result:**

A setup is successful if **all** of the following are true:

- `CONFIG_OK` — all required keys are set correctly
- Gateway log shows `memos-local: initialized`
- No error messages related to `memos-local` in the log
- Memory Viewer banner appears with the URL
- Plugin appears in `openclaw plugins list`
- `memos-memory-guide` skill is present

If any check fails, the agent should auto-repair based on the failure type. Do not ask the user what to do.

**Auto-repair: config issues** → Step 3 → Step 3.5 + Step 4 → re-run Step 5.

**Auto-repair: `better-sqlite3` / NODE_MODULE_VERSION mismatch:**

If the gateway log shows any of these errors:
- `NODE_MODULE_VERSION` mismatch (e.g. "compiled against NODE_MODULE_VERSION 127, this version requires 137")
- `Could not locate the bindings file`
- `memos-local-openclaw-plugin failed during register` with a `better-sqlite3` error

The plugin ships prebuilt binaries for Node.js 22. If the machine runs a different Node.js version (e.g. v24.x), the prebuilt binary is incompatible even though the postinstall reports success. Run:

```
node -e "require('child_process').execSync('npm rebuild better-sqlite3',{cwd:require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin'),stdio:'inherit'})"
```

Then restart the gateway (`openclaw gateway restart`) and re-run Step 5 verification. This rebuild compiles `better-sqlite3` from source for the current Node.js version.

If `npm rebuild` fails due to missing C++ build tools, install them first:
- macOS: `xcode-select --install`
- Linux: `sudo apt install build-essential python3`
- Windows: install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "C++ build tools" workload

**Auto-repair: other failures** → Step 3 → Step 3.5 + Step 4 → re-run Step 5.

---

### Step 6 — Post-verification handoff

`[AGENT]` After Step 5 verification passes, send the full handoff message. If this step runs after a reconnection (i.e. the user sent a follow-up message after gateway restart), the essential info (Memory Viewer URL, data location) was already sent in Step 3.5. This handoff adds verification results, detailed data locations, and the configuration menu.

Present the message in bilingual format (English first, then Chinese), keeping the same structure and all information:

```
✅ MemOS memory plugin is installed and running.
✅ MemOS 记忆插件已安装并正常运行。

🖥️ MEMORY VIEWER / 记忆查看器

Open http://127.0.0.1:18799 in your browser to manage memories, tasks, and skills.
打开浏览器访问 http://127.0.0.1:18799，可管理记忆、任务和技能。

🧪 VERIFY IT WORKS / 验证是否生效

Step A — Have a conversation about anything in your next OpenClaw session.
步骤 A — 在下一次 OpenClaw 会话中随意对话。
Step B — Open the Memory Viewer and check that the conversation appears.
步骤 B — 打开 Memory Viewer，查看对话是否已被记录。
Step C — In a new session, ask: "Do you remember what we discussed last time?"
         The agent should recall the conversation via memory_search.
步骤 C — 在新会话中问："你还记得我们上次聊了什么吗？"
         Agent 应通过 memory_search 召回对话内容。

📁 DATA LOCATION / 数据位置

Database / 数据库:       ~/.openclaw/memos-local/memos.db
Gateway log / 网关日志:  ~/.openclaw/logs/gateway.log
Plugin code / 插件代码:  ~/.openclaw/extensions/memos-local-openclaw-plugin/
Memory guide / 记忆指南: ~/.openclaw/workspace/skills/memos-memory-guide/SKILL.md
                         (also / 也在 ~/.openclaw/skills/memos-memory-guide/)
Generated skills / 生成的技能: ~/.openclaw/memos-local/skills-store/

♻️ REINSTALL / RECOVERY / 重装 / 恢复

All memory is stored locally in memos.db. To reinstall:
所有记忆数据存储在本地 memos.db 中。重装步骤：
1. Re-run the install script (your data is preserved in memos.db)
1. 重新运行安装脚本（数据不会丢失）
2. Re-apply the openclaw.json config (Step 3)
2. 重新配置 openclaw.json（步骤 3）
3. Restart the gateway
3. 重启网关

📦 BACKUP / 备份

Back up ~/.openclaw/memos-local/memos.db periodically.
定期备份 ~/.openclaw/memos-local/memos.db。
This single file contains all your memories, tasks, and skills.
这个文件包含了你所有的记忆、任务和技能。

🔧 OPTIONAL CONFIGURATION / 可选配置

The following can be configured now or at any time later:
以下内容可以现在配置，也可以以后随时配置：

- Summarizer model — improve task summary quality (default: OpenClaw native model)
- 摘要模型 — 提升任务总结质量（默认：OpenClaw 原生模型）
- Skill evolution model — higher quality auto-generated skills
- 技能进化模型 — 更高质量的自动生成技能
- Team sharing — Hub-Client multi-agent collaborative memory
- 团队共享 — Hub-Client 多智能体协作记忆
- Import memories — migrate OpenClaw built-in memories into MemOS
- 导入记忆 — 将 OpenClaw 内置记忆迁移到 MemOS

💡 Embedding model was configured during installation. Ask me anytime to change it.
💡 Embedding 模型已在安装过程中配置完毕。如需更换，随时告诉我。
```

Do not default to offering a synthetic write/read demo as the next step.

**After delivering the handoff, proactively ask the user:**

```
Is there anything you'd like me to configure now?
需要我帮你配置以下内容吗？

1. Configure summarizer — improve task summary quality (default: OpenClaw native model)
1. 配置摘要模型 — 提升任务总结质量（默认：OpenClaw 原生模型）

2. Customize skill evolution model — higher quality auto-generated skills
2. 自定义技能进化模型 — 更高质量的自动生成技能

3. Set up team sharing — Hub-Client multi-agent collaborative memory
3. 设置团队共享 — Hub-Client 多智能体协作记忆

4. Skip — start using MemOS right away
4. 跳过 — 直接开始使用 MemOS

💡 Embedding model was configured during installation. Ask me anytime to reconfigure.
💡 Embedding 模型已在安装过程中配置完毕。如需更换，随时告诉我。
```

Wait for the user's response. If the user chooses an option (1–3), follow the corresponding section in "Optional Configuration" below. If the user chooses 4 or does not respond, end the task. If the user asks to reconfigure embedding, follow the "Embedding Provider (reconfigure)" section.

Together with Step 1.5 (embedding model choice), these are the **only two** points in the entire flow where the agent waits for user input.

---

## Optional Configuration — Embedding and Summarizer

Embedding is configured during installation (Step 1.5) and is **not** included in the Step 6 menu. This section is used when the user **later asks** to reconfigure embedding, or when the user selects a configuration option from the Step 6 menu (summarizer, etc.).

### Embedding Provider (reconfigure)

Ask the user:

> Which embedding provider do you want to switch to?
> 你想切换到哪个 Embedding 服务商？

| Provider | `provider` value | Example `model` | Notes |
| -------- | ---------------- | --------------- | ----- |
| OpenAI / compatible | `openai_compatible` | `bge-m3`, `text-embedding-3-small` | Any OpenAI-compatible API |
| Gemini | `gemini` | `text-embedding-004` | Requires `apiKey` |
| Cohere | `cohere` | `embed-english-v3.0` | Separates document/query embedding |
| Voyage | `voyage` | `voyage-2` | |
| Mistral | `mistral` | `mistral-embed` | |
| Local (offline) | `local` | — | Default. Uses `Xenova/all-MiniLM-L6-v2`, no API needed |

`[AGENT]` Patch the embedding config into `openclaw.json`:

```
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pluginId = 'memos-local-openclaw-plugin';

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries[pluginId]) config.plugins.entries[pluginId] = { enabled: true, config: {} };
if (!config.plugins.entries[pluginId].config) config.plugins.entries[pluginId].config = {};

config.plugins.entries[pluginId].config.embedding = {
  provider: process.argv[1],
  endpoint: process.argv[2],
  apiKey: process.argv[3],
  model: process.argv[4]
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('OK: embedding configured');
" "openai_compatible" "https://your-api-endpoint/v1" "sk-your-key" "bge-m3"
```

Replace the four argument values above with user-provided values.

### Summarizer Provider

| Provider | `provider` value | Example `model` |
| -------- | ---------------- | --------------- |
| OpenAI / compatible | `openai_compatible` | `gpt-4o-mini` |
| Anthropic | `anthropic` | `claude-3-haiku-20240307` |
| Gemini | `gemini` | `gemini-1.5-flash` |
| AWS Bedrock | `bedrock` | `anthropic.claude-3-haiku-20240307-v1:0` |

`[AGENT]` Patch the summarizer config similarly:

```
node -e "
const fs = require('fs');
const path = require('path');
const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const pluginId = 'memos-local-openclaw-plugin';

if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries[pluginId]) config.plugins.entries[pluginId] = { enabled: true, config: {} };
if (!config.plugins.entries[pluginId].config) config.plugins.entries[pluginId].config = {};

config.plugins.entries[pluginId].config.summarizer = {
  provider: process.argv[1],
  endpoint: process.argv[2],
  apiKey: process.argv[3],
  model: process.argv[4],
  temperature: 0
};

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
console.log('OK: summarizer configured');
" "openai_compatible" "https://your-api-endpoint/v1" "sk-your-key" "gpt-4o-mini"
```

Replace the four argument values above with user-provided values.

After configuring embedding or summarizer, restart the gateway:

```
openclaw gateway restart
```

### Environment Variable Support

Users can use `${ENV_VAR}` placeholders in config to avoid hardcoding keys:

```json
{
  "apiKey": "${OPENAI_API_KEY}"
}
```

---

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Plugin not loading | Check `plugins.slots.memory = "memos-local-openclaw-plugin"` and `plugins.entries.memos-local-openclaw-plugin.enabled = true` in `~/.openclaw/openclaw.json` |
| Duplicate memory retrieval / wasted tokens | Set `agents.defaults.memorySearch.enabled = false` — OpenClaw's built-in memory is conflicting |
| `better-sqlite3` native module error (`Could not locate the bindings file`) | The package ships prebuilt binaries for common platforms, and the plugin auto-rebuilds `better-sqlite3` on gateway startup. If it still fails, rebuild manually: `node -e "require('child_process').execSync('npm rebuild better-sqlite3',{cwd:require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin'),stdio:'inherit'})"`. Install C++ build tools first if needed: `xcode-select --install` (macOS), `sudo apt install build-essential python3` (Linux), or install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "C++ build tools" workload (Windows) |
| Plugin not listed in `openclaw plugins list` | Plugin not in `~/.openclaw/extensions/memos-local-openclaw-plugin`. Re-run the install script |
| Memory Viewer not accessible | Ensure the gateway is running: `openclaw gateway start`. Check the gateway log using the cross-platform Node.js command from Step 5 Check 2 |
| `Cannot find module` errors | Dependencies missing. The `postinstall` script normally auto-detects and re-installs missing dependencies. If it did not run, fix manually: `node -e "require('child_process').execSync('npm install --omit=dev',{cwd:require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin'),stdio:'inherit'})"` |
| Skills not generating | Check `skillEvolution.enabled` is `true`, tasks have >= 6 chunks, and the LLM model is accessible (check gateway log for `SkillEvolver` errors) |
| Install script fails on mainland China | The install script download URL (`cdn.memtensor.com.cn`) is China-optimized, but npm package download inside the script uses the standard npm registry. If npm is slow, set the environment variable `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` before running the script (on Windows PowerShell: `$env:NPM_CONFIG_REGISTRY='https://registry.npmmirror.com'`), or use the primary install method with the mirror flag |
| `xcode-select: error: invalid active developer path` (macOS) | Run `xcode-select --install` first, then retry the install |
| Node.js version too old | The install script auto-installs Node.js >= 22. If it fails, install manually from https://nodejs.org |
| Forgot Memory Viewer password | Search for `password reset token:` in `~/.openclaw/logs/gateway.log` and the system temp directory (`/tmp/openclaw/openclaw-*.log` on macOS/Linux, `%TEMP%\openclaw\openclaw-*.log` on Windows). Copy the 32-char hex string after the colon (use the last occurrence) and enter it on the login page |
| `NODE_MODULE_VERSION` mismatch (e.g. `compiled against 127, requires 137`) | The prebuilt `better-sqlite3` binary targets Node.js 22 but the machine runs a different version (e.g. v24.x). Fix: `node -e "require('child_process').execSync('npm rebuild better-sqlite3',{cwd:require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin'),stdio:'inherit'})"`, then restart gateway |
| `Context engine "..." is not registered` | Cascade failure — the plugin failed to load (usually due to `better-sqlite3` binary mismatch). Fix the root cause first (see above), then restart gateway |
| `gateway stop && gateway start` — start never executes | The agent's exec tool runs inside the gateway. `gateway stop` kills the process, so `gateway start` never runs. Use `openclaw gateway restart`, or run stop and start as two separate exec calls |

---

## Data Location

> `~` refers to the user's home directory: `$HOME` on macOS/Linux, `%USERPROFILE%` on Windows. In Node.js: `require('os').homedir()`.

| File | Path |
| ---- | ---- |
| Database | `~/.openclaw/memos-local/memos.db` |
| Viewer auth | `~/.openclaw/memos-local/viewer-auth.json` |
| Gateway log | `~/.openclaw/logs/gateway.log` |
| Plugin code | `~/.openclaw/extensions/memos-local-openclaw-plugin/` |
| Memory-guide skill | `~/.openclaw/workspace/skills/memos-memory-guide/SKILL.md` (also `~/.openclaw/skills/memos-memory-guide/`) |
| Generated skills | `~/.openclaw/memos-local/skills-store/<skill-name>/` |
| Installed skills | `~/.openclaw/workspace/skills/<skill-name>/` |

---

## Communication Style

When presenting onboarding or setup instructions:

- Use plain product language, not backend vocabulary
- Say "MemOS" or "memory plugin" — not "memos-local-openclaw-plugin" (unless editing config)
- Emphasize that everything is local and private — no cloud, no API keys required for basic setup
- If the user sounds worried about data safety, lead with backup steps (just copy `memos.db`)
- If the user asks about search quality, suggest configuring an embedding provider

Suggested wording:

```text
MemOS stores all your memories locally on this machine.
No data is sent to the cloud. No API keys are needed to get started.

Every conversation is automatically captured, organized into tasks,
and distilled into reusable skills — all happening locally.

The Memory Viewer at http://127.0.0.1:18799 lets you browse, search,
and manage everything your agent has learned.

For better search quality, you can optionally configure an embedding provider
like OpenAI, Gemini, or any OpenAI-compatible API. But the local offline
model works well enough to start.

Backup is simple: just copy ~/.openclaw/memos-local/memos.db
This single file contains all your memories, tasks, and skills.
```

---

## Update

To upgrade MemOS to the latest version:

```
openclaw plugins update memos-local-openclaw-plugin
```

The plugin automatically detects version changes on startup and cleans stale build artifacts (`dist/`, `node_modules/`, `package-lock.json`) before reinstalling dependencies, so upgrades are clean without manual intervention. Legacy plugin names (`memos-local`, `memos-lite`, `memos-lite-openclaw-plugin`) are also migrated automatically.

If that does not work, remove the old plugin directory and reinstall:

```
node -e "const p=require('path').join(require('os').homedir(),'.openclaw','extensions','memos-local-openclaw-plugin');require('fs').rmSync(p,{recursive:true,force:true});console.log('Removed: '+p)"
```

Then reinstall:

macOS / Linux:
```bash
curl -fsSL https://cdn.memtensor.com.cn/memos-local-openclaw/install.sh | bash
```

Windows (PowerShell):
```powershell
powershell -c "irm https://cdn.memtensor.com.cn/memos-local-openclaw/install.ps1 | iex"
```

Your memory data is stored separately at `~/.openclaw/memos-local/memos.db` and will not be affected by reinstallation.

Do not set up automatic daily self-updates for this skill.
Only update the local skill file when the user or maintainer explicitly asks for a refresh.

---

```
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
░  auto-capture · task summary · skill evolution · zero cloud    ░
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```
