# SmartComment：追踪 MemOS 的记忆写入与检索

[English](README.md) | 简体中文

SmartComment 帮助你看清 **MemOS 如何把消息变成记忆，以及之后如何检索这些记忆**。这个可选插件将记忆操作记录为执行图，方便排查「为什么这条事实没被记住」「这条检索结果最初来自哪里」等问题。

它适合用于复现失败用例、评估记忆质量，以及验证提取或检索策略的改动。插件**默认关闭，安装后也不会自动启用**。需要时在开发或测试环境中开启即可，日常使用 MemOS 无需安装或开启它。

## 能看到什么

| 功能 | 可以帮助回答的问题 |
| --- | --- |
| 记忆写入 | 哪些消息产生了记忆？提取出了什么内容？写入操作返回了哪些记忆 ID？ |
| 后台处理 | MemRead 如何增强记忆、写入增强结果，或删除旧记忆？ |
| 检索阶段 | 记忆有没有被召回？是否在过滤或去重时消失？最终结果的顺序和分数是什么？ |
| 检索结果溯源 | 某条最终结果来自哪些原始消息，经过了哪些处理？此功能需要单独开启。 |
| 请求浏览 | 哪张图对应哪次请求？每个用户都有一份 `index.md`，列出时间、请求摘要、trace ID 和图文件链接。 |

执行图记录以下流程：

```text
Add：   消息 → 提取出的记忆 → 写入的记忆 → 后台增强
Search：查询 → 记忆类型 → 记忆 cube → 召回 → 过滤 → 去重 → 重排
```

cube 是 MemOS 中用于组织记忆的集合。Search 图展示实际执行阶段的结果列表，未启用的过滤或去重阶段会跳过。后台 MemRead 事件可能在 API 返回之后到达；携带相同追踪上下文的事件会继续补充原来的图。

插件只观测操作，不改变业务结果。记录过程仍会占用资源；图中展示的是插件观测到的操作，不代表对数据库状态的独立核验。

## 快速开始

### 1. 准备 MemOS 环境

使用 **Python 3.12 或更新版本**，并激活**运行 MemOS 的同一个 Python 环境**。请先按照 [MemOS 部署说明](../../README.md)配置服务、模型和存储。以下命令均假设你位于 MemOS 仓库根目录。

```bash
# 如果当前环境已经安装了本地 MemOS，可跳过这一行。
python -m pip install -e .

python -m pip install "smartcomment>=0.1.2"
python -m pip install -e apps/memtrace-memos-integration
```

`smartcomment` 是公开的 PyPI 包，无需另外下载其源码。本目录中的 MemOS 集成插件也需要单独安装。

如果使用 `uv` 环境且没有 `pip` 模块，可将 `python -m pip install` 替换为 `uv pip install --python .venv/bin/python`，并按实际环境调整解释器路径。

### 2. 开启插件并启动服务

在**启动 MemOS 之前**设置环境变量：

```bash
export MEMOS_ENABLED_PLUGINS=smartcomment
export MEMOS_SMARTCOMMENT_OUTPUT_DIR="$PWD/.memos/memtrace"

# 可选：将最终检索结果关联到它们的来源。默认关闭。
export MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true

python -m uvicorn memos.api.server_api:app --host 127.0.0.1 --port 8000 --workers 1
```

启动日志中应出现 `smartcomment plugin loaded`。如果还使用其他需手动开启的插件，请在 `MEMOS_ENABLED_PLUGINS` 中保留它们的名称，用逗号分隔。修改插件配置后需要重启服务。

示例使用单个 worker。每个写入进程都需要独立的输出目录，多个 worker 不应共用同一目录。

### 3. 写入一条记忆，再检索它

