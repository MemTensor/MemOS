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

## Add 耗时与 token 计量

`/product/add` 异步返回只代表已受理。Episode 仍在积攒 Turn 时，任务状态也会是 `completed`，所以 Add 是否处理完以 `GET /product/scheduler/status` 里的 `memory_views.project.metrics` 为准。

| 字段 | 含义 |
| --- | --- |
| `accepted_at` / `closed_at` / `completed_at` | 受理时间，含本次 Turn 的所有 Episode 都关段的时间，以及这些 Episode 都处理完的时间。任一 Episode 未关段或未完成时，后两项为 `null`。 |
| `close_wait_ms` / `processing_ms` / `latency_ms` | 受理到关段、关段到完成、受理到完成。积攒等待由 Episode 策略决定，与后台处理分开统计。 |
| `episodes[]` | 每个 Episode 的 `buffer_ms`（开段到关段）、`queue_ms`（投递到领取）、`run_ms`（阶段执行）、`retry_wait_ms`（重试退避与等锁）和 `other_ms`（关段后的其余间隔）。`stages[]` 逐次列出领取的阶段、次数、下一阶段和错误。 |
| `usage` | 本次 Add 分摊到的模型用量，按 `kind`（`chat` / `embedding`）和模型列出调用数、失败数、无 usage 的调用数，以及 prompt、completion、缓存和推理 token。 |

计量规则：

- 每个阶段运行时，OpenAI 兼容聊天适配器和 `universal_api` embedding 适配器记录供应商返回的 `usage`。阶段结束后，运行时把运行时长和用量写入 `add_episode_events` 的 `stage_done` 事件。领取、投递、关段和完成事件与对应的状态变化在同一事务中写入。
- 一个 Episode 可能合并多次 Add 的 Turn，用量按各 Add 的 Turn 输入字符数分摊（`attribution: turn_characters`）。各计数按最大余数取整，各 Add 份额之和等于 Episode 总量。一次 Add 写入多个 Space 时，各 Space 的 Episode 用量相加。
- `usage.complete` 为 `false` 表示账单还不完整，包括这几种情况：处理未完成；有调用未返回 usage（例如不上报的本地模型）；有调用失败（供应商可能已计费但没有返回数量）；某个阶段领取后 worker 中断，没有写入结束事件。
- Formation 会顺带重判其他暂存 Episode，这部分用量计入触发它的 Episode。embedding 缓存命中不调用供应商，不计用量。除 `universal_api` 外的 embedding 后端不上报用量。
- 受理和提交事件使用数据库时钟，投递和阶段事件使用 worker 时钟。各分量最小取 0，避免两边时钟偏差产生负值。

冒烟脚本以 `metrics.completed_at` 判断完成，每次 Add 完成后打印一行 `METRIC`。加 `--metrics-out metrics.jsonl` 会把完整指标逐行写出。已有部署首次启动新版本时，会创建 Add 自有表 `add_episode_events`。

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

### 导入历史项目记忆

停止旧写入，排空已受理的旧任务并备份源库。为旧 Space 准备一份 JSON 对照表，键为旧 Space ID，值为可信项目 ID。先在隔离的目标 schema 验证报告。

```bash
python -m memos.project_memory.add_legacy_migrate \
  --legacy-sqlite /path/to/backup.sqlite \
  --mapping /path/to/spaces.json --project-id local-project
```

PostgreSQL 源库使用 `--legacy-postgres-env LEGACY_DATABASE_DSN --source-schema project_memory`。运行前通过环境变量配置目标库和隔离 schema。确认预检后，在同一命令追加 `--apply --archive /path/to/history.json`。服务通过 `PROJECT_MEMORY_LEGACY_ARCHIVE=/path/to/history.json` 加载对应项目的只读历史。归档包含会话内容和回执，仅保存在具备访问控制的本机路径。

对账报告包含迁入对象、归档例外与源数据摘要。保留旧库备份用于回查。清空新 Space 后，它的历史例外也受清空围栏约束。
