# Hermes MemOS 记忆插件

这是一个独立的 Hermes memory-provider 插件，用于接入 MemOS Platform。

该插件通过 [MemOS](https://memos.openmem.net/) 为 Hermes 提供服务端记忆抽取和语义搜索能力。它会暴露记忆搜索与显式写入记忆的工具，并可在后台将已完成的对话轮次持久化到 MemOS。

## 从 MemOS 仓库安装

该插件位于 MemOS monorepo 的 `apps/MemOS-Cloud-Hermes-Plugin` 目录下。先使用 Hermes 官方插件安装命令安装整个 MemOS 项目：

```bash
hermes plugins install MemTensor/MemOS
pip install MemoryOS
```

然后将 MemOS 内的 app 目录链接到 Hermes 的 memory provider 目录，让 `hermes memory setup` 可以发现它：

```bash
mkdir -p ~/.hermes/hermes-agent/plugins/memory
ln -s ~/.hermes/plugins/MemOS/apps/MemOS-Cloud-Hermes-Plugin \
      ~/.hermes/hermes-agent/plugins/memory/memos
```

Hermes 目前会从 Hermes 源码树内的 `plugins/memory/` 发现 memory provider。这个符号链接会把 memory-provider 发现路径指向由 `hermes plugins install` 安装下来的 MemOS app。

最后运行配置向导：

```bash
hermes memory setup
```

在向导中选择 `memos`。

如果插件已经安装过，后续想更新 MemOS checkout：

```bash
hermes plugins update MemOS
```

## 本地开发安装

如果你已经有本地 MemOS checkout，可以直接使用其中的 app 目录：

```bash
cd /path/to/MemOS
pip install MemoryOS
mkdir -p ~/.hermes/hermes-agent/plugins/memory
ln -s "$(pwd)/apps/MemOS-Cloud-Hermes-Plugin" ~/.hermes/hermes-agent/plugins/memory/memos
hermes memory setup
```

在当前工作区中，插件路径为：

```text
/Users/geyunhang/Documents/demos/MemOS-Plugin-dev/MemOS/apps/MemOS-Cloud-Hermes-Plugin
```

## 运行要求

- 支持 memory-provider 插件系统的 Hermes。
- `MemoryOS`。
- 来自 [MemOS Dashboard](https://memos-dashboard.openmem.net) 的 MemOS API key。

## 插件能力

工具：

- `memos_search`：搜索用户的 MemOS 记忆。
- `memos_add_message`：将事实或消息显式写入 MemOS 记忆。

记忆集成：

- `prefetch`：在每轮对话前召回相关的 MemOS 记忆。
- `sync_turn`：异步存储已完成的 user/assistant 对话轮次。
- `queue_prefetch`：保留给 Hermes memory-provider 生命周期使用；当前为空实现。

## 配置

敏感配置可以通过环境变量设置：

- `MEMOS_API_KEY`：必填，MemOS API key。
- `MEMOS_USER_ID`：可选，用户 ID，默认值为 `hermes_user`。

非敏感配置会存储在 `$HERMES_HOME/memos.json`：

- `api_key`：MemOS API key。通常由 `hermes memory setup` 写入 `.env`。
- `user_id`：MemOS 用户标识，默认值为 `hermes_user`。
- `knowledgebase`：可选，用于搜索的 knowledgebase ID 或 ID 列表。
- `allowedAgents`：可选，允许使用记忆的 Hermes agent ID 列表。
- `multiAgentMode`：为 `true` 时，搜索会按 Hermes agent ID 过滤。

示例：

```json
{
  "user_id": "hermes_user",
  "knowledgebase": ["kb-123", "kb-456"],
  "allowedAgents": ["coder", "researcher"],
  "multiAgentMode": true
}
```

## 验证

在已将插件链接到 `plugins/memory/memos` 的 Hermes checkout 中运行：

```bash
python -m py_compile ~/.hermes/plugins/MemOS/apps/MemOS-Cloud-Hermes-Plugin/__init__.py
hermes memory setup
```

如果你是在 Hermes 源码树中开发，也可以运行：

```bash
python -m py_compile memos-memory-plugin/__init__.py
```

## 说明

- 该仓库按 Hermes 目录插件结构组织，仓库根目录就是插件根目录。
- 安装后的插件名是 `memos`，与 `plugin.yaml` 保持一致。
- Hermes 目前不会自动安装 memory-provider 插件里的 `pip_dependencies`，因此需要自行将 `MemoryOS` 安装到 Hermes 运行环境中。
