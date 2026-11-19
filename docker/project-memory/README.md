# 项目记忆 Add 本地部署

部署包含 MemOS、项目记忆 PostgreSQL（pgvector）、Redis Streams、Neo4j 社区版和 Qdrant。PostgreSQL 保存原文、Turn 归属、Episode 状态与 Topic。Redis 负责 Add 阶段调度。Neo4j 和 Qdrant 服务于原有记忆视图。Compose 将本机访问端口绑定到 `127.0.0.1`。

## 启动

从仓库根目录运行。准备一份含模型设置的本地配置，`make_env.py` 会按模板生成 `.env`。项目记忆和调度使用 Compose 中的专用服务。

```bash
python3 docker/project-memory/make_env.py --env-file ../env_example

docker build -f docker/Dockerfile -t memos-base:promem .
docker build -f docker/project-memory/Dockerfile -t memos-promem:local .
docker compose -f docker/project-memory/docker-compose.yml up -d --wait
```

本地部署镜像使用 `pip install -e /app --no-deps` 注册 `project_memory` 入口，应用入口为 `memos.api.server_api:app`。单实例也可用 `bash docker/project-memory/start.sh`，它会构建镜像、等待 `/health` 并运行冒烟脚本。`--no-smoke` 只启动服务，`--rebuild` 重建底座镜像。

双实例通过 `replica` profile 启动。两个 API 共享 PostgreSQL、Redis 连接和项目 ID。

```bash
docker compose --profile replica -f docker/project-memory/docker-compose.yml up -d --wait
python3 docker/project-memory/smoke.py \
  --base http://127.0.0.1:8000 --peer http://127.0.0.1:8001
```

单实例冒烟可省略 `--peer`。脚本使用自带的合成轮次和请求内稳定的消息 ID，检查同一次 Add 写两个 Space、去重后的原文和开放消息计数、重复请求与冲突、归属校验、明确边界关段及同会话续写。每次运行创建独立的临时 Space，默认通过 API 删除，`--keep` 可保留供检查。`--scenario decision` 或 `--scenario experience` 可指定独立批次的样例类型。

若要在少量样例中验证 Topic 正式提交，可在专用测试环境的 `.env` 设置 `PROJECT_MEMORY_FORMATION_COUNT=1` 并重新启动，随后冒烟时加 `--require-topic`。默认 Formation 在条件满足前允许返回暂存的成功回执。

## 配置与数据

| 用途 | 关键配置与默认值 |
| --- | --- |
| 本地项目身份 | `PROJECT_MEMORY_PROJECT_ID=local-project`。两个实例使用相同值。 |
| 项目数据库 | `PROJECT_MEMORY_GRAPH_DB=postgres`，`PROJECT_MEMORY_POSTGRES_SCHEMA=project_memory`。数据库通过 `127.0.0.1:5433` 从本机访问。 |
| Redis Streams | `MEMSCHEDULER_USE_REDIS_QUEUE=true`。`REDIS_*` 和 `MEMSCHEDULER_REDIS_*` 都指向 `redis:6379`。可通过 `docker compose -f docker/project-memory/docker-compose.yml exec redis redis-cli` 从容器内查看。 |
| 模型 | `PROJECT_MEMORY_LLM_*`、`PROJECT_MEMORY_JUDGE_LLM_*` 和 `PROJECT_MEMORY_EMBEDDER_*`。 |
| Episode | 空闲 900 秒，首轮最长等待 1800 秒，最多 8 轮，体量阈值按 12000 token 估算。 |
| Formation | 默认新增暂存段达到 10 条或达到 7200 秒阈值时检查。 |

本机端口可通过 `MEMOS_LOCAL_HTTP_PORT`、`MEMOS_LOCAL_PEER_HTTP_PORT`、`MEMOS_LOCAL_POSTGRES_PORT`、`MEMOS_LOCAL_NEO4J_HTTP_PORT`、`MEMOS_LOCAL_NEO4J_BOLT_PORT`、`MEMOS_LOCAL_QDRANT_PORT` 配置。若要同时运行两套部署，为第二套指定独立的 Compose 项目名、`MEMOS_LOCAL_CONTAINER_PREFIX` 和本机端口。使用其他环境配置文件时，将 `MEMOS_LOCAL_ENV_FILE` 设为绝对路径，并把同一路径传给 `docker compose --env-file`。

保留旧版项目记忆数据时，请按迁移流程指定旧库、项目映射与归档位置。直接启动新版会使用新的关系表。停止服务保留 PostgreSQL 和 Redis 等命名卷。

```bash
docker compose --profile replica -f docker/project-memory/docker-compose.yml ps
docker compose --profile replica -f docker/project-memory/docker-compose.yml logs -f memos memos-peer
docker compose --profile replica -f docker/project-memory/docker-compose.yml down
```
