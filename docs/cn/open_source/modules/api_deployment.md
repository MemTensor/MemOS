# MemOS API

## 默认入口与部署方式

- **公开开源使用**时，请使用 **`server_api.py`** 作为 API 服务的入口。
- 您可以通过 **`docker/Dockerfile`** 进行部署。

以上是运行和部署 API 的默认通用方式。

## 扩展功能与参考实现

- **`server_api_ext.py`** 和 **`Dockerfile.krolik`** 是某位开发者扩展后的 API 及部署配置，**仅供参考**。这些内容尚未与云服务集成，仍处于测试阶段。
- 如需扩展或自定义行为，可参考上述文件，按需使用或改造。

## 项目记忆读写

服务通过 `PROJECT_DB_BACKEND=postgres` 和 `PROJECT_DB_HOST`、`PROJECT_DB_PORT`、`PROJECT_DB_NAME`、`PROJECT_DB_USER`、`PROJECT_DB_PASSWORD` 连接 PostgreSQL。项目插件随这组配置启用。写入和检索共用这个数据库，整理任务提交主题和决策时会在同一事务中更新检索索引。

项目写入沿用现有的 `PROJECT_MEMORY_PROJECT_ID`，其值应与空间所属项目一致。部署时需要启用 Redis 调度队列及项目整理任务，并配置抽取模型和向量模型。数据库需安装 pgvector，默认中文分词还需要 zhparser。

在已有空间调用 `POST /product/add`，传入 `user_id`、`space_ids`、`allow_memory_view=["project"]` 和 `messages`。用返回的 `task_id` 查询 `GET /product/scheduler/status`。整理出主题后，用同一空间调用 `POST /product/search`。查决策可传 `include_memory_view=["project"]`、`project_result_format="item"`、`project_item_types=["decision"]` 和原问题。结果里的记忆 ID 可用于 `GET /product/get_memory/{id}?space_id=...`。
