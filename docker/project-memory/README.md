# 本地部署（项目记忆 · promem_dev）

在本地起一个真服务：MemOS 服务 + Neo4j 社区版 + Qdrant，项目记忆用自己的 SQLite 文件库。

## 为什么是这个组合

核心用 `neo4j-community`：开源版的默认后端。核心代码在 `graph_dbs/` 之外一共调用图库的 30 个方法，开源基线（`dev-v2.0.36`）上各后端实现了几个：

| 后端 | 实现 | 缺的 |
| --- | --- | --- |
| polardb | 30 | 无，但依赖 `polar_age` + pg_jieba，是线上的云库，本地起不了 |
| **neo4j-community** | **28** | `search_by_keywords_like/tfidf`（只在 feedback 的关键词替换里用）；`search_by_fulltext` 有但返回空 |
| postgres | 19 | `get_edges`、两个整理用的计数、四个管理接口等 11 个 |

社区版不带向量索引，向量放在 Qdrant，所以是两个容器。

项目记忆不放进 Neo4j，用自己的 SQLite：neo4j 两种后端的 `search_by_fulltext` 都只有一行 `return []`，也没有 `rev` 条件写——放进去会少一路召回，并发整理同一条决策会丢更新。SQLite 库两样都有（FTS5 中文三元组 + `add_node(..., expected_rev=n)`）。

## 起服务

**一键**：在 Finder 里双击 `docker/project-memory/启动项目记忆服务.command`，或在终端执行
`bash docker/project-memory/start.sh`。它依次检查 Docker 与端口、建一个只装 python-dotenv / httpx 的 venv、
生成 `.env`、构建镜像、起容器、等 `/health`、灌一遍样例数据（保留），最后打印访问地址。可以重复执行；
`--no-smoke` 只起服务，`--rebuild` 重建底座镜像，`--stop` 停服务。

手动分步：

```bash
cd MemOS_DEV/MemOS

# 1) 生成 .env：只从 env_example 取模型 key，库指到 compose 里的 neo4j / qdrant
python3 docker/project-memory/make_env.py --env-file ../env_example

# 2) 构建底座镜像（仓库自带的 Dockerfile）+ 部署镜像
docker build -f docker/Dockerfile -t memos-base:promem .
docker build -f docker/project-memory/Dockerfile -t memos-promem:local .
docker compose -f docker/project-memory/docker-compose.yml up -d   # 不加 --build：新版 compose 构建要 buildx 插件

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
   服务接到共享库。`make_env.py` 只挑模型那几项，库与端口在 `env.template` 里写死成本地容器。

## `.env` 里放什么

| 组 | 关键项 |
| --- | --- |
| 核心模型 | `MOS_CHAT_MODEL`、`OPENAI_API_KEY/BASE`、`MEMRADER_*`、`EMBEDDING_DIMENSION=1024` |
| 核心库 | `GRAPH_DB_BACKEND=neo4j-community`、`NEO4J_URI=bolt://neo4j:7687`、`NEO4J_PASSWORD=projectmemory`、`QDRANT_HOST=qdrant` |
| 调度 | `MEMSCHEDULER_USE_REDIS_QUEUE=false`（单机进程内队列） |
| 项目记忆 | `MEMOS_ENABLED_PLUGINS=project_memory`、`PROJECT_MEMORY_GRAPH_DB=sqlite`、`PROJECT_MEMORY_SQLITE_PATH=/data/project_memory/project_memory.db` |
| 项目记忆模型 | `PROJECT_MEMORY_LLM_*`（温度 0）、`PROJECT_MEMORY_JUDGE_LLM_*`、`PROJECT_MEMORY_EMBEDDER_*` |
| 段管理 | `PROJECT_MEMORY_IDLE_MINUTES=30`、`PROJECT_MEMORY_DEBUG_TRACE=false` |

`PROJECT_MEMORY_GRAPH_DB` 三个取值：`sqlite`（默认）、`postgres`（自己一个 schema，用 `PROJECT_MEMORY_POSTGRES_*`）、
`shared`（核心那个 graph_db 实例；核心是 neo4j 时不建议，原因见上）。

## 已验证到哪一步（沙箱，不是 docker）

沙箱没有 docker，所以按镜像里的同一套组件手动起：`make_env.py` 从 `env_example` 渲染出的 `.env`（compose 里
`environment` 那几项改成本机地址）+ uvicorn + **Neo4j 5.26.6（社区版）+ Qdrant 1.15.3** + `pip install -e .`
注册入口点 + 真实模型（gpt-4o-mini / bge-m3）。跑的就是本目录的 `smoke.py`：

- `--scenario decision`：七轮（六段）全过，每轮 `get/status` 一个主题；决策走了 add → conflict（护栏把模型的
  rewrite 改成 conflict）→ join → conflict → rewrite 定案；
- `--scenario experience`：三段全过；B 新建（0.5）→ D 补充（0.6，旧版归档）→ E 被护栏降为新增待验证（上限 5 步时 8 步超限；放宽到 8 步后这次合并成 10 步，仍超限，见已知问题）；
- 项目记忆落在 SQLite 文件库，Neo4j 里只有核心记忆。单测 37 条全过。

docker 本身（镜像构建、compose 编排、命名卷、healthcheck）没在这里跑过，第一次在你机器上跑请留意
`docker build` 输出。

## 真服务跑出来的问题（已修）

1. <mark>`flush` 不更新任务</mark>：会话结束调 `flush` 能整理出主题，但没记到 add 的任务上，
   `get/status` 一直是空。现在 `flush` 接受 `task_id`，整理完把主题记上去。**接入方要带这个参数。**
2. 冒烟脚本原来在调度器跑完前就查状态，改成轮询。
3. 空闲关段的「现在」原来取墙钟，导入历史会话时每段都会被判成空闲。改成取这批消息的时间。

## 已知问题

- **合并后的 principle 仍可能超过上限**。上限已由 5 步放宽到 8 步（11/17），但合并模型倾向于把两张卡的步骤
  直接拼接（会有「运行测试以验证功能」「运行测试以验证导入结果」这种同义重复），几轮合并后照样超限；超限时护栏
  把 update 降成「新增待验证」。实跑：第 2 段合并为 8 步、通过；第 3 段合并为 10 步、被降级。
- 单机进程内队列（`MEMSCHEDULER_USE_REDIS_QUEUE=false`）；多副本要换 Redis 队列。同一 Space 的串行锁
  只在单进程内有效（`rev` 条件写只保护单条记录）。
- 项目记忆的库与核心的 Neo4j 是两个库：清空、迁移要分开做。
- 核心在 neo4j 上的关键词 / 全文召回是空的（上游未实现），只影响个人记忆检索，与项目记忆无关。
- 会话结束时调 `flush` 是接入方的责任（本地插件、Memmy）。不调的话最后一段要等下一次写入或空闲超时。
