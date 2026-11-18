# MemOS HTTP mock

## 启动

在插件目录执行：

```bash
cd /Users/niu/code/Memos/yjn_dev/MemOS_devtest/apps/memos-project-memory-plugin
npm run mock
```

默认监听 `http://127.0.0.1:8711`，API 基址为 `http://127.0.0.1:8711/api/openmem/v1`，测试 Key 为 `mock-key`。通过 `MEMOS_MOCK_PORT`、`MEMOS_MOCK_KEY` 改变测试配置。

在插件的独立测试数据目录内配置此基址和 Key，不要复用正式空间绑定及数据目录。

## 固定测试空间

`npm run mock` 每次启动都会加载以下空间，无需先调用 `create/space`。Space ID、主题 ID 和预置内容固定，重启后可继续使用同一 ID。

| Space ID | 项目 | 预置主题 | 示例 query |
|---|---|---|---|
| `mock_space_project_memory` | Mock 项目记忆插件 | 空间绑定、轨迹上传 | 项目如何绑定空间，什么时候上传轨迹？ |
| `mock_space_order_service` | Mock 订单服务 | 订单幂等、库存一致性 | 如何防止重复下单和库存超卖？ |
| `mock_space_docs_site` | Mock 文档站点 | 文档路由、发布检查 | 文档路由有什么约定，发布前检查什么？ |

每个空间有两个主题，每个主题含 `topic_summary`、`topic_description`、一条 `decisions` 和一条 `experiences`。这些均为虚构的 Mock 示例，不代表真实项目事实。

预置数据来自 `fixtures.ts`，每次启动重新生成独立副本。运行期间创建的随机空间、上传记录和任务状态只存在内存，重启后清空；不会自动持久化用户上传内容。

## 接口

六个接口均使用 POST JSON、`Authorization: Token <key>`，返回 `{code,message,data}`：

| 路径（相对 API 基址） | 用途 |
|---|---|
| `/create/space` | 创建额外的随机测试空间 |
| `/get/space` | 查询空间信息 |
| `/add/message` | 接收并完整保留上传请求 |
| `/get/status` | 查询上传任务状态 |
| `/get/memory` | 分页读取空间主题 |
| `/search/memory` | 返回指定空间的预置主题 |

## 调用示例

以下命令使用默认端口和 Key，可直接执行。

### 查询固定空间

```bash
curl -sS http://127.0.0.1:8711/api/openmem/v1/get/space \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"space_id":"mock_space_project_memory"}'
```

预期 `code: 0`，`data.space_id` 为 `mock_space_project_memory`，`data.space_name` 为 `Mock 项目记忆插件`。

### 检索三个项目

```bash
# 返回“空间绑定”和“轨迹上传”两个主题
curl -sS http://127.0.0.1:8711/api/openmem/v1/search/memory \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"mock_user","query":"项目如何绑定空间，什么时候上传轨迹？","space_ids":["mock_space_project_memory"],"include_memory_view":["project"]}'

# 返回“订单幂等”和“库存一致性”两个主题
curl -sS http://127.0.0.1:8711/api/openmem/v1/search/memory \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"mock_user","query":"如何防止重复下单和库存超卖？","space_ids":["mock_space_order_service"],"include_memory_view":["project"]}'

# 返回“文档路由”和“发布检查”两个主题
curl -sS http://127.0.0.1:8711/api/openmem/v1/search/memory \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"mock_user","query":"文档路由有什么约定，发布前检查什么？","space_ids":["mock_space_docs_site"],"include_memory_view":["project"]}'
```

结果位于 `data.topic_detail_list`，每项包含 `id`、`space_id`、`domain`、`topic_name`、`topic_summary`、`topic_description`、`decisions`、`experiences`、`timeline`、`update_time` 和 `relativity`。例如订单空间的“订单幂等”决策为：

> 创建订单要求传入 Idempotency-Key，相同键与相同请求返回原订单。

**检索只做空间隔离，不做关键词或语义匹配。** `query` 必须非空，但不同 query 在同一空间会返回相同的两个主题；`relativity` 固定为 `1`。`space_ids` 接受一个或多个已存在的空间，一次请求合并这些空间的主题并按主题 ID 去重；任一空间不存在时整次请求失败。上传同样接受完整列表，并生成一个覆盖所有目标的任务。

### 分页读取记忆

```bash
curl -sS http://127.0.0.1:8711/api/openmem/v1/get/memory \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"space_id":"mock_space_docs_site","page":1,"size":1}'
```

预期 `data.total: 2`、`data.pages: 2`，本页返回一个主题；将 `page` 改为 `2` 可读取另一个。

### 上传消息并查询状态

```bash
curl -sS http://127.0.0.1:8711/api/openmem/v1/add/message \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"mock_user","agent_id":"test-agent","space_ids":["mock_space_order_service"],"messages":[{"role":"user","content":"检查订单幂等逻辑"},{"role":"assistant","content":"已检查：重复请求复用原订单。"}],"allow_memory_view":["project"],"async_mode":true}'
```

将下面的 `TASK_ID` 替换为上传响应中的 `data.task_id`：

```bash
curl -sS http://127.0.0.1:8711/api/openmem/v1/get/status \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"TASK_ID"}'
```

上传响应为 `success: true`、`status: running`，状态查询直接返回 `completed`。上传不会生成或改变预置记忆，不执行记忆抽取。

### 创建额外空间

```bash
curl -sS http://127.0.0.1:8711/api/openmem/v1/create/space \
  -H 'Authorization: Token mock-key' \
  -H 'Content-Type: application/json' \
  -d '{"space_name":"临时测试项目"}'
```

返回随机 `mock_space_<UUID>`，默认带一个“Mock 接口验证”主题。该额外空间重启后消失。

## 测试内使用

程序化创建服务默认保持空空间，便于现有测试隔离。显式传 `presetProjects: true` 加载上述三个项目，命令行入口已开启此选项：

```ts
import { createMockServer, getMockState } from './server.ts';
const server = createMockServer({ apiKey: 'test-key', presetProjects: true });
server.listen(0, '127.0.0.1');
// 待 listening 后访问 server.address() 获取端口。
// getMockState(server).uploads：完整上传请求。
// getMockState(server).requests：接口路径、方法及请求体；不记录鉴权头。
```

需要空记忆场景时使用 `createMockServer({ seedTopics: false })`，再调用 `create/space`；该空间不会生成主题。`seedTopics` 只控制新建空间，不清除显式开启的预置项目。

`spaces` / `topics` 选项仍支持自定义测试数据。Mock 仅验证插件 HTTP 链路；真实接口兼容和记忆效果需另行联调。
