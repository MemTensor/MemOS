---
title: "openGauss 图存储"
desc: "介绍 MemOS 的 openGauss 图存储后端配置、Dashboard 查询范围、资源所有权、备份恢复及 Feedback 支持范围。"
---

设置 `GRAPH_DB_BACKEND=opengauss`，并配置 `OPENGAUSS_HOST`、`OPENGAUSS_USER`、`OPENGAUSS_PASSWORD` 和 `OPENGAUSS_DB`。安装时需启用 `tree-mem` 可选依赖组。目标数据库必须预先具备所需的 AGE 和 DataVec/BM25 能力；适配器不会创建物理数据库。

可选配置包括：`OPENGAUSS_PORT`（默认 5432）、`OPENGAUSS_MIN_CONN`（默认 1）、`OPENGAUSS_MAX_CONN`（默认 20）、`OPENGAUSS_CONNECT_TIMEOUT`（默认 10 秒）、`OPENGAUSS_CONNECTION_WAIT_TIMEOUT`（默认 30 秒）和 `EMBEDDING_DIMENSION`（默认 1024）。请求中显式指定的 Cube ID 优先于配置中的默认范围。范围选择只用于查询过滤，不代表授予访问权限。

## Dashboard 查询范围

`POST /product/get_memory_dashboard` 接受两个可选且允许为 null 的字段。已有客户端可以继续省略这两个字段。

| 字段 | 含义 |
| --- | --- |
| `all_cubes: null` 或省略 | 查询传入的 `mem_cube_id`；未传入时查询配置中的默认 Cube。下文的旧版过滤控制字段仍可显式选择其他范围。 |
| `all_cubes: true` | 查询所有 Cube。不能同时传入外层 `mem_cube_id`，也不能与 `public` 单 Cube 选择同时使用。 |
| `all_cubes: false` | 查询指定 Cube；未指定时查询配置中的默认 Cube。 |
| `exclude_cube_id` | 从显式选择的全 Cube 范围中排除一个 Cube。仅传入此字段不会启用全 Cube 查询。值必须为非空白字符串；指定的 Cube 不存在时，不排除任何记录。 |

例如，分页查询除 `public` 以外的所有范围：

```json
{
  "all_cubes": true,
  "exclude_cube_id": "public",
  "page": 1,
  "page_size": 20
}
```

旧版过滤控制 `{"object_type":"public","mem_cube_id":"P"}` 表示选择 P，`{"object_type":"user","mem_cube_id":"P"}` 表示显式选择除 P 以外的所有 Cube。这些控制字段可以出现在过滤器根节点或 `and` 下，并对整个查询生效。`or` 下任何位置的范围控制字段都会被拒绝，因为将其提取出来会改变布尔表达式的含义；普通业务 `or` 过滤条件仍然保留。

允许重复传入相同的控制条件。外层 `mem_cube_id` 必须与 `public` 选择一致，不能与 `user` 选择同时使用。不完整或冲突的控制条件、未知的对象类型、空布尔节点、单 Cube 查询中的排除操作，以及冲突的排除 ID，都会返回参数错误。显式传入 `all_cubes=false` 与 `user` 选择也会产生冲突。

`user_id`、记忆类型、状态和业务过滤条件仍会进一步约束所选范围。分页时必须同时提供正数 `page` 和 `page_size`；同时省略这两个字段则返回所有匹配记录。四类记忆分别计算分页结果和总数。每个 Cube 分组的 `total_nodes` 表示当前页的记录数，`statistics` 表示分页前所有匹配记录的数量。

当当前页没有记录时，所有后端都会返回空的分类列表，即使显式指定了 Cube，也不会构造一个空 Cube 分组。当前页为空时，总数仍可能大于零。确实没有匹配记录时，响应结构如下：

```json
{
  "code": 200,
  "message": "Memories retrieved successfully",
  "data": {
    "text_mem": [], "tool_mem": [], "skill_mem": [], "pref_mem": [],
    "statistics": {
      "total_text_nodes": 0, "total_tool_nodes": 0,
      "total_skill_nodes": 0, "total_preference_nodes": 0
    }
  }
}
```

