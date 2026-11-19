# MemOS 项目记忆读取与检索

## 读取接口

下表为算法服务接口，对应评审版第 5 节。算法服务成功时返回 `code=200`。云端工程网关负责成员鉴权、空间归属检查、外部 ID 映射和工程错误码转换。

| 评审章节 | 接口 | 用法 |
| --- | --- | --- |
| 5.1 | `POST /product/search` | 必传 `query`、`user_id`。在 `include_memory_view` 显式选择 `project` 或 `trajectory`，并传 `space_ids`。主题计一条，平铺时每个组件计一条，各通道共用 `memory_limit_number`。 |
| 5.2 | `POST /product/get_memory` | `space_id` 取一个空间，返回 `space_id`、`total` 和 `topic_detail_list`。按 `update_time` 倒序，相同时间按 ID 排序。`page` 从 1 开始，`page_size` 和 `size` 都可传。算法层省略大小时返回全部，工程层负责补默认分页。 |
| 5.3 | `GET /product/get_memory/{memory_id}` | 在调用方可读范围内直接查 ID。主题放进 `topic_detail_list`；决策、经验和进展放进 `project_item_list`，每次仅一项。未命中项目 ID 时继续走原有个人记忆查询。网关按所属空间复核后向客户端返回单个对象。 |
| 5.4 | `POST /product/get_message` | 开源部署按 `conversation_id` 读整理时保存的原始消息。`space_id` 可选。跨可读空间按角色、消息时间、正文和工具参数去重，按时间排序后取最后 `message_limit_number` 条，省略则取全部。工程网关已有自己的会话表。 |

以下请求可查一个空间里与 SQLite 有关的决策和经验。

```json
{"query":"SQLite","user_id":"member-b","space_ids":["space-a"],"include_memory_view":["project"],"project_result_format":"item","project_item_types":["decision","experience"],"memory_limit_number":5,"relativity":0.45}
```

`project_result_format` 默认为 `topic`。平铺时返回 `project_item_list`，`project_item_types` 可选 `topic`、`decision`、`experience`、`timeline`。查询范围最多 20 个空间；`domains` 中的每个领域都必须已在每个指定空间登记。算法层的上限为 25，省略条数或传 0 都取 9。`conversation_id` 和 `session_id` 均可表示当前会话，来源会话匹配时主题相关度增加 0.1，最高为 1。

检索只带相关条目。决策保留负责人、显示名、历史和分歧；经验带任务意图、验证状态、可信度和生命周期。读取详情时另带决策出处和改写依据，经验另带卡片、版本及证据。进展和决策历史按实际时间由早到晚排列。列表支持 `filter.related_id` 按来源成员或 Agent 筛选，`filter.create_time` 和 `filter.update_time` 支持 `eq/gt/gte/lt/lte`。

## 共享原文和缓存

`include_memory_view=["trajectory"]` 查询已获准共享的原文。每轮按段落优先切成最多 2,000 字的片段，同轮只返回一个命中片段。按轮次 ID 可以回读当前完整可见内容。截断和撤回会同时更新原文及索引，其他空间的共享副本各自处理。

原有 Memmy 缓存接口可显式传 `space_id` 和 `view=metadata|content`。元数据包含 `cache_policy`。主题和有版本的条目使用 `live`。原文首次发布时，只有写入方确认不可变、无业务版本且整段可见，才标记 `immutable`；同 ID 后续有变更即按 `live` 处理。云端保存共享原文，本机按权限复核固定正文，无需同步整库。

## 上游依赖和部署

- 写入方在同一数据库事务调用 `replace_snapshot(cursor, tenant_id, space_id, root_id, revision, accepted_at, snapshot)`。`Topic` 带稳定条目 ID、出处和来源成员。`Turn` 只带该空间允许共享的内容。撤回传 `None` 和更新的修订号。旧写入和旧向量任务按修订号丢弃。
- 向量任务调用 `set_embedding(cursor, tenant_id, space_id, root_id, revision, memory_id, part, vector)`。关键词与向量共用一个查询范围。每次检索只计算一次查询向量，索引缺失、超时或模型不匹配时返回 `degraded`。`query_index` 可按主题、条目或轨迹读取候选和原始分数。
- 第 5.4 节从写入模块提供的 `components["project_message_store"].list_messages(space_id, conversation_id)` 读取角色、时间、正文与工具调用信息。可接参考分支的同名方法。这个数据源与共享轨迹分开；服务缺少消息源时返回 HTTP 500。
- 启用检索时设置 `MEMOS_PROJECT_MEMORY_DSN`，安装 `psycopg2-binary` 和 PostgreSQL 的 pgvector 扩展。空间服务先提供 `memos_project.pm_spaces` 和 `pm_domains`，再对项目库执行 `psql -v ON_ERROR_STOP=1 -1 -f src/memos/project_memory/schema.sql`。该 SQL 管理本分支的检索索引，跨模块 DB 接口待负责人确认。
- 多租户网关在验证成员身份后设置 `request.state.project_access = ProjectAccess(tenant_id, readable_space_ids)`。单租户服务可设置 `MEMOS_PROJECT_MEMORY_TENANT_ID` 和 `MEMOS_PROJECT_MEMORY_GATEWAY_KEY`，由可信网关提交服务凭证。在隔离内网部署算法端时，可显式设置 `MEMOS_PROJECT_MEMORY_INTERNAL=1` 和固定租户，接收网关转来的无鉴权头请求。

## 评审待确认项

| 位置 | 待确认事项 | 当前处理 |
| --- | --- | --- |
| 1.5、5.1、5.3 | 字段表划掉了 `item_type`，平铺和按 ID 的样例仍包含它。 | 支持按组件类型查询，返回已确定的组件字段。类型判别字段留待统一。 |
| 5.2 | 是否单设决策列表，是否增加 `topic_id`、`filter.type` 和关联关系。 | 已有组件检索和按 ID 回读。新增列表协议留待确认。 |
| 1.1、1.4、5.2 | 算法表和完整样例要求全部条目及出处，工程表另写了 5 条和省略历史。 | 算法侧按完整主题返回，工程列表的摘要规则待定。 |
| 0.4、7 | 工程成员 ID 的转换方式、网关新增错误码编号、最终 DB 接口。 | 算法透传写入方的成员 ID，返回稳定 `reason`，联调用例模拟空间、写入和原始消息依赖。 |

## 验证

在仓库开发环境安装 `psycopg2-binary`。可安装 `pgserver` 由测试启动独立 PostgreSQL，也可用 `MEMOS_TEST_PROJECT_DSN` 指向允许创建临时数据库、已安装 pgvector 的测试实例。

```bash
python -m pytest tests/project_memory tests/api tests/test_cli.py -q
python -m pytest tests/project_memory/test_postgres.py -k latency -s -q
```

性能用例写入 1,000 个主题、1,000 轮共享原文和 384 维向量。原文查询和三路混合查询各预热一次，再统计 50 次 HTTP 请求的 P95。SQL、向量检索、混排和响应序列化均实际执行；查询向量和个人记忆结果使用测试数据。
