# 本地部署（项目记忆 · promem_dev）

在本地起一个真服务：MemOS 服务 + PostgreSQL（pgvector），项目记忆与核心共用一个 Postgres、各用一个 schema。

## 为什么是 Postgres

三个后端里它最轻：

| 后端 | 额外要装什么 | 本地起几个进程 |
| --- | --- | --- |
| **postgres** | 标准 Postgres + 一个扩展 `vector`（代码里只 `CREATE EXTENSION vector`，两张普通表 `memories` / `edges`） | 1 个容器 |
| neo4j | JVM + 社区版配置里写死要 Qdrant（`vec_config.backend=qdrant`） | neo4j + qdrant + memos |
| polardb | `polar_age` 图引擎 + `vector` + 中文分词（`jiebacfg`） | 云端共享库，不建议本地 |

## 起服务

```bash
cd MemOS_DEV/MemOS

# 1) 生成 .env：只从 env_example 取模型 key，库指到 compose 里的 postgres
python3 docker/project-memory/make_env.py --env-file ../env_example

# 2) 构建底座镜像（仓库自带的 Dockerfile）+ 部署镜像
docker build -f docker/Dockerfile -t memos-base:promem .
docker compose -f docker/project-memory/docker-compose.yml up -d --build

# 3) 冒烟（走 HTTP；整理是异步的，脚本会轮询 get/status）
python3 docker/project-memory/smoke.py --base http://127.0.0.1:8000

# 4) 看日志 / 停（数据在命名卷里，down 不删）
docker compose -f docker/project-memory/docker-compose.yml logs -f memos
docker compose -f docker/project-memory/docker-compose.yml down
```

## 两个必须改的地方（直接用仓库自带的 compose 会踩）

1. <mark>镜像里没注册插件入口点</mark>。`docker/Dockerfile` 只设 `PYTHONPATH=/app/src`，而插件发现走
   `importlib.metadata.entry_points(group="memos.plugins")`。照它构建，`project_memory` 与 Dream
   都不会加载，`allow_memory_view=project` 直接 400。部署镜像补了 `pip install -e . --no-deps`。
2. <mark>`env_example` 里核心库指向公司 PolarDB</mark>（`NEO4J_BACKEND=polardb`）。整份抄过去会把本地
   服务接到共享库。`make_env.py` 只挑模型那几项，库与端口在 `env.template` 里写死成本地 postgres。

## `.env` 里放什么

| 组 | 关键项 |
| --- | --- |
| 核心模型 | `MOS_CHAT_MODEL`、`OPENAI_API_KEY/BASE`、`MEMRADER_*`、`EMBEDDING_DIMENSION=1024` |
| 核心库 | `GRAPH_DB_BACKEND=postgres`、`POSTGRES_HOST=postgres`、`POSTGRES_USER/PASSWORD/DB=memos/projectmemory/memos`、`MEMOS_SCHEMA=memos` |
| 调度 | `MEMSCHEDULER_USE_REDIS_QUEUE=false`（单机进程内队列） |
| 项目记忆 | `MEMOS_ENABLED_PLUGINS=project_memory`、`PROJECT_MEMORY_GRAPH_DB=postgres`、`PROJECT_MEMORY_POSTGRES_SCHEMA=project_memory` |
| 项目记忆模型 | `PROJECT_MEMORY_LLM_*`（温度 0）、`PROJECT_MEMORY_JUDGE_LLM_*`、`PROJECT_MEMORY_EMBEDDER_*` |
| 段管理 | `PROJECT_MEMORY_IDLE_MINUTES=30`、`PROJECT_MEMORY_DEBUG_TRACE=false` |

`PROJECT_MEMORY_GRAPH_DB` 三个取值：`postgres`（自己一个 schema，默认推荐）、`shared`（就是核心那个
graph_db 实例）、`sqlite`（SQLite 文件库，不依赖外部服务）。

## 已验证到哪一步（沙箱，不是 docker）

沙箱没有 docker，所以按镜像里的同一套组件手动起：uvicorn + **PostgreSQL 14.24 + pgvector 0.8.0**
（自己编的扩展）+ `pip install -e .` 注册入口点 + 真实模型（gpt-4o-mini / bge-m3）。跑的就是本目录的
`smoke.py`：

- `--scenario decision`：六段全过，`get/status` 每轮 1 个主题；
- `--scenario experience`：三段全过；
- 落库（`project_memory` schema）：消息 15、索引 4、经验 3、任务 3、episode 3、决策 2、空间 1、主题 1；
  核心的 `memos` schema 一行没写（项目记忆独立）。
- 单测 37 条全过。

docker 本身（镜像构建、compose 编排、命名卷、healthcheck）没在这里跑过，第一次在你机器上跑请留意
`docker build` 输出。

## 这一轮真服务跑出来的问题（已修）

1. <mark>`flush` 不更新任务</mark>：会话结束调 `flush` 能整理出主题，但没记到 add 的任务上，
   `get/status` 一直是空。现在 `flush` 接受 `task_id`，整理完把主题记上去。**接入方要带这个参数。**
2. <mark>postgres 后端原来没有条件写</mark>：`add_node` 是整行 upsert，两个任务同时改一条决策会丢更新。
   加了 `rev` 列与 `add_node(..., expected_rev=n)`（`WHERE rev = n`，0 行即冲突），与 SQLite 后端的
   契约一致；`BaseGraphDB` 的 `supports_cas` / `ConcurrentUpdateError` 两边共用。
3. <mark>postgres 后端原来没有 `search_by_fulltext`</mark>（只有 polardb / neo4j 有），而核心
   `mem_feedback` 会在 `DB_IDX_READY` 时调它。补了实现：中文按二元组 `ILIKE` 匹配（`to_tsquery('simple')`
   会把整段中文当一个 token，中文召回不出来），得分 = 命中的二元组占比。
4. 冒烟脚本原来在调度器跑完前就查状态，改成轮询。
5. 空闲关段的「现在」原来取墙钟，导入历史会话时每段都会被判成空闲。改成取这批消息的时间。

## 已知问题（未修，要看你的意见）

- **真实模型常给出超过 5 步的 principle**。T2 §5.2 约束 `principle ≤5 步`，我的护栏（合并结果超限就不写进
  已有卡）会把 update 降成「新增待验证」。这一轮经验三段的第 2、3 段都是这样，结果库里有 3 张 verified /
  candidate 卡，而不是 1 张主卡 + 归档。要么放宽这个约束，要么在提示词里更强地要求「≤5 步、每步一句」。
- 单机进程内队列（`MEMSCHEDULER_USE_REDIS_QUEUE=false`）；多副本要换 Redis 队列。同一 Space 的串行锁
  只在单进程内有效（`rev` 条件写只保护单条记录）。
- 会话结束时调 `flush` 是接入方的责任（本地插件、Memmy）。不调的话最后一段要等下一次写入或空闲超时。