通过[本地 API 文档](http://127.0.0.1:8000/docs)或已有客户端调用 `/product/add` 和 `/product/search`。如果已有用户和记忆 cube，可以在另一个终端尝试以下命令。将 `YOUR_USER_ID` 和 `YOUR_CUBE_ID` 替换为实际值；如需先创建 cube，请参考 [MemOS README](../../README.md)。

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

示例先写入「我每周二、周四去游泳」，再询问游泳时间。请确认 Add 请求成功后再检索。图文件异步写入；如需检索溯源，请等待 Add 图生成后再执行 Search。后台增强可能仍在继续。

为了将图与业务日志对应，可以通过请求头 `x-trace-id` 指定追踪 ID。如果希望每次请求各有一张图，请使用不同的 trace ID：同一用户下复用 trace ID 的请求会归入同一张图。检索溯源不要求 Add 和 Search 使用相同的 trace ID。

### 4. 查找已记录的请求

采用上面的输出目录配置时，在仓库根目录运行：

```bash
find .memos/memtrace -type f -name index.md
```

打开对应用户的 `index.md`。请求按时间倒序排列，每条记录包含带 UTC 偏移量的时间、请求类型、查询或消息摘要、完整 trace ID，以及 `graph.json` 链接。

主要文件按以下方式组织；名称仅作示意，省略了辅助索引文件：

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
- 日期和时间默认使用运行服务的机器的本地时区。可通过 `MEMOS_SMARTCOMMENT_OUTPUT_TIMEZONE=Asia/Shanghai` 或其他 IANA 时区名称指定时区。

部分请求会出现在 `memread` 或 `other` 目录下，取决于最先记录的事件。后续事件会继续写入原来的图，服务重启后也是如此，不会移动已有目录。

### 5. 结束调试

从 `MEMOS_ENABLED_PLUGINS` 中移除 `smartcomment`，然后重启 MemOS。如果它是唯一开启的插件，且变量是在 shell 中设置的，可以执行：

```bash
unset MEMOS_ENABLED_PLUGINS
```

如果 `.env` 文件或服务配置也设置了这个变量，请一并移除其中的 `smartcomment`。此前生成的文件会保留。

## 可视化执行图

公开的 `smartcomment` 包提供了可视化工具。先在当前环境中安装可选的可视化依赖：

```bash
python -m pip install "smartcomment[viz]>=0.1.2"
```

将 `/path/to/graph.json` 替换为 `index.md` 中对应的图文件路径：

```bash
smartcomment-visualize /path/to/graph.json --backend pyvis --output trace.html
```

在浏览器中打开 `trace.html` 即可交互查看。如需导出 PNG 图片，还需要安装 Graphviz 系统程序，然后运行：

```bash
smartcomment-visualize /path/to/graph.json --backend graphviz --output trace.png
```

也可以导出 DOT 源文件，此方式无需安装可选的可视化依赖：

```bash
smartcomment-visualize /path/to/graph.json --backend dot --output trace.dot
```

这些命令的输入应为 **`graph.json`**，不要使用元数据或索引 JSON 文件。

## 将检索结果追溯到来源

设置 `MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD=true` 后，Search 图会包含最终结果已记录的来源链路：

```text
原始消息 → 提取 → 写入 → 增强 → 写入 ← 最终检索结果
```

每条溯源连接都会显示该结果在最终列表中的位置（`rank`，从 1 开始）和观测到的分数。这样就能在一张图里查看某条结果从原始消息到检索返回的已记录过程。

使用此功能时，对应的 Add 历史必须已经保存在**同一个输出目录**中，并且属于同一用户和项目。插件通过 cube ID 和 memory ID 匹配记忆，将匹配的记忆及其上游历史加入 Search 图，原始 Add 文件保持不变。

溯源**只覆盖最终检索结果**。如果要排查的记忆没有进入最终结果，请查看原始 Add 图，并比较 Search 各阶段的结果列表。缺失或无法明确匹配的历史不会被强行关联。迟到的 Add 事件不会补入之前的 Search 图，待历史保存后重新检索即可。

## 与 MemTrace 配合使用

三个组件的分工如下：

| 组件 | 作用 |
| --- | --- |
| 本 MemOS 集成插件 | 记录记忆操作，保存执行图。 |
| [smartcomment](https://pypi.org/project/smartcomment/) | 提供通用的执行图格式和可视化工具。 |
| [MemTrace](https://github.com/zjunlp/MemTrace) | 独立项目，通过 AI Agent 探查执行图，分析记忆系统中的失败原因。 |

不安装 MemTrace，也可以使用本插件并查看产物。如果需要 Agent 辅助排查，请单独安装和配置 MemTrace，再使用其图探查工具加载 `graph.json`。开启溯源后的 Search 图适合从最终结果追查到原始消息。

本插件记录 MemOS 服务端的记忆操作，不会记录客户端或评测脚本生成的回答。因此，使用 MemTrace 的批量错误归因和诊断报告流程时，还需要按其要求的格式补充问题、模型回答、参考答案和标注。单个图文件并不是完整的评测用例。

## 配置参考

在服务启动前设置环境变量，修改后重启 MemOS。下表为未显式配置时的默认值。

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

缓存限制不会删除已保存的文件。请按调试需求保留或清理产物；检索溯源依赖相关 Add 文件，历史越多，需要扫描的数据也越多。

## 常见问题与数据管理

| 问题 | 排查方法 |
| --- | --- |
| 没有生成图 | 确认两个包都安装在服务使用的 Python 环境中，插件在启动前已开启，日志包含 `smartcomment plugin loaded`。执行 Add 或 Search 请求，等待后台写入，再检查输出路径和写入警告。 |
| Search 图里没有 Add 来源 | 开启溯源并重启服务；确认 Add 图在 Search 前已经保存，输出目录、用户、项目、cube ID 和 memory ID 能对应。未进入最终结果的记忆不会被关联。 |
| 图看起来不完整 | 后台事件可能尚未完成；队列溢出、写入失败或进程突然退出也可能导致缺失，请检查服务日志。 |
| 图中的时间与浏览器时间不同 | 默认使用服务所在机器的时区，容器内也一样。需要时请显式指定输出时区。 |

插件会脱敏凭据类字段、省略向量内容，并截断过长字符串。但**消息正文、记忆内容和请求摘要仍可能包含敏感信息**。请限制输出目录的访问权限，并在分享图文件前检查内容。

如果从旧版平铺的 `<user>/<trace>.json` 布局升级，请使用新的输出目录。旧文件不会自动迁移，也不会用于检索溯源。
