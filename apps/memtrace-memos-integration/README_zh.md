# SmartComment：追踪 MemOS 的记忆写入与检索

[English](README.md) | 简体中文

SmartComment 是 MemOS 的可选追踪插件，将记忆写入、后台处理和检索过程记录为执行图。如果某条事实没有被记住，或需要追查检索结果的来源，可以沿图检查消息提取、记忆写入和后续检索的过程。它也适合用于复现失败用例、评估记忆质量，以及验证提取或检索策略的改动。

图格式和可视化工具由 [smartcomment](https://pypi.org/project/smartcomment/) 提供。生成的图也可以交给独立项目 [MemTrace](https://github.com/zjunlp/MemTrace)，通过其 AI Agent 探查记忆系统中的失败原因。

插件默认关闭，安装后也不会自动启用。需要调试时，在开发或测试环境中开启即可，日常使用 MemOS 无需安装或开启它。

## 能看到什么

| 功能 | 可以查看的内容 |
| --- | --- |
| 记忆写入 | 记忆来自哪些消息、提取出了什么内容，以及写入操作返回的记忆 ID。 |
| 后台处理 | MemRead 如何增强记忆、写入增强结果，或删除旧记忆。 |
| 检索阶段 | 记忆是否被召回、是否在过滤或去重时被移除，以及最终结果的顺序和分数。 |
| 检索结果溯源 | 检索最终结果对应的原始消息和记忆写入过程，通过`MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD`开启。 |
| 请求浏览 | 每个用户的 `index.md` 列出时间、请求摘要、trace ID 和对应的图文件链接。 |

执行图记录以下流程：

```text
Add：   消息 → 提取出的记忆 → 写入的记忆 → 后台增强
Search：查询 → 记忆类型 → 记忆 cube → 召回 → 过滤 → 去重 → 重排
```

## 快速开始

### 1. 准备 MemOS 环境

使用 Python 3.12 或更新版本。先按照 [MemOS 部署说明](../../README.md)配置服务、模型和存储，再激活运行 MemOS 的同一个 Python 环境。在 MemOS 仓库根目录运行：

```bash
# 如果当前环境已经安装了本地 MemOS，可跳过这一行。
python -m pip install -e .

python -m pip install "smartcomment>=0.1.2"
python -m pip install -e apps/memtrace-memos-integration
```

### 2. 开启插件并启动服务

在启动 MemOS 之前设置环境变量：

```bash
export MEMOS_ENABLED_PLUGINS=smartcomment
export MEMOS_SMARTCOMMENT_OUTPUT_DIR="$PWD/.memos/memtrace"

# 可选：将最终检索结果关联到它们的来源。默认关闭。
export MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true

python -m uvicorn memos.api.server_api:app --host 127.0.0.1 --port 8000 --workers 1
```

启动日志中应出现 `smartcomment plugin loaded`。如果还启用了其他可选插件，请在 `MEMOS_ENABLED_PLUGINS` 中保留它们的名称，用逗号分隔。修改插件配置后需要重启服务。

这条命令启动一个 worker。每个写入进程都需要独立的输出目录；如果运行多个 worker，请分别设置目录。

### 3. 写入一条记忆，再检索它

通过[本地 API 文档](http://127.0.0.1:8000/docs)或已有客户端调用 `/product/add` 和 `/product/search`。也可以打开另一个终端运行以下命令，将 `YOUR_USER_ID` 和 `YOUR_CUBE_ID` 替换为已有用户和记忆 cube 的 ID。如需先创建 cube，请参考 [MemOS README](../../README.md)。

```bash
curl -X POST http://127.0.0.1:8000/product/add \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "YOUR_USER_ID",
    "writable_cube_ids": ["YOUR_CUBE_ID"],
    "messages": [{"role": "user", "content": "I go swimming on Tuesdays and Thursdays."}],
    "async_mode": "sync"
  }'

curl -X POST http://127.0.0.1:8000/product/search \
  -H 'Content-Type: application/json' \
  -d '{
    "user_id": "YOUR_USER_ID",
    "readable_cube_ids": ["YOUR_CUBE_ID"],
    "query": "When do I go swimming?"
  }'
```

请确认 Add 请求成功后再检索。插件会异步写入图文件，如果需要检索溯源，还要等 Add 图生成后再执行 Search。此时后台增强可能仍在进行。

通过请求头 `x-trace-id` 指定追踪 ID，便于将图与业务日志对应。同一用户下复用 trace ID 的请求会归入同一张图；如果希望每次请求各有一张图，请使用不同的 trace ID。Add 和 Search 使用不同的 trace ID 时，也能进行检索溯源。

### 4. 查找已记录的请求

如果使用上面的输出目录，在仓库根目录运行：

```bash
find .memos/memtrace -type f -name index.md
```

打开对应用户的 `index.md`，即可按从新到旧的顺序查看请求。每条记录包含带 UTC 偏移量的时间、请求类型、查询或消息摘要、完整 trace ID，以及 `graph.json` 链接。

目录示例：

```text
.memos/memtrace/
└── user--<hash>/
    ├── index.md
    └── 2026-11-17/
        ├── add/
        │   └── <time>__<trace>/
        │       ├── graph.json
        │       └── meta.json
        └── search/
            └── <time>__<trace>/
                ├── graph.json
                └── meta.json
```

- `graph.json`：执行图，用于可视化或分析。
- `meta.json`：请求信息，包括 ID、时间和摘要等。
- 日期和时间默认使用服务所在机器的本地时区。可设置 `MEMOS_SMARTCOMMENT_OUTPUT_TIMEZONE=Asia/Shanghai`，或指定其他 IANA 时区。

请求目录取决于最先记录的事件，也可能是 `memread` 或 `other`。后续事件会继续写入原来的图，保留原有目录；服务重启后也一样。

### 5. 结束调试

从 `MEMOS_ENABLED_PLUGINS` 中移除 `smartcomment`，然后重启 MemOS。如果它是唯一开启的插件，且变量是在 shell 中设置的，执行：

```bash
unset MEMOS_ENABLED_PLUGINS
```

如果 `.env` 文件或服务配置中也设置了这个变量，请一并移除其中的 `smartcomment`。已生成的文件会保留。

## 可视化执行图

使用 `smartcomment` 的可视化工具前，先在当前环境中安装可选依赖：

```bash
python -m pip install "smartcomment[viz]>=0.1.2"
```

将 `/path/to/graph.json` 替换为 `index.md` 中对应的图文件路径：

```bash
smartcomment-visualize /path/to/graph.json --backend pyvis --output trace.html
```

在浏览器中打开 `trace.html`，即可交互查看执行图。如需导出 PNG，还要安装 Graphviz 系统程序，然后运行：

```bash
smartcomment-visualize /path/to/graph.json --backend graphviz --output trace.png
```

导出 DOT 源文件无需安装可选的可视化依赖：

```bash
smartcomment-visualize /path/to/graph.json --backend dot --output trace.dot
```

## 将检索结果追溯到来源

设置 `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true` 后，Search 图会加入最终结果已记录的来源：

```text
原始消息 → 提取 → 写入 → 增强 → 写入 ← 最终检索结果
```

每条溯源连接会显示结果在最终列表中的位置（`rank`，从 1 开始）和观测到的分数。沿着连接，可以在同一张图中追查这条结果从原始消息到检索返回的过程。

对应的 Add 历史必须已经保存在同一个输出目录中，并且属于同一用户和项目。插件通过 cube ID 和 memory ID 匹配记忆，将匹配的记忆及其上游历史复制到 Search 图中，原始 Add 文件保持不变。

溯源只覆盖最终检索结果。如果要排查的记忆没有进入最终结果，请查看原始 Add 图，并比较 Search 各阶段的结果列表。插件会跳过缺失或无法明确匹配的历史。迟到的 Add 事件不会更新之前的 Search 图，需要等历史保存后重新检索。

## 与 MemTrace 配合使用

记录和查看执行图无需安装 MemTrace。如果要用 AI Agent 辅助排查，请单独安装并配置 MemTrace，再用其图探查工具加载 `graph.json`。使用开启了溯源的 Search 图，可以从最终结果追查到原始消息。

使用 MemTrace 的批量错误归因和诊断报告工具时，除了执行图，还需要按工具要求的格式准备问题、模型回答、参考答案和标注。本插件记录的是服务端的记忆操作，不包含客户端或评测脚本生成的回答，这些数据需要从评测流程中补充。

## 配置参考

在服务启动前设置环境变量，修改后重启 MemOS 即可生效。未设置的变量使用下表中的默认值。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `MEMOS_ENABLED_PLUGINS` | 未设置 | 加入 `smartcomment` 以开启插件；多个插件名称用逗号分隔。 |
| `MEMOS_SMARTCOMMENT_OUTPUT_DIR` | `.memos/memtrace` | 输出目录；相对路径以服务的工作目录为基准。 |
| `MEMOS_SMARTCOMMENT_OUTPUT_TIMEZONE` | `local` | 请求目录和时间戳使用的时区，支持 `Asia/Shanghai`、`UTC` 等 IANA 时区名称。 |
| `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD` | `false` | 将最终检索结果关联到已记录的 Add 历史。 |
| `MEMOS_SMARTCOMMENT_MAX_VALUE_CHARS` | `20000` | 每个字符串最多记录的字符数。 |
| `MEMOS_SMARTCOMMENT_PROJECT_ID` | `memos` | 写入图中的项目标识，也用于历史匹配。 |
| `MEMOS_SMARTCOMMENT_QUEUE_SIZE` | `1024` | 待处理追踪事件的上限；队列满时丢弃事件并记录警告。 |
| `MEMOS_SMARTCOMMENT_MAX_CACHED_TRACES` | `64` | 内存中最多缓存的图数量。 |
| `MEMOS_SMARTCOMMENT_MAX_CACHED_GRAPH_ITEMS` | `50000` | 内存中最多缓存的图元素总数。 |
| `MEMOS_SMARTCOMMENT_CACHE_TTL_SECONDS` | `300` | 空闲缓存的过期时间，单位为秒。 |
| `MEMOS_SMARTCOMMENT_STRICT` | `false` | 开启更严格的图标识检查，通常保持默认即可。 |

缓存限制不会删除磁盘上的文件。可以清理不再需要的产物，但请保留检索溯源所需的 Add 文件。历史越多，溯源时需要扫描的数据也越多。
