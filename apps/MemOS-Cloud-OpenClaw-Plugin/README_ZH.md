# MemOS Cloud OpenClaw Plugin（Lifecycle 插件）

官方维护：MemTensor。

这是一个最小可用的 OpenClaw lifecycle 插件，功能是：
- **召回记忆**：在每轮对话前从 MemOS Cloud 检索记忆并注入上下文
- **添加记忆**：在每轮对话结束后把消息写回 MemOS Cloud

## 功能
- **Recall**：`before_agent_start` → `/search/memory`
- **Add**：`agent_end` → `/add/message`
- 使用 **Token** 认证（`Authorization: Token <MEMOS_API_KEY>`）

## 安装

### 方式 A — NPM（推荐）
```bash
openclaw plugins install @memtensor/memos-cloud-openclaw-plugin@latest
openclaw gateway restart
```

> **Windows 用户注意**：
> 如果遇到 `Error: spawn EINVAL` 报错，这是 OpenClaw Windows 安装器的已知问题。请使用下方的 **方式 B**（手动安装）。

确认 `~/.openclaw/openclaw.json` 中已启用：
```json
{
  "plugins": {
    "entries": {
      "memos-cloud-openclaw-plugin": { "enabled": true }
    }
  }
}
```

### 方式 B — 手动安装（Windows 解决方案）
1. 从 [NPM](https://www.npmjs.com/package/@memtensor/memos-cloud-openclaw-plugin) 下载最新的 `.tgz` 包。
2. 解压到本地目录（例如 `C:\Users\YourName\.openclaw\extensions\memos-cloud-openclaw-plugin`）。
3. 修改配置 `~/.openclaw/openclaw.json`（或 `%USERPROFILE%\.openclaw\openclaw.json`）：

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
*注意：解压后的文件夹通常包含一个 `package` 子文件夹，请指向包含 `package.json` 的那层目录。*

修改配置后需要重启 gateway。

## 环境变量
插件按顺序读取 env 文件（**openclaw → moltbot → clawdbot**），每个键优先使用最先匹配到的值。
若三个文件都不存在（或该键未找到），才会回退到进程环境变量。

**配置位置**
- 文件（优先级顺序）：
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- 每行格式：`KEY=value`

**快速配置（Shell）**
```bash
echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.zshrc
source ~/.zshrc
# 或者

echo 'export MEMOS_API_KEY="mpg-..."' >> ~/.bashrc
source ~/.bashrc
```

**快速配置（Windows PowerShell）**
```powershell
[System.Environment]::SetEnvironmentVariable("MEMOS_API_KEY", "mpg-...", "User")
```

若未读取到 `MEMOS_API_KEY`，插件会提示配置方式并附 API Key 获取地址。

**最小配置**
```env
MEMOS_API_KEY=YOUR_TOKEN
```

**可选配置**
- `MEMOS_BASE_URL`（默认 `https://memos.memtensor.cn/api/openmem/v1`）
- `MEMOS_API_KEY`（必填，Token 认证）—— 获取地址：https://memos-dashboard.openmem.net/cn/apikeys/
- `MEMOS_USER_ID`（可选，默认 `openclaw-user`）
- `MEMOS_CONVERSATION_ID`（可选覆盖）
- `MEMOS_RECALL_GLOBAL`（默认 `true`；为 true 时检索不传 conversation_id）
- `MEMOS_MULTI_AGENT_MODE`（默认 `false`；是否开启多 Agent 数据隔离模式）
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX`（可选）
- `MEMOS_CONVERSATION_SUFFIX_MODE`（`none` | `counter`，默认 `none`）
- `MEMOS_CONVERSATION_RESET_ON_NEW`（默认 `true`，需 hooks.internal.enabled）
- `MEMOS_RECALL_FILTER_ENABLED`（默认 `false`；开启后先用你指定的模型过滤召回记忆再注入）
- `MEMOS_RECALL_FILTER_BASE_URL`（OpenAI 兼容接口，例如 `http://127.0.0.1:11434/v1`）
- `MEMOS_RECALL_FILTER_API_KEY`（可选，若你的接口需要鉴权）
- `MEMOS_RECALL_FILTER_MODEL`（用于筛选记忆的模型名）
- `MEMOS_RECALL_FILTER_TIMEOUT_MS`（默认 `6000`）
- `MEMOS_RECALL_FILTER_RETRIES`（默认 `0`）
- `MEMOS_RECALL_FILTER_CANDIDATE_LIMIT`（默认每类 `30` 条）
- `MEMOS_RECALL_FILTER_MAX_ITEM_CHARS`（默认 `500`）
- `MEMOS_RECALL_FILTER_FAIL_OPEN`（默认 `true`；筛选失败时回退为“不过滤”）

## 可选插件配置
在 `plugins.entries.memos-cloud-openclaw-plugin.config` 中设置：
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
  "includeAssistant": true,
  "conversationIdPrefix": "",
  "conversationIdSuffix": "",
  "conversationSuffixMode": "none",
  "resetOnNew": true,
  "memoryLimitNumber": 6,
  "preferenceLimitNumber": 6,
  "knowledgebaseIds": [],
  "includePreference": true,
  "includeToolMemory": false,
  "toolMemoryLimitNumber": 6,
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

## 工作原理
### 1) 召回（before_agent_start）
- 组装 `/search/memory` 请求
  - `user_id`、`query`（= prompt + 可选前缀）
  - 默认**全局召回**：`recallGlobal=true` 时不传 `conversation_id`
  - 可选 `filter` / `knowledgebase_ids`
- （可选）若开启 `recallFilterEnabled`，会先把 `memory/preference/tool_memory` 候选发给你配置的模型做二次筛选，只保留 `keep` 的条目
- 将稳定的 MemOS 召回协议通过 `appendSystemContext` 注入，而检索到的 `<memories>` 数据块继续通过 `prependContext` 注入

### 2) 添加（agent_end）
- 默认只写**最后一轮**（user + assistant）
- 构造 `/add/message` 请求：
  - `user_id`、`conversation_id`
  - `messages` 列表
  - 可选 `tags / info / agent_id / app_id`

## 多Agent支持（Multi-Agent）
插件内置对多Agent模式的支持（`agent_id` 参数）：
- **开启模式**：需要在配置中设置 `"multiAgentMode": true` 或在环境变量中设置 `MEMOS_MULTI_AGENT_MODE=true`（默认为 `false`）。
- **动态获取**：开启后，执行生命周期钩子时会自动读取上下文中的 `ctx.agentId`。（注：OpenClaw 的默认 Agent `"main"` 会被自动忽略，以保证老用户的单 Agent 数据兼容性）。
- **数据隔离**：在调用 `/search/memory`（检索记忆）和 `/add/message`（添加记录）时会自动附带该 `agent_id`，从而保证即使是同一用户下的不同 Agent 之间，记忆和反馈数据也是完全隔离的。
- **静态配置**：如果需要，也可在上述插件的 `config` 中显式指定 `"agentId": "your_agent_id"` 作为固定值。

## 说明
- 未显式指定 `conversation_id` 时，默认使用 OpenClaw `sessionKey`。**TODO**：后续考虑直接绑定 OpenClaw `sessionId`。
- 可配置前后缀；`conversationSuffixMode=counter` 时会在 `/new` 递增（需 `hooks.internal.enabled`）。

## 致谢
- 感谢 @anatolykoptev（Contributor）— 领英：https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
