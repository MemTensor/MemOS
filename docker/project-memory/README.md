# 本地部署（项目记忆 · promem_dev）

在本地起一个真服务：MemOS 服务 + Neo4j + Qdrant，项目记忆用自己的 SQLite 文件库。

## 为什么不能直接用 `docker/docker-compose.yml`

它有两个问题，直接起会踩：

1. <mark>镜像里没注册插件入口点</mark>。仓库的 `docker/Dockerfile` 只设了 `PYTHONPATH=/app/src`，
   而插件发现是走 `importlib.metadata.entry_points(group="memos.plugins")` 的。照它构建，
   `project_memory` 和 Dream 都不会被加载，`allow_memory_view=project` 会直接返回 400。
   本目录的 Dockerfile 在底座上补 `pip install -e . --no-deps`（你验证过：装完
   `entry_points` 里能看到 `dream` 与 `project_memory`）。
2. 它读 `<repo>/.env`，而 `MemOS_DEV/env_example` 里核心库指向公司 PolarDB
   （`NEO4J_BACKEND=polardb`）。整份抄过去会把本地服务接到共享库上。

## 起服务

```bash
cd MemOS_DEV/MemOS

# 1) 生成 .env：只从 env_example 取模型 key，Neo4j 指到 compose 里的容器
python3 docker/project-memory/make_env.py --env-file ../env_example

# 2) 构建底座镜像（仓库自带的 Dockerfile）+ 部署镜像
docker build -f docker/Dockerfile -t memos-base:promem .
docker compose -f docker/project-memory/docker-compose.yml up -d --build

# 3) 冒烟（走 HTTP；整理是异步的，脚本会轮询 get/status）
python3 docker/project-memory/smoke.py --base http://127.0.0.1:8000

# 4) 看日志 / 停
docker compose -f docker/project-memory/docker-compose.yml logs -f memos
docker compose -f docker/project-memory/docker-compose.yml down      # 数据在命名卷里，down 不删
```

`.env` 里放什么：`env.template` 已写全，`make_env.py` 只替 `__...__` 占位。清单：

| 组 | 关键项 |
| --- | --- |
| 核心模型 | `MOS_CHAT_MODEL`、`OPENAI_API_KEY/BASE`、`MEMRADER_*`、`EMBEDDING_DIMENSION=1024` |
| 核心图库 | `NEO4J_BACKEND=neo4j-community`、`NEO4J_URI=bolt://neo4j:7687`、`NEO4J_PASSWORD=projectmemory` |
| 调度 | `MEMSCHEDULER_USE_REDIS_QUEUE=false`（单机进程内队列） |
| 项目记忆 | `MEMOS_ENABLED_PLUGINS=project_memory`、`PROJECT_MEMORY_GRAPH_DB=sqlite`、`PROJECT_MEMORY_SQLITE_PATH=/data/project_memory/project_memory.db` |
| 项目记忆模型 | `PROJECT_MEMORY_LLM_*`（温度 0）、`PROJECT_MEMORY_JUDGE_LLM_*`、`PROJECT_MEMORY_EMBEDDER_*` |
| 段管理 | `PROJECT_MEMORY_IDLE_MINUTES=30`、`PROJECT_MEMORY_DEBUG_TRACE=false` |

## 已验证到哪一步（在沙箱里，不是 docker）

沙箱没有 docker，所以我是按镜像里的同一套组件手动起的：uvicorn + Neo4j 5.26.6（JDK 21）+ Qdrant 1.15.3
+ `pip install -e .` 注册入口点 + 真实模型（gpt-4o-mini / bge-m3）。跑的就是本目录的 `smoke.py`：

- `--scenario decision`：六段（七轮）全过，`get/status` 上每轮 1 个主题；
- `--scenario all`：再加经验三段，全过。落库状态：决策 1 条（v6，当前结论「团队决定实现 add/message
  的项目记忆写入，按 PRD 执行。」，2 项历史，1 项不一致），经验 1 条激活（conf 0.7，作者 b/d/e）
  加 2 个归档版本，主题 1 个（9 个来源会话），`memory_fts` 64 行。

docker 本身（镜像构建、compose 编排、命名卷、healthcheck）没在这里跑过，第一次在你机器上跑请留意
`docker build` 的输出。

## 这一轮真服务跑出来的问题（已修）

1. <mark>`flush` 不更新任务</mark>：会话结束调 `flush` 能整理出主题，但主题没记到 add 的任务上，
   `get/status` 一直是空。现在 `flush` 接受 `task_id`，整理完把主题记到那个任务。
   **接入方要带上这个参数**，否则界面看不到这一轮的结果。
2. 冒烟脚本原来在调度器跑完前就查状态（整理是异步的），改成轮询到 `completed` / `failed`。
3. 镜像不注册入口点（见上），部署镜像补了 `pip install -e .`。
4. 空闲关段的「现在」原来取墙钟：导入历史会话时每一段都会被判成空闲。现在取这批消息的时间。

## 已知限制

- 单机进程内队列（`MEMSCHEDULER_USE_REDIS_QUEUE=false`），多副本部署要改 Redis 队列；
  同一 Space 的串行锁只在单进程内有效（SQLite 的 `rev` 条件写只保护单条记录）。
- 项目记忆的库与核心的 Neo4j 是两个库：清空/迁移要分开做。
- 会话结束时调 `flush` 是接入方的责任（本地插件、Memmy）。不调的话，最后一段要等下一次同 Space
  写入或 30 分钟空闲超时才整理。
