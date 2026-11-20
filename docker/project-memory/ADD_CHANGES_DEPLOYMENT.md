# 本地部署与冒烟验证

基线为 `a09c6ff9`，初次交付为 `729cfc30`。每节的 `@@ -旧起点,行数 +新起点,行数 @@` 对应这两个提交，省略行数表示一行。

可在仓库根目录执行以下命令核对任一文件，使用小节标题中的路径。

```bash
git diff --no-color --no-ext-diff --unified=0 a09c6ff9 729cfc30 -- "<路径>"
```

## `docker/project-memory/README.md`

**原行为**　说明围绕单实例、进程内调度、旧图存储、逐段手动 flush 及旧冒烟覆盖。

**交付行为**　说明 Compose 双实例、共享 PostgreSQL 与 Redis、项目 ID、端口和环境隔离。更新 Episode 与 Formation 的配置、冒烟参数和数据保留方式，补充历史库预检、导入、只读归档和对账步骤。

**必要性**　避免部署及迁移仍按旧关段和队列流程操作，让验收者可按同一流程验证多实例与历史数据。

旧配置表所在 hunk 的行号是 `@@ -59,46 +62,3 @@`。该 hunk 的完整内容可用上面的命令查看。

````diff
diff --git a/docker/project-memory/README.md b/docker/project-memory/README.md
index dd9fb092..d3ace115 100644
--- a/docker/project-memory/README.md
+++ b/docker/project-memory/README.md
@@ -1 +1 @@
-# 本地部署（项目记忆 · promem_dev）
+# 项目记忆 Add 本地部署
@@ -3 +3 @@
-在本地起一个真服务：MemOS 服务 + Neo4j 社区版 + Qdrant，项目记忆用自己的 PostgreSQL（pgvector 镜像，容器名 memos-promem-postgres，本机端口 5433）。
+部署包含 MemOS、项目记忆 PostgreSQL（pgvector）、Redis Streams、Neo4j 社区版和 Qdrant。PostgreSQL 保存原文、Turn 归属、Episode 状态与 Topic。Redis 负责 Add 阶段调度。Neo4j 和 Qdrant 服务于原有记忆视图。Compose 将本机访问端口绑定到 `127.0.0.1`。
@@ -5 +5 @@
-## 为什么是这个组合
+## 启动
@@ -7 +7 @@
-核心用 `neo4j-community`：开源版的默认后端。核心代码在 `graph_dbs/` 之外一共调用图库的 30 个方法，开源基线（`dev-v2.0.36`）上各后端实现了几个：
+从仓库根目录运行。准备一份含模型设置的本地配置，`make_env.py` 会按模板生成 `.env`。项目记忆和调度使用 Compose 中的专用服务。
@@ -9,5 +9,2 @@
-| 后端 | 实现 | 缺的 |
-| --- | --- | --- |
-| polardb | 30 | 无，但依赖 `polar_age` + pg_jieba，是线上的云库，本地起不了 |
-| **neo4j-community** | **28** | `search_by_keywords_like/tfidf`（只在 feedback 的关键词替换里用）；`search_by_fulltext` 有但返回空 |
-| postgres | 19 | `get_edges`、两个整理用的计数、四个管理接口等 11 个 |
+```bash
+python3 docker/project-memory/make_env.py --env-file ../env_example
@@ -15 +12,4 @@
-社区版不带向量索引，向量放在 Qdrant，所以是两个容器。
+docker build -f docker/Dockerfile -t memos-base:promem .
+docker build -f docker/project-memory/Dockerfile -t memos-promem:local .
+docker compose -f docker/project-memory/docker-compose.yml up -d --wait
+```
@@ -17 +17 @@
-项目记忆不放进 Neo4j：neo4j 两种后端的 `search_by_fulltext` 都只有一行 `return []`，也没有 `rev` 条件写——放进去会少一路召回，并发整理同一条决策会丢更新。
+本地部署镜像使用 `pip install -e /app --no-deps` 注册 `project_memory` 入口，应用入口为 `memos.api.server_api:app`。单实例也可用 `bash docker/project-memory/start.sh`，它会构建镜像、等待 `/health` 并运行冒烟脚本。`--no-smoke` 只启动服务，`--rebuild` 重建底座镜像。
@@ -19 +19 @@
-项目记忆用自己的 PostgreSQL（`src/memos/project_memory/pg_backend.py`，不经核心的 postgres 后端）：多个副本 / worker 共享同一份数据，带 `rev` 条件写（`add_node(..., expected_rev=n)`）与中文二元组全文检索，表建在 schema `project_memory` 下、结构照老库 `Memory` 表。单进程试用也可以改回 SQLite 文件库（`PROJECT_MEMORY_GRAPH_DB=sqlite`，数据在命名卷 `promem_data`）。<mark>从 SQLite 换到 Postgres 时旧数据不迁移</mark>。
+双实例通过 `replica` profile 启动。两个 API 共享 PostgreSQL、Redis 连接和项目 ID。
@@ -21 +21,5 @@
-## 起服务
+```bash
+docker compose --profile replica -f docker/project-memory/docker-compose.yml up -d --wait
+python3 docker/project-memory/smoke.py \
+  --base http://127.0.0.1:8000 --peer http://127.0.0.1:8001
+```
@@ -23,4 +27 @@
-**一键**：在 Finder 里双击 `docker/project-memory/启动项目记忆服务.command`，或在终端执行
-`bash docker/project-memory/start.sh`。它依次检查 Docker 与端口、建一个只装 python-dotenv / httpx 的 venv、
-生成 `.env`、构建镜像、起容器、等 `/health`、灌一遍样例数据（保留），最后打印访问地址。可以重复执行；
-`--no-smoke` 只起服务，`--rebuild` 重建底座镜像，`--stop` 停服务。
+单实例冒烟可省略 `--peer`。脚本使用自带的合成轮次和请求内稳定的消息 ID，检查同一次 Add 写两个 Space、去重后的原文和开放消息计数、重复请求与冲突、归属校验、明确边界关段及同会话续写。每次运行创建独立的临时 Space，默认通过 API 删除，`--keep` 可保留供检查。`--scenario decision` 或 `--scenario experience` 可指定独立批次的样例类型。
@@ -28 +29 @@
-手动分步：
+若要在少量样例中验证 Topic 正式提交，可在专用测试环境的 `.env` 设置 `PROJECT_MEMORY_FORMATION_COUNT=1` 并重新启动，随后冒烟时加 `--require-topic`。默认 Formation 在条件满足前允许返回暂存的成功回执。
@@ -30,2 +31 @@
-```bash
-cd MemOS_DEV/MemOS
+## 配置与数据
@@ -33,2 +33,8 @@ cd MemOS_DEV/MemOS
-# 1) 生成 .env：只从 env_example 取模型 key，库指到 compose 里的 neo4j / qdrant
-python3 docker/project-memory/make_env.py --env-file ../env_example
+| 用途 | 关键配置与默认值 |
+| --- | --- |
+| 本地项目身份 | `PROJECT_MEMORY_PROJECT_ID=local-project`。两个实例使用相同值。 |
+| 项目数据库 | `PROJECT_MEMORY_GRAPH_DB=postgres`，`PROJECT_MEMORY_POSTGRES_SCHEMA=project_memory`。数据库通过 `127.0.0.1:5433` 从本机访问。 |
+| Redis Streams | `MEMSCHEDULER_USE_REDIS_QUEUE=true`。`REDIS_*` 和 `MEMSCHEDULER_REDIS_*` 都指向 `redis:6379`。可通过 `docker compose -f docker/project-memory/docker-compose.yml exec redis redis-cli` 从容器内查看。 |
+| 模型 | `PROJECT_MEMORY_LLM_*`、`PROJECT_MEMORY_JUDGE_LLM_*` 和 `PROJECT_MEMORY_EMBEDDER_*`。 |
+| Episode | 空闲 900 秒，首轮最长等待 1800 秒，最多 8 轮，体量阈值按 12000 token 估算。 |
+| Formation | 默认新增暂存段达到 10 条或达到 7200 秒阈值时检查。 |
@@ -36,4 +42 @@ python3 docker/project-memory/make_env.py --env-file ../env_example
-# 2) 构建底座镜像（仓库自带的 Dockerfile）+ 部署镜像
-docker build -f docker/Dockerfile -t memos-base:promem .
-docker build -f docker/project-memory/Dockerfile -t memos-promem:local .
-docker compose -f docker/project-memory/docker-compose.yml up -d   # 不加 --build：新版 compose 构建要 buildx 插件
+本机端口可通过 `MEMOS_LOCAL_HTTP_PORT`、`MEMOS_LOCAL_PEER_HTTP_PORT`、`MEMOS_LOCAL_POSTGRES_PORT`、`MEMOS_LOCAL_NEO4J_HTTP_PORT`、`MEMOS_LOCAL_NEO4J_BOLT_PORT`、`MEMOS_LOCAL_QDRANT_PORT` 配置。若要同时运行两套部署，为第二套指定独立的 Compose 项目名、`MEMOS_LOCAL_CONTAINER_PREFIX` 和本机端口。使用其他环境配置文件时，将 `MEMOS_LOCAL_ENV_FILE` 设为绝对路径，并把同一路径传给 `docker compose --env-file`。
@@ -41,2 +44 @@ docker compose -f docker/project-memory/docker-compose.yml up -d   # 不加 --bu
-# 3) 冒烟（走 HTTP；整理是异步的，脚本会轮询 get/status）
-python3 docker/project-memory/smoke.py --base http://127.0.0.1:8000
+保留旧版项目记忆数据时，请按迁移流程指定旧库、项目映射与归档位置。直接启动新版会使用新的关系表。停止服务保留 PostgreSQL 和 Redis 等命名卷。
@@ -44,3 +46,4 @@ python3 docker/project-memory/smoke.py --base http://127.0.0.1:8000
-# 4) 看日志 / 停（数据在命名卷里，down 不删）
-docker compose -f docker/project-memory/docker-compose.yml logs -f memos
-docker compose -f docker/project-memory/docker-compose.yml down
+```bash
+docker compose --profile replica -f docker/project-memory/docker-compose.yml ps
+docker compose --profile replica -f docker/project-memory/docker-compose.yml logs -f memos memos-peer
+docker compose --profile replica -f docker/project-memory/docker-compose.yml down
@@ -49 +52 @@ docker compose -f docker/project-memory/docker-compose.yml down
-## 两个必须改的地方（直接用仓库自带的 compose 会踩）
+### 导入历史项目记忆
@@ -51,5 +54 @@ docker compose -f docker/project-memory/docker-compose.yml down
-1. <mark>镜像里没注册插件入口点</mark>。`docker/Dockerfile` 只设 `PYTHONPATH=/app/src`，而插件发现走
-   `importlib.metadata.entry_points(group="memos.plugins")`。照它构建，`project_memory` 与 Dream
-   都不会加载，`allow_memory_view=project` 直接 400。部署镜像补了 `pip install -e . --no-deps`。
-2. <mark>`env_example` 里核心库指向公司 PolarDB</mark>（`NEO4J_BACKEND=polardb`）。整份抄过去会把本地
-   服务接到共享库。`make_env.py` 只挑模型那几项，库与端口在 `env.template` 里写死成本地容器。
+停止旧写入，排空已受理的旧任务并备份源库。为旧 Space 准备一份 JSON 对照表，键为旧 Space ID，值为可信项目 ID。先在隔离的目标 schema 验证报告。
@@ -57 +56,5 @@ docker compose -f docker/project-memory/docker-compose.yml down
-## `.env` 里放什么
+```bash
+python -m memos.project_memory.add_legacy_migrate \
+  --legacy-sqlite /path/to/backup.sqlite \
+  --mapping /path/to/spaces.json --project-id local-project
+```
````