目前只有 openGauss 接受新增范围字段的非 null 值。对于其他适配器，省略字段或传入 null 时沿用原有范围规则，显式传入新的范围选择则会被拒绝。`all_cubes` 只接受 JSON 布尔值，不接受 `0`、`1` 或字符串。Java 客户端接入这些字段时，应使用可空的 `Boolean`/`String`，不要用基本类型布尔值默认的 `false` 代替“未指定”。

请求模型的类型或结构错误返回 HTTP 422，非法的范围或过滤条件组合返回 400，存储执行失败返回 500。错误响应包含 `data: null`；调用方不能将其视为查询成功但没有结果。普通 `/get_memory` 请求仍要求传入 `mem_cube_id`，不支持这两个新增范围字段。

## 资源所有权与当前支持范围

直接创建的 `TreeTextMemory` 和 `GeneralMemCube` 实例通过 `close()` 关闭自身拥有的资源。注入的图存储和记忆对象仍属于借用资源。API 会等待 Scheduler 完成对共享图的使用后再关闭图；独立初始化的 Scheduler 则关闭自身拥有的图。`Scheduler.stop()` 用于停止工作，`close()` 用于结束生命周期。最终关闭会拒绝新任务和懒初始化，等待正在执行的任务及恢复过程结束，报告清理失败，并允许重试尚未完成的清理。成功关闭后，重复调用不会再次执行清理。

为兼容已有实现，没有显式 `close` 方法的图适配器会被跳过；这不代表其资源已经释放。这些变更不提供完整的 Scheduler 重启支持。Tree 的组合 `drop` 流程、非默认 Feedback TFIDF 分支、实际 Java 集成、完整服务 HTTP E2E 和生产规模性能仍需单独验证。

`TreeTextMemory.dump` 导出一个 Cube 中所有状态的记忆，默认不包含向量；传入 `include_embedding=True` 可获得完整的逻辑备份。对于 openGauss Tree 记忆，`GeneralMemCube.dump` 会自动请求包含向量。只有写入、刷新、同步和关闭文件全部成功后，才会通过同目录原子替换发布文件。导出或写入失败时，原文件保持不变。该保证只覆盖单个记忆文件，不覆盖整个 Cube 目录。

显式执行加载时，文件缺失、不可读或 JSON 无效都会抛出 `memos.exceptions.MemoryError`。数据库异常保留其原始原因。恢复操作会原子地合并到同一个 Cube 中，保留备份文件中未出现的节点和边。导入不含嵌入向量的节点会清除该节点已有的向量。

搜索结果保留原始 Cube 身份，包括不同 Cube 中 ID 相同的记忆。并行 Cube 搜索按请求顺序合并结果，继续沿用已有 no/sim/MMR 选择和评分规则。必需的存储和输入错误会通过关键词搜索、API 处理器和调度 Feedback 向上传播；这些错误与查询成功但没有匹配结果不同。

默认 Feedback（`DB_IDX_READY=False`）支持通过 SQL LIKE 进行关键词替换。`search_by_keywords_like` 使用调用方传入的原始模式：`%` 匹配任意长度的字符序列，`_` 匹配单个字符，反斜杠用于转义这些字符。模式通过参数绑定传入，默认查询 activated 状态的记忆，应用已有 Cube/KB 范围和过滤条件，并按 Cube/ID 顺序返回全部匹配结果。空模式只匹配空文本；非法类型、NUL 和末尾未配对的转义字符会被拒绝。默认返回字段包含 `id`；跨 Cube 查询还包含 `user_name`。显式指定的字段可以包含 memory、embedding 和 metadata 字段。

Feedback 保留已有版本行为：关闭版本控制时，工作记忆原地更新，长期记忆先创建新节点，再归档旧节点。这些多次写入不属于同一个事务。存储错误会被报告，Feedback 包装层不会重试这类错误，因为连接失败可能导致某次写入是否已提交无法确定。此前已经成功的更新可能仍然保留。TFIDF 分支（`DB_IDX_READY=True`）仍不受支持。
