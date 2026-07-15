# MemOS Cloud OpenClaw Plugin（Lifecycle 插件）

官方维护：MemTensor。

这是一个最小可用的 OpenClaw lifecycle 插件，功能是：
- **召回记忆**：在每轮对话前从 MemOS Cloud 检索记忆并注入上下文
- **添加记忆**：在每轮对话结束后把消息写回 MemOS Cloud

## 功能
- **Recall**：`before_agent_start` → `/search/memory`
- **Add**：`agent_end` → `/add/message`
- **Config UI**：启动 gateway 时同时启动本地插件配置页面，用来编辑 `plugins.entries.memos-cloud-openclaw-plugin.config`
- 使用 **Token** 认证（`Authorization: Token <MEMOS_API_KEY>`）

## 配置页面
- Gateway 启动后，插件会同时拉起一个本地配置页面，并在终端输出访问地址（默认：`http://127.0.0.1:38463`）。
- 页面会直接读取并写回当前宿主的配置文件：
  - OpenClaw：`~/.openclaw/openclaw.json`
  - Moltbot：`~/.moltbot/moltbot.json`
  - ClawDBot：`~/.clawdbot/clawdbot.json`
- 如果默认端口被占用，插件会自动顺延到下一个可用端口。
- 页面保存后会写回 `plugins.entries.memos-cloud-openclaw-plugin.config`。（注意：保存后可能需要手动重启 Gateway 以使配置生效）

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
        "C:\\Users\\YourName\\.openclaw\\extensions\\memos-cloud-openclaw-plugin"
      ]
    }
  }
}
```
*注意：解压后的文件夹通常包含一个 `package` 子文件夹，请指向包含 `package.json` 的那层目录。*

修改配置后需要重启 gateway。

## 环境变量
插件运行时配置的优先级是：**插件 config → env 文件**。为符合纯粹的安全沙箱规范，插件不再支持回退到进程环境变量去读取敏感凭证。
在 env 文件层，按顺序读取（**openclaw → moltbot → clawdbot**），每个键优先使用最先匹配到的值。

**配置位置**
- 文件（优先级顺序）：
  - `~/.openclaw/.env`
  - `~/.moltbot/.env`
  - `~/.clawdbot/.env`
- 每行格式：`KEY=value`

**快速配置（Shell / Windows）**
```bash
echo 'MEMOS_API_KEY="mpg-..."' >> ~/.openclaw/.env
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
- `MEMOS_USE_DIRECT_SESSION_USER_ID`（默认 `false`；开启后，对 `agent:main:<provider>:direct:<peer-id>` 这类私聊 sessionKey，会把 `<peer-id>` 作为 MemOS `user_id`）
- `MEMOS_CONVERSATION_ID`（可选覆盖）
- `MEMOS_KNOWLEDGEBASE_IDS`（可选；逗号分隔的全局知识库 ID 列表，用于 `/search/memory`，例如：`"kb-123, kb-456"`）
- `MEMOS_ALLOW_KNOWLEDGEBASE_IDS`（可选；逗号分隔的知识库 ID 列表，用于 `/add/message`，例如：`"kb-123"`）
- `MEMOS_TAGS`（可选；逗号分隔的标签列表，用于 `/add/message`，默认：`"openclaw"`，例如：`"openclaw, dev"`）
- `MEMOS_RECALL_GLOBAL`（默认 `true`；为 true 时检索不传 conversation_id）
- `MEMOS_MULTI_AGENT_MODE`（默认 `false`；是否开启多 Agent 数据隔离模式）
- `MEMOS_ALLOWED_AGENTS`（可选；多 Agent 模式下的白名单，逗号分隔，例如 `"agent1,agent2"`；为空则所有 Agent 均启用）
- `MEMOS_CONVERSATION_PREFIX` / `MEMOS_CONVERSATION_SUFFIX`（可选）
- `MEMOS_CONVERSATION_SUFFIX_MODE`（`none` | `counter`，默认 `none`）
- `MEMOS_CONVERSATION_RESET_ON_NEW`（默认 `true`，需 hooks.internal.enabled）
- `MEMOS_RECALL_FILTER_ENABLED`（默认 `false`；开启后先用你指定的模型过滤召回记忆再注入）
- `MEMOS_RECALL_FILTER_BASE_URL`（OpenAI 兼容接口，例如 `http://127.0.0.1:11434/v1`）
- `MEMOS_RECALL_FILTER_API_KEY`（可选，若你的接口需要鉴权）
- `MEMOS_RECALL_FILTER_MODEL`（用于筛选记忆的模型名）
- `MEMOS_RECALL_FILTER_TIMEOUT_MS`（默认 `30000`）
- `MEMOS_RECALL_FILTER_RETRIES`（默认 `1`）
- `MEMOS_RECALL_FILTER_CANDIDATE_LIMIT`（默认每类 `30` 条）
- `MEMOS_RECALL_FILTER_MAX_ITEM_CHARS`（默认 `500`）
- `MEMOS_RECALL_FILTER_FAIL_OPEN`（默认 `true`；筛选失败时回退为“不过滤”）
- `MEMOS_CAPTURE_STRATEGY`（默认 `last_turn`；记忆捕获策略）
- `MEMOS_ASYNC_MODE`（默认 `true`；异步模式添加记忆）
- `MEMOS_THROTTLE_MS`（默认 `0`；请求节流时间，单位毫秒）
- `MEMOS_INCLUDE_ASSISTANT`（默认 `true`；记忆是否包含助手回复）
- `MEMOS_MAX_MESSAGE_CHARS`（默认 `20000`；单条记忆最大字符数限制）

## 可选插件配置
在 `plugins.entries.memos-cloud-openclaw-plugin.config` 中设置：
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

