# MemOS HTTP mock

## 启动

在插件目录执行 `npm run mock`。默认监听 `http://127.0.0.1:8711`，API 基址为 `http://127.0.0.1:8711/api/openmem/v1`，测试 Key 为 `mock-key`。现有环境变量 `MEMOS_MOCK_PORT`、`MEMOS_MOCK_KEY` 可以改变端口和 Key。

使用独立的插件测试数据目录配置此基址和 Key。Mock 必须在 Agent 测试期间保持运行；服务未启动时请求会连接失败。

## 行为

七个接口均使用 POST JSON、`Authorization: Token <key>`，返回 `{code,message,data}`。

| 路径（相对 API 基址） | 行为 |
|---|---|
| `/create/space` | 根据 `space_name` 创建随机测试空间，返回 `space_id` |
| `/get/space` | 根据 `space_id` 返回已存在的空间信息 |
| `/list/domains` | 返回已创建空间登记的领域，供绑定校验 |
| `/get/memory` | 为已存在的空间返回一条“Mock 项目概览占位信息。”主题，保留分页字段 |
| `/add/message` | 校验全部目标空间后，按 Space 追加完整请求原文，返回 `success:true`、`task_id`、`status:running` |
| `/get/status` | 根据 `task_id` 返回 `completed`，`memory_ids` 使用该任务标识 |
| `/search/memory` | 根据 `space_ids` 返回该空间接收的上传正文；没有上传记录时返回空列表 |

上传原文只保存在 `uploads` 字典中，结构为 `Map<spaceId, {taskId, body}[]>`。同一 Space 连续上传时追加，不覆盖已有记录；一次上传到多个 Space 时分别保存。任一目标空间不存在时整次上传失败，不产生部分写入。

搜索结果位于 `data.topic_detail_list`，每条记录的 `id` 复用上传 `task_id`，`topic_description` 为 `JSON.stringify(body.messages)`。完整输入、回答、工具参数和结果原样保留，不摘要、不截断；请求的其他字段保留在字典的 `body` 中，不混入模型检索正文。同一上传命中多个 Space 时按任务 ID 去重。

搜索要求 `query` 非空，但不做关键词、向量或语义匹配，也不返回预置业务主题。`get/memory` 的占位概览独立于上传内容，不能用它判断上传是否成功。

## 完整验证示例

Mock 启动时没有任何空间。先调用 `create/space` 并登记领域（插件绑定要求空间具有领域），将返回的 `data.space_id` 替换到后续命令的 `SPACE_ID`：

```bash
curl -sS http://127.0.0.1:8711/api/openmem/v1/create/space \
  -H 'Authorization: Token mock-key' -H 'Content-Type: application/json' \
  -d '{"space_name":"临时测试项目","domains":[{"domain":"编程"}]}'

curl -sS http://127.0.0.1:8711/api/openmem/v1/get/memory \
  -H 'Authorization: Token mock-key' -H 'Content-Type: application/json' \
  -d '{"space_id":"SPACE_ID","page":1,"size":10}'

curl -sS http://127.0.0.1:8711/api/openmem/v1/add/message \
  -H 'Authorization: Token mock-key' -H 'Content-Type: application/json' \
  -d '{"user_id":"mock_user","agent_id":"test-agent","space_ids":["SPACE_ID"],"messages":[{"role":"user","content":"测试1"},{"role":"assistant","content":"收到，测试1。"}],"allow_memory_view":["project"],"async_mode":true}'

curl -sS http://127.0.0.1:8711/api/openmem/v1/search/memory \
  -H 'Authorization: Token mock-key' -H 'Content-Type: application/json' \
  -d '{"user_id":"mock_user","query":"测试1","space_ids":["SPACE_ID"],"include_memory_view":["project"]}'
```

最后一次响应的 `topic_description` 应包含上一次上传的完整 `messages` 数组。可以使用上传响应的 `data.task_id` 调用 `get/status` 确认任务完成。

## 空空间启动和重启

命令行和程序化入口默认均为空，不加载固定 Space 或旧恢复快照。`create/space` 会生成唯一 Space ID，将名称、时间和传入的领域实际存入 Mock 的 `spaces` Map，随后可通过 `get/space`、`list/domains` 校验并在 Viewer 绑定。

空间、上传原文和任务全部仅存在当前 Mock 进程内存，重启后清空，不提供跨进程持久化。插件 SQLite 中的旧绑定不会随之清除，因此重启后应重新创建并绑定；创建、绑定、上传、检索应在同一 Mock 进程内验证。

## 测试中使用

```ts
import { createMockServer, getMockState } from './server.ts';
const server = createMockServer({ apiKey: 'test-key' });
server.listen(0, '127.0.0.1');
// 等待 listening 后，通过 server.address() 获取隔离端口。
// getMockState(server).uploads.get(spaceId)：该 Space 的上传记录列表。
// 每条记录的 body 为完整 add/message 请求，taskId 为对应任务。
// getMockState(server).requests：接口路径、方法及请求体，不记录鉴权头。
```

程序化创建服务默认没有空间；使用 `create/space` 创建空间，或通过 `spaces` 选项显式提供隔离测试数据。Mock 仅用于验证接口链路和原文回放，真实服务兼容性和记忆效果需另外验证。