## `docker/project-memory/docker-compose.yml`

**原行为**　只有一个 API 实例，容器名和本机端口固定，缺少共享 Redis 配置。

**交付行为**　抽出 API 共用模板，增加 `replica` profile 的第二实例、API 与 Redis 健康检查、Redis 持久卷、共享项目 ID 与 Redis 连接。容器前缀、环境文件和本机环回端口可配置。

**必要性**　在本地复现多实例对同一项目的写入、查询和恢复。可另设前缀和端口运行隔离的对照部署。

````diff
diff --git a/docker/project-memory/docker-compose.yml b/docker/project-memory/docker-compose.yml
index dde57c5e..ca83fe3e 100644
--- a/docker/project-memory/docker-compose.yml
+++ b/docker/project-memory/docker-compose.yml
@@ -1,23 +1 @@
-# 本地部署：MemOS 服务 + Neo4j（社区版）+ Qdrant，项目记忆用自己的 PostgreSQL（pgvector）。
-#
-#   1) 生成 .env（从 MemOS_DEV/env_example 取模型 key，只取模型那几项）
-#        python3 docker/project-memory/make_env.py --env-file ../env_example
-#   2) 构建底座镜像（仓库自带的 Dockerfile）与部署镜像
-#        docker build -f docker/Dockerfile -t memos-base:promem .
-#        docker build -f docker/project-memory/Dockerfile -t memos-promem:local .
-#   3) 起服务（不加 --build：新版 compose 构建要 buildx 插件，Colima 往往没有）
-#        docker compose -f docker/project-memory/docker-compose.yml up -d
-#   一键：bash docker/project-memory/start.sh
-#   4) 冒烟（本机跑；整理是异步的，脚本会轮询 get/status）
-#        python3 docker/project-memory/smoke.py --base http://127.0.0.1:8000
-#   5) 看日志 / 停（数据在命名卷里，down 不删）
-#        docker compose -f docker/project-memory/docker-compose.yml logs -f memos
-#        docker compose -f docker/project-memory/docker-compose.yml down
-#
-# 核心用 neo4j-community：开源版默认后端，核心调用的 30 个图库方法实现了 28 个（Postgres 只有 19 个）；
-# 社区版不带向量索引，向量放在 Qdrant。
-# 项目记忆不放进 Neo4j：neo4j 两种后端的 search_by_fulltext 都是空实现、也没有 rev 条件写。
-# 项目记忆的 Postgres（pm-postgres）：多个副本 / worker 共享同一份数据，带 rev 条件写与中文全文；
-# 表建在 schema project_memory 下，结构照老库 Memory 表。改回单文件 SQLite：.env 里
-# PROJECT_MEMORY_GRAPH_DB=sqlite（数据在命名卷 promem_data）。
-
+# 本地项目记忆服务。启动和双实例验证见同目录 README.md。
@@ -25,0 +4,42 @@ name: memos-project-memory
+x-memos: &memos
+  image: memos-promem:local
+  build:
+    context: ../..
+    dockerfile: docker/project-memory/Dockerfile
+  env_file:
+    - ${MEMOS_LOCAL_ENV_FILE:-../../.env}
+  depends_on:
+    neo4j:
+      condition: service_healthy
+    qdrant:
+      condition: service_started
+    pm-postgres:
+      condition: service_healthy
+    redis:
+      condition: service_healthy
+  environment:
+    QDRANT_HOST: qdrant
+    QDRANT_PORT: "6333"
+    NEO4J_URI: bolt://neo4j:7687
+    PROJECT_MEMORY_POSTGRES_HOST: pm-postgres
+    PROJECT_MEMORY_POSTGRES_PORT: "5432"
+    PROJECT_MEMORY_PROJECT_ID: ${PROJECT_MEMORY_PROJECT_ID:-local-project}
+    MEMSCHEDULER_USE_REDIS_QUEUE: "true"
+    REDIS_HOST: redis
+    REDIS_PORT: "6379"
+    REDIS_DB: "0"
+    MEMSCHEDULER_REDIS_HOST: redis
+    MEMSCHEDULER_REDIS_PORT: "6379"
+    MEMSCHEDULER_REDIS_DB: "0"
+  volumes:
+    - promem_data:/data/project_memory
+  networks:
+    - memos_network
+  healthcheck:
+    test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=3).close()"]
+    interval: 5s
+    timeout: 5s
+    retries: 30
+    start_period: 20s
+  restart: unless-stopped
+
@@ -28,5 +48,2 @@ services:
-    container_name: memos-promem
-    image: memos-promem:local   # start.sh 先用 docker build 构建好，compose 直接用
-    build:
-      context: ../..
-      dockerfile: docker/project-memory/Dockerfile
+    <<: *memos
+    container_name: ${MEMOS_LOCAL_CONTAINER_PREFIX:-memos-promem}
@@ -34,21 +51,8 @@ services:
-      - "8000:8000"
-    env_file:
-      - ../../.env
-    depends_on:
-      neo4j:
-        condition: service_healthy
-      qdrant:
-        condition: service_started
-      pm-postgres:
-        condition: service_healthy
-    environment:
-      - QDRANT_HOST=qdrant
-      - QDRANT_PORT=6333
-      - NEO4J_URI=bolt://neo4j:7687
-      - PROJECT_MEMORY_POSTGRES_HOST=pm-postgres
-      - PROJECT_MEMORY_POSTGRES_PORT=5432
-    volumes:
-      - promem_data:/data/project_memory
-    networks:
-      - memos_network
-    restart: unless-stopped
+      - "127.0.0.1:${MEMOS_LOCAL_HTTP_PORT:-8000}:8000"
+
+  memos-peer:
+    <<: *memos
+    profiles: [replica]
+    container_name: ${MEMOS_LOCAL_CONTAINER_PREFIX:-memos-promem}-peer
+    ports:
+      - "127.0.0.1:${MEMOS_LOCAL_PEER_HTTP_PORT:-8001}:8000"
@@ -58 +62 @@ services:
-    container_name: memos-promem-neo4j
+    container_name: ${MEMOS_LOCAL_CONTAINER_PREFIX:-memos-promem}-neo4j
@@ -60,2 +64,2 @@ services:
-      - "7474:7474"
-      - "7687:7687"
+      - "127.0.0.1:${MEMOS_LOCAL_NEO4J_HTTP_PORT:-7474}:7474"
+      - "127.0.0.1:${MEMOS_LOCAL_NEO4J_BOLT_PORT:-7687}:7687"
@@ -79 +83 @@ services:
-    container_name: memos-promem-qdrant
+    container_name: ${MEMOS_LOCAL_CONTAINER_PREFIX:-memos-promem}-qdrant
@@ -81 +85 @@ services:
-      - "6333:6333"
+      - "127.0.0.1:${MEMOS_LOCAL_QDRANT_PORT:-6333}:6333"
@@ -92 +96 @@ services:
-    container_name: memos-promem-postgres
+    container_name: ${MEMOS_LOCAL_CONTAINER_PREFIX:-memos-promem}-postgres
@@ -94 +98 @@ services:
-      - "5433:5432"   # 本机用 5433 连进来看数据，避开本机已有的 5432
+      - "127.0.0.1:${MEMOS_LOCAL_POSTGRES_PORT:-5433}:5432"
@@ -109,0 +114,14 @@ services:
+  redis:
+    image: redis:7.4-alpine
+    container_name: ${MEMOS_LOCAL_CONTAINER_PREFIX:-memos-promem}-redis
+    command: ["redis-server", "--appendonly", "yes"]
+    healthcheck:
+      test: ["CMD", "redis-cli", "ping"]
+      interval: 3s
+      timeout: 5s
+      retries: 30
+    volumes:
+      - redis_data:/data
+    networks:
+      - memos_network
+
@@ -115,0 +134 @@ volumes:
+  redis_data:
````