### 按 Agent 开关记忆插件

在多 Agent 模式下，可以通过 `MEMOS_ALLOWED_AGENTS` 精确控制哪些 Agent 启用记忆功能。未在白名单中的 Agent 将完全跳过记忆召回和记忆添加。

**环境变量配置**（在 `~/.openclaw/.env` 中设置）：
```env
MEMOS_MULTI_AGENT_MODE=true
MEMOS_ALLOWED_AGENTS="agent1,agent2"
```

多个 Agent ID 之间用英文逗号分隔。

**插件配置**（在 `openclaw.json` 中设置）：
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

**行为规则**：
| 配置 | 效果 |
|------|------|
| `MEMOS_ALLOWED_AGENTS` 未设置或为空 | 所有 Agent 均启用记忆 |
| `MEMOS_ALLOWED_AGENTS="agent1,agent2"` | 仅 `agent1` 和 `agent2` 启用，其余跳过 |
| `MEMOS_ALLOWED_AGENTS="agent1"` | 仅 `agent1` 启用，其他 Agent 均跳过 |
| `MEMOS_MULTI_AGENT_MODE=false` | 白名单不生效，所有请求按单 Agent 模式处理 |

> **注意**：白名单仅在 `multiAgentMode=true` 时生效。关闭多 Agent 模式时，所有 Agent 的记忆功能均正常工作，白名单配置被忽略。

### 按 Agent 独立配置参数（agentOverrides）

除了按 Agent 开关记忆功能外，你还可以通过 `agentOverrides` 为**每个 Agent 配置不同的记忆参数**，包括知识库、召回条数、相关性阈值等。

**插件配置**（在 `openclaw.json` 中设置）：
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

**环境变量配置**（在 `~/.openclaw/.env` 中设置）：
你可以使用 `MEMOS_AGENT_OVERRIDES` 来配置一个 JSON 字符串，覆盖全局参数。注意：`.env` 中的配置优先级低于 `openclaw.json` 中的 `agentOverrides` 配置。
```env
MEMOS_AGENT_OVERRIDES='{"research-agent": {"memoryLimitNumber": 12, "relativity": 0.3}, "coding-agent": {"memoryLimitNumber": 9}}'
```

**工作原理**：
- `agentOverrides.<agentId>` 中的字段会覆盖该 Agent 对应的全局默认值
- 只需写需要覆盖的字段，其余参数从全局配置继承
- 若某个 Agent 没有对应的 override 条目，则完全使用全局配置

**可覆盖字段**：

| 字段 | 说明 |
|------|------|
| `knowledgebaseIds` | `/search/memory` 使用的知识库 ID 列表 |
| `memoryLimitNumber` | 召回的事实记忆最大条数 |
| `preferenceLimitNumber` | 召回的偏好记忆最大条数 |
| `includePreference` | 是否启用偏好记忆召回 |
| `includeToolMemory` | 是否启用工具记忆召回 |
| `toolMemoryLimitNumber` | 工具记忆最大条数 |
| `relativity` | 相关性阈值（0-1） |
| `recallEnabled` | 该 Agent 是否启用记忆检索 |
| `addEnabled` | 该 Agent 是否启用记忆写入 |
| `captureStrategy` | `last_turn` 或 `full_session` |
| `queryPrefix` | 搜索查询前缀 |
| `maxItemChars` | 注入 prompt 时每条记忆的最大字符数 |
| `maxMessageChars` | 写入记忆时每条消息的最大字符数 |
| `includeAssistant` | 写入记忆时是否包含助手回复 |
| `recallGlobal` | 全局召回（不传 conversation_id） |
| `recallFilterEnabled` | 是否启用模型二次过滤 |
| `recallFilterModel` | 过滤模型名 |
| `recallFilterBaseUrl` | 过滤模型接口地址 |
| `recallFilterApiKey` | 过滤模型鉴权密钥 |
| `allowKnowledgebaseIds` | `/add/message` 允许写入的知识库 |
| `tags` | `/add/message` 标签 |
| `throttleMs` | 请求节流间隔 |

## 私聊 Session User ID（Direct Session User ID）
- **默认行为**：仍然使用配置里的 `userId`（或 `MEMOS_USER_ID`），完全兼容旧行为。
- **开启方式**：在插件 config 中设置 `"useDirectSessionUserId": true`，或在环境变量中设置 `MEMOS_USE_DIRECT_SESSION_USER_ID=true`。
- **行为说明**：开启后，像 `agent:main:<provider>:direct:<peer-id>` 这样的私聊 sessionKey，会把 `<peer-id>` 当作 MemOS `user_id`。
- **不会影响的场景**：像 `agent:main:<provider>:channel:<channel-id>` 这类非私聊 sessionKey，仍继续使用配置好的 fallback `userId`。
- **作用范围**：同一套解析逻辑同时作用于 `buildSearchPayload()` 和 `buildAddMessagePayload()`，保证 recall 与 add 一致。
- **配置优先级**：仍遵循插件现有规则——插件 config 优先，其次是 `.env` 文件（`~/.openclaw/.env` -> `~/.moltbot/.env` -> `~/.clawdbot/.env`）。


## 说明
- 未显式指定 `conversation_id` 时，默认使用 OpenClaw `sessionKey`。**TODO**：后续考虑直接绑定 OpenClaw `sessionId`。
- 可配置前后缀；`conversationSuffixMode=counter` 时会在 `/new` 递增（需 `hooks.internal.enabled`）。

## 致谢
- 感谢 @anatolykoptev（Contributor）— 领英：https://www.linkedin.com/in/koptev?utm_source=share&utm_campaign=share_via&utm_content=profile&utm_medium=ios_app