## `docker/project-memory/env.template`

**原行为**　本地调度默认使用进程内队列，旧关段只列出分钟阈值。

**交付行为**　启用 Redis Streams，补齐两组 Redis 客户端变量和可信项目 ID。明确关系库存储内容以及 Episode 和 Formation 的默认阈值。

**必要性**　让两个 API 实例具备相同的关系 Add 依赖和项目范围，冒烟环境也可显式配置相同的关闭条件。

````diff
diff --git a/docker/project-memory/env.template b/docker/project-memory/env.template
index ace61e6e..8a4ad9c5 100644
--- a/docker/project-memory/env.template
+++ b/docker/project-memory/env.template
@@ -2 +2 @@
-# 只放本地部署需要的最小集合；公司 PolarDB / Redis / 网关的配置一律不进来。
+# 部署用本地服务地址。make_env.py 从指定配置读取模型参数。
@@ -36,2 +36,8 @@ QDRANT_PORT=6333
-# 单机：用进程内队列，不起 Redis
-MEMSCHEDULER_USE_REDIS_QUEUE=false
+# Redis Streams 由两个 API 实例共享；Compose 注入相同的网络地址。
+MEMSCHEDULER_USE_REDIS_QUEUE=true
+REDIS_HOST=redis
+REDIS_PORT=6379
+REDIS_DB=0
+MEMSCHEDULER_REDIS_HOST=redis
+MEMSCHEDULER_REDIS_PORT=6379
+MEMSCHEDULER_REDIS_DB=0
@@ -41,0 +48 @@ MEMOS_ENABLED_PLUGINS=project_memory
+PROJECT_MEMORY_PROJECT_ID=local-project
@@ -44,3 +51 @@ MEMOS_ENABLED_PLUGINS=project_memory
-# 多副本 / 多 worker 共享同一份数据；带 rev 条件写与中文全文检索。
-# 不放进 Neo4j：neo4j 两种后端的全文检索都是空实现、也没有 rev 条件写。
-# 改回单文件 SQLite（只适合单进程）：PROJECT_MEMORY_GRAPH_DB=sqlite
+# 原文、Episode 和 Topic 存在同一个项目数据库，多个 API 实例共享。
@@ -75,2 +80,7 @@ PROJECT_MEMORY_EMBEDDER_API_KEY=__MOS_EMBEDDER_API_KEY__
-# 空闲关段阈值（分钟）与调试
-PROJECT_MEMORY_IDLE_MINUTES=30
+# Episode 积累和 Formation 默认值。少量样例可在专用测试环境调低阈值。
+PROJECT_MEMORY_EPISODE_IDLE_SECONDS=900
+PROJECT_MEMORY_EPISODE_WAIT_SECONDS=1800
+PROJECT_MEMORY_EPISODE_MAX_TURNS=8
+PROJECT_MEMORY_EPISODE_MAX_TOKENS=12000
+PROJECT_MEMORY_FORMATION_COUNT=10
+PROJECT_MEMORY_FORMATION_INTERVAL=7200
````

## `docker/project-memory/smoke.py`

**原行为**　脚本加载原有测试样本，每轮 Add 后调用 flush，统一要求产生主题。还验证过检索与读取的字段，以及清空主题后保留领域。

**交付行为**　脚本改用隔离的合成轮次和稳定消息 ID，经一个或两个 API 实例测试多 Space、开放消息、原文去重、精确重发、正文冲突、用户隔离、显式关段及原会话续写。通过 Task 状态和开放消息计数等待关段，`--require-topic` 单独检查正式提交。运行结束按选项保留或删除测试 Space。

**必要性**　直接覆盖持久 Add 的受理、去重及关段合同。默认阈值允许成功暂存，正式提交由专门选项检查。新版冒烟的断言集中在上述 Add 链路。

````diff
diff --git a/docker/project-memory/smoke.py b/docker/project-memory/smoke.py
index e4b5b87b..834ccd11 100644
--- a/docker/project-memory/smoke.py
+++ b/docker/project-memory/smoke.py
@@ -2,11 +2 @@
-"""对已启动的服务跑一遍项目记忆冒烟（走 HTTP，不 import 服务端代码）。
-
-    python3 docker/project-memory/smoke.py                       # 默认 http://127.0.0.1:8000
-    python3 docker/project-memory/smoke.py --base http://host:8000 --scenario decision
-
-依次：health → create_space → add/message ×N → flush（会话结束）→ get/status →
-search/memory → get/memory（space_id）→ get/memory/{topic} → get_message → delete_memory。
-
-样例数据用 examples/project_memory/mock_rounds.json（构造的：决策七轮 + 经验三段）。
-环境变了（模型、库）先跑这个，比单元测试更接近线上。
-"""
+"""Exercise project Add through its product HTTP routes using isolated synthetic Spaces."""
@@ -17 +7 @@ import argparse
-import json
+import os
@@ -21 +11,3 @@ import time
-from pathlib import Path
+from copy import deepcopy
+from datetime import datetime, timedelta, timezone
+from uuid import NAMESPACE_URL, uuid4, uuid5
@@ -26 +18,11 @@ import httpx
-ROOT = Path(__file__).resolve().parents[2]
+USER = "promem_smoke"
+DOMAIN = "本地验收"
+DECISION = (
+    "决定了：蓝莓构建的验证报告保留 14 天，索引写入 artifacts/blueberry/reports.json。",
+    "收到。蓝莓构建的验证报告保留 14 天，索引写入 artifacts/blueberry/reports.json。",
+)
+EXPERIENCE = (
+    "这次已经验证：蓝莓构建报告的索引写到临时文件，校验成功后再原子重命名。"
+    "直接覆盖索引时进程重启会留下半个 JSON。请把验证过的做法记入项目经验。",
+    "已用中断重启验证，临时文件校验后原子重命名可避免读到不完整的 JSON。",
+)
@@ -29,9 +31,2 @@ ROOT = Path(__file__).resolve().parents[2]
-def load_rounds(scenario: str) -> list[dict]:
-    data = json.loads(
-        (ROOT / "examples/project_memory/mock_rounds.json").read_text(encoding="utf-8")
-    )
-    if scenario == "decision":
-        return data["decision"]
-    if scenario == "experience":
-        return data["experience"]
-    return data["decision"] + data["experience"]
+class SmokeError(Exception):
+    """A product response violated a smoke assertion."""
@@ -40,3 +35,3 @@ def load_rounds(scenario: str) -> list[dict]:
-def check(name: str, cond: bool, detail: str = "") -> bool:
-    print(f"  {'✓' if cond else '✗'} {name}{('：' + detail) if detail and not cond else ''}")
-    return cond
+def require(condition: bool, message: str) -> None:
+    if not condition:
+        raise SmokeError(message)
@@ -45,12 +40,5 @@ def check(name: str, cond: bool, detail: str = "") -> bool:
-def wait_task(c: httpx.Client, user_id: str, task_id: str, timeout: float = 240.0) -> dict:
-    """整理是异步的（调度器里跑），轮询到 completed / failed，或超时。"""
-    deadline = time.time() + timeout
-    st: dict = {}
-    while time.time() < deadline:
-        st = c.get(
-            "/product/scheduler/status", params={"user_id": user_id, "task_id": task_id}
-        ).json()["data"][0]
-        if st["status"] in ("completed", "failed"):
-            return st
-        time.sleep(2)
-    return st
+def response_data(response: httpx.Response) -> dict | list:
+    response.raise_for_status()
+    body = response.json()
+    require(body.get("code") == 200, f"{response.request.url.path} did not succeed: {body}")
+    return body["data"]
@@ -59,5 +47,2 @@ def wait_task(c: httpx.Client, user_id: str, task_id: str, timeout: float = 240.
-def post(c: httpx.Client, path: str, body: dict) -> dict:
-    r = c.post(path, json=body)
-    if r.status_code != 200:
-        raise SystemExit(f"{path} → {r.status_code}: {r.text[:600]}")
-    return r.json()
+def post(client: httpx.Client, path: str, payload: dict) -> dict | list:
+    return response_data(client.post(path, json=payload))
@@ -66,18 +51,43 @@ def post(c: httpx.Client, path: str, body: dict) -> dict:
-def main() -> int:
-    ap = argparse.ArgumentParser()
-    ap.add_argument("--base", default="http://127.0.0.1:8000")
-    ap.add_argument("--scenario", default="all", choices=["all", "decision", "experience"])
-    ap.add_argument("--timeout", type=float, default=180.0, help="单次请求超时（整段整理是同步的）")
-    ap.add_argument("--keep", action="store_true", help="跑完不清空主题")
-    args = ap.parse_args()
-
-    ok = True
-    with httpx.Client(base_url=args.base, timeout=args.timeout) as c:
-        h = c.get("/health")
-        ok &= check("health", h.status_code == 200, h.text[:200])
-        if h.status_code != 200:
-            return 1
-
-        sp = post(
-            c,
-            "/product/create_space",
+def task_status(client: httpx.Client, task_id: str) -> dict:
+    response = client.get("/product/scheduler/status", params={"user_id": USER, "task_id": task_id})
+    return response_data(response)[0]
+
+
+def project_result(status: dict) -> dict:
+    return status["memory_views"]["project"]
+
+
+def wait_closed(client: httpx.Client, task_id: str, timeout: float) -> dict:
+    """Wait for a closed Episode even when an open one reports completed."""
+    deadline = time.monotonic() + timeout
+    while True:
+        state = task_status(client, task_id)
+        require(state["status"] != "failed", f"Project Add failed: {project_result(state)}")
+        if state["status"] == "completed" and project_result(state)["open_episode_messages"] == 0:
+            return state
+        remaining = deadline - time.monotonic()
+        if remaining <= 0:
+            raise SmokeError(f"Task {task_id} did not finish a closed Episode: {state}")
+        time.sleep(min(0.5, remaining))
+
+
+def payload(
+    run_id: str,
+    step: str,
+    texts: tuple[str, str],
+    spaces: list[str],
+    chat_time: datetime,
+    *,
+    conversation_id: str | None = None,
+    sync: bool = False,
+) -> dict:
+    task_id = str(uuid5(NAMESPACE_URL, f"{run_id}/{step}"))
+    return {
+        "task_id": task_id,
+        "user_id": USER,
+        "allow_memory_view": ["project"],
+        "space_ids": spaces,
+        "domains": [DOMAIN],
+        "async_mode": "sync" if sync else "async",
+        **({"conversation_id": conversation_id} if conversation_id else {}),
+        "messages": [
@@ -85,48 +95,57 @@ def main() -> int:
-                "space_name": "MemOS 云服务（冒烟）",
-                "instructions": "术语以 PRD 为准",
-                "domains": [
-                    {"name": "代码开发", "description": "接口与存储实现"},
-                    {"name": "产品设计"},
-                ],
-            },
-        )["data"]
-        sid = sp["space_id"]
-        ok &= check("create_space 返回 space_id", bool(sid), str(sp))
-        ok &= check("领域已建", len(sp["domains"]) == 2)
-
-        rounds = load_rounds(args.scenario)
-        task_ids: list[tuple[str, str]] = []
-        for rnd in rounds:
-            t0 = time.time()
-            data = post(
-                c,
-                "/product/add",
-                {
-                    "user_id": rnd["user_id"],
-                    "conversation_id": rnd["conversation_id"],
-                    "space_ids": sid,
-                    "allow_memory_view": ["project"],
-                    "messages": rnd["messages"],
-                },
-            )["data"][0]
-            task = data["task_id"]
-            task_ids.append((rnd["user_id"], task))
-            # 先把这一轮的 add 整理完，再发会话结束（否则段还没建，flush 找不到它）
-            wait_task(c, rnd["user_id"], task)
-            fl = post(
-                c,
-                "/product/flush_project_memory",
-                {"space_id": sid, "conversation_id": rnd["conversation_id"], "task_id": task},
-            )["data"]
-            st = wait_task(c, rnd["user_id"], task)
-            print(
-                f"■ {rnd['label']}  add={data['status']}  flush={time.time() - t0:.1f}s  "
-                f"status={st['status']}  topics={len(st['memory_views']['project']['memory_ids'])}"
-            )
-            for line in fl.get("trace") or []:
-                print("   " + line)
-            ok &= check(f"{rnd['label']} 整理完成", st["status"] == "completed", str(st))
-            ok &= check(
-                f"{rnd['label']} 归到主题",
-                bool(st["memory_views"]["project"]["memory_ids"]),
-                str(st),
+                "message_id": f"{task_id}:{role}",
+                "role": role,
+                "content": text,
+                "chat_time": (chat_time + timedelta(seconds=order)).isoformat(),
+            }
+            for order, (role, text) in enumerate(zip(("user", "assistant"), texts, strict=True))
+        ],
+    }
+
+
+def add(client: httpx.Client, body: dict) -> dict:
+    row = post(client, "/product/add", body)[0]
+    require(row["memory_view"] == "project", "Add response did not contain project memory")
+    require(row["status"] in {"running", "completed"}, f"Add failed: {row}")
+    return row
+
+
+def assert_open(client: httpx.Client, task_id: str) -> None:
+    state = task_status(client, task_id)
+    require(state["status"] == "completed", f"Open Episode should remain buffered: {state}")
+    count = project_result(state)["open_episode_messages"]
+    require(count == 2, f"One Turn in two Spaces should report two open messages, got {count}")
+
+
+def assert_source(
+    client: httpx.Client, conversation: str, spaces: list[str], turns: list[dict]
+) -> None:
+    original = [message for turn in turns for message in turn["messages"]]
+    expected = [(message["message_id"], message["content"]) for message in original]
+    for scope in [{}, *({"space_id": space} for space in spaces)]:
+        data = post(client, "/product/get_message", {"conversation_id": conversation, **scope})
+        replayed = [(item["message_id"], item["content"]) for item in data["message_detail_list"]]
+        require(replayed == expected, "Original messages were duplicated, omitted or changed")
+
+
+def run_smoke(
+    client: httpx.Client,
+    peer: httpx.Client,
+    *,
+    scenario: str,
+    wait_seconds: float,
+    keep: bool,
+    require_topic: bool,
+) -> None:
+    for endpoint in (client, peer):
+        endpoint.get("/health").raise_for_status()
+    run_id = f"promem-smoke-{uuid4().hex}"
+    conversation = f"{run_id}:conversation"
+    now = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=1)
+    spaces: list[str] = []
+    topic_ids: set[str] = set()
+    try:
+        for index, endpoint in enumerate((client, peer), 1):
+            space = post(
+                endpoint,
+                "/product/create_space",
+                {"space_name": f"{run_id}-{index}", "domains": [{"name": DOMAIN}]},
@@ -133,0 +153 @@ def main() -> int:
+            spaces.append(space["space_id"])
@@ -135,35 +155,12 @@ def main() -> int:
-        got = post(
-            c,
-            "/product/search",
-            {
-                "user_id": "user_x",
-                "query": "本机整理结果怎么存？",
-                "space_ids": [sid],
-                "include_memory_view": ["project"],
-                "memory_limit_number": 3,
-            },
-        )["data"]
-        topics = got.get("topic_detail_list") or []
-        ok &= check(
-            "search/memory 返回主题", bool(topics), json.dumps(got, ensure_ascii=False)[:400]
-        )
-        if topics:
-            t = topics[0]
-            for key in (
-                "id",
-                "space_id",
-                "domain",
-                "topic_name",
-                "topic_summary",
-                "topic_description",
-                "decisions",
-                "experiences",
-                "timeline",
-                "relativity",
-            ):
-                ok &= check(f"主题字段 {key}", key in t)
-            ok &= check("search 不返回 sources", "sources" not in t)
-            for d in t.get("decisions") or []:
-                ok &= check(
-                    "决策带 content/time/user_ids", {"content", "time", "user_ids"} <= set(d)
-                )
+        fixtures = {
+            "decision": [DECISION],
+            "experience": [EXPERIENCE],
+            "all": [DECISION, EXPERIENCE],
+        }
+        for index, texts in enumerate(fixtures[scenario], 1):
+            one_shot = payload(run_id, f"standalone-{index}", texts, spaces, now, sync=True)
+            receipt = add(client, one_shot)
+            require(receipt["task_id"] == one_shot["task_id"], "Standalone Task ID changed")
+            result = wait_closed(peer, receipt["task_id"], wait_seconds)
+            topic_ids.update(project_result(result)["memory_ids"])
+        print("PASS standalone Add closed in both Spaces")
@@ -171,6 +168,13 @@ def main() -> int:
-        full = post(c, "/product/get_memory", {"space_id": sid})["data"]
-        full_topics = full.get("topic_detail_list") or []
-        ok &= check(
-            "get/memory 按 space 返回",
-            full.get("total", 0) >= 1,
-            json.dumps(full, ensure_ascii=False)[:300],
+        first = payload(run_id, "open", DECISION, spaces, now, conversation_id=conversation)
+        task = add(client, first)["task_id"]
+        assert_open(peer, task)
+        replay = {**first, "task_id": str(uuid4())}
+        require(add(peer, replay)["task_id"] == task, "Exact replay returned a new Task ID")
+        assert_source(client, conversation, spaces, [first])
+
+        conflicting = deepcopy(replay)
+        conflicting["messages"][0]["content"] += " 同一个 ID 的正文发生变化。"
+        rejected = peer.post("/product/add", json=conflicting)
+        require(rejected.status_code == 409, f"Conflicting replay returned {rejected.status_code}")
+        foreign = peer.get(
+            "/product/scheduler/status", params={"user_id": "promem_smoke_other", "task_id": task}
@@ -178,23 +182,2 @@ def main() -> int:
-        if full_topics:
-            ft = full_topics[0]
-            ok &= check("get/memory 带来源会话", bool(ft.get("sources")))
-            ok &= check("get/memory 带 create_time", bool(ft.get("create_time")))
-            if ft.get("decisions"):
-                ok &= check("决策带来源", bool(ft["decisions"][0].get("source")))
-            one = c.get(f"/product/get_memory/{ft['id']}").json()["data"]["topic_detail_list"][0]
-            ok &= check("get/memory/{id} 与列表一致", one["id"] == ft["id"])
-
-        msgs = post(c, "/product/get_message", {"conversation_id": rounds[-1]["conversation_id"]})[
-            "data"
-        ]
-        ok &= check("get_message 有消息", bool(msgs.get("message_detail_list")))
-
-        if not args.keep:
-            deleted = post(c, "/product/delete_memory", {"space_id": sid})["data"]
-            ok &= check("delete_memory 清空主题", bool(deleted.get("deleted_topic_ids")))
-            after = post(c, "/product/get_memory", {"space_id": sid})["data"]
-            ok &= check("清空后主题为 0", after.get("total") == 0)
-            ok &= check(
-                "清空后领域还在",
-                bool(post(c, "/product/list_domains", {"space_id": sid})["data"]["domains"]),
-            )
+        require(foreign.status_code == 404, f"Unowned Task returned {foreign.status_code}")
+        print("PASS shared open receipt, source deduplication, replay conflict and owner isolation")
@@ -202,7 +185,29 @@ def main() -> int:
-    print("\n冒烟：" + ("全部通过" if ok else "有不通过项"))
-    if args.keep:
-        body = json.dumps({"space_id": sid})
-        print(f"数据已保留，space_id = {sid}")
-        print(
-            f"查看主题、决策、经验：curl -s -X POST {args.base}/product/get_memory "
-            f"-H 'Content-Type: application/json' -d '{body}' | python3 -m json.tool"
+        end = payload(
+            run_id,
+            "end",
+            ("到此为止。", "收到。"),
+            spaces,
+            now + timedelta(seconds=4),
+            conversation_id=conversation,
+        )
+        ending = add(peer, end)["task_id"]
+        completed = wait_closed(client, task, wait_seconds)
+        topic_ids.update(project_result(completed)["memory_ids"])
+        wait_closed(client, ending, wait_seconds)
+        continued = payload(
+            run_id,
+            "continued",
+            (
+                "补充刚才的决定：蓝莓构建的验证报告改为保留 21 天。索引路径不变。",
+                "收到，验证报告保留 21 天，索引路径保持原样。",
+            ),
+            spaces,
+            now + timedelta(seconds=8),
+            conversation_id=conversation,
+        )
+        new_task = add(client, continued)["task_id"]
+        require(new_task != task, "Continuing the conversation reused the closed Task")
+        assert_open(peer, new_task)
+        require(
+            project_result(task_status(peer, task))["open_episode_messages"] == 0,
+            "Closed Task reopened",
@@ -210 +215,56 @@ def main() -> int:
-    return 0 if ok else 1
+        assert_source(peer, conversation, spaces, [first, end, continued])
+        print("PASS explicit Episode closure and same-conversation continuation")
+
+        if require_topic:
+            for space in spaces:
+                memory = post(peer, "/product/get_memory", {"space_id": space})
+                require(
+                    any(topic["id"] in topic_ids for topic in memory["topic_detail_list"]),
+                    f"No committed Topic for Space {space}; check Formation configuration and model",
+                )
+            print("PASS committed Topics visible in both Spaces")
+    finally:
+        if keep:
+            print(f"Scratch Spaces: {', '.join(spaces)}")
+        else:
+            for space in spaces:
+                try:
+                    post(client, "/product/delete_space", {"space_id": space})
+                except (httpx.HTTPError, SmokeError, ValueError) as exc:
+                    print(f"Could not clean scratch Space {space}: {exc}", file=sys.stderr)
+
+
+def main() -> int:
+    parser = argparse.ArgumentParser(description=__doc__)
+    parser.add_argument("--base", default="http://127.0.0.1:8000")
+    parser.add_argument("--peer", help="second API endpoint sharing PostgreSQL and Redis")
+    parser.add_argument("--scenario", default="all", choices=["all", "decision", "experience"])
+    parser.add_argument("--timeout", type=float, default=180, help="HTTP request timeout (seconds)")
+    parser.add_argument("--wait", type=float, default=240, help="closed Episode timeout (seconds)")
+    parser.add_argument("--keep", action="store_true", help="retain the scratch Spaces")
+    parser.add_argument(
+        "--require-topic", action="store_true", help="also require both Topics to commit"
+    )
+    args = parser.parse_args()
+    headers = (
+        {"Authorization": f"Bearer {token}"} if (token := os.getenv("MEMOS_SMOKE_TOKEN")) else {}
+    )
+    try:
+        with (
+            httpx.Client(base_url=args.base, timeout=args.timeout, headers=headers) as client,
+            httpx.Client(
+                base_url=args.peer or args.base, timeout=args.timeout, headers=headers
+            ) as peer,
+        ):
+            run_smoke(
+                client,
+                peer,
+                scenario=args.scenario,
+                wait_seconds=args.wait,
+                keep=args.keep,
+                require_topic=args.require_topic,
+            )
+    except (httpx.HTTPError, KeyError, SmokeError, ValueError) as exc:
+        print(f"FAIL project-memory smoke: {exc}", file=sys.stderr)
+        return 1
+    return 0
````
