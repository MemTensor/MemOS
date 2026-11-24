# 云服务访问配置

插件从服务配置读取接口类型和 API 基址。Viewer 保存设置时只提交用户修改的 Key 和历史上传确认条数。

| 接口类型 | 基址示例 | 默认鉴权 | 云服务项目 ID |
|---|---|---|---|
| 算法接口 | `http://<host>:<port>/product` | Token | 默认 `test1`，用于创建与写入的 `project_id` |
| 工程接口 | `https://<host>/api/openmem/v1` | Token | 不发送 |

Viewer 使用 API Key 鉴权。设置栏用等长星号显示已保存的 Key；输入新值可替换，点击「清除」后保存可删除。配置读取接口只返回 Key 的长度与配置状态。

地址填写到接口前缀，不包含 `create_space` 等操作路径，不接受内嵌凭据、查询参数或片段。源码不包含私人部署地址；当前连接只由本地配置决定。

## 配置算法接口

Viewer 当前只提供 API Key 和历史上传确认条数。使用算法接口时，先从服务启动输出取得本地 Viewer 地址，再通过本地 API 一次性设置接口类型、服务地址。当前接口要求的云项目 ID 默认是 `test1`；如部署使用其他项目，可通过 `cloudProjectId` 显式覆盖。以下地址占位值需要替换：

```sh
curl --request PUT 'http://127.0.0.1:<本地服务端口>/api/config' \
  --header 'Content-Type: application/json' \
  --data '{"apiMode":"algorithm","baseUrl":"https://<你的服务地址>/product","authMode":"token","cloudProjectId":"test1"}'
```

之后在 Viewer 设置中保存 API Key。`GET /api/config` 的 `connectionConfigured` 和 `connectionError` 可检查配置是否齐全；配置齐全并不代表已完成真实业务连通验证。修改连接会停止原连接的采集和发送，原绑定与回执仍保留，具体规则见下文。切换协议不会覆盖已有项目 ID；未配置项目 ID 时使用当前接口要求的 `test1`。

## 七个操作

业务服务继续使用统一的工程语义操作，由 `src/cloud/protocol.ts` 选择协议并映射。

| 统一操作 | 算法接口 | 工程接口 |
|---|---|---|
| create/space | POST create_space | POST create/space |
| get/space | POST get_space | POST get/space |
| list/domains | POST list_domains | POST list/domains |
| add/message | POST add | POST add/message |
| get/status | GET scheduler/status | POST get/status |
| search/memory | POST search | POST search/memory |
| get/memory | POST get_memory | POST get/memory |

算法创建时领域对象 `domains[].domain` 转为 `domains[].name`；读取领域做相反转换。上传/检索的领域名称字符串、主题的 `domain` 不改名。算法上传/检索使用 `session_id`，消息 `id` 转 `message_id`，异步参数转为 `async`/`sync`，概览 `size` 转 `page_size`。算法状态查询在 query 携带原投递的 `user_id` 和 `task_id`。

工程成功业务码为 0；算法为 200。算法上传按 `memory_view=project` 选择唯一结果，任务查询按任务 ID 匹配；不会取数组第一项兜底，也不自动切换协议或重复请求。两种协议均保留开放消息数和已提交主题 ID。

## 连接与回执

连接归属由接口类型、规范化基址、算法云项目 ID 组成。切换连接停止旧连接的采集与发送；切回开启新的采集窗口，不自动补采切换间隔。已有本地绑定、轨迹和回执仍可查看，不自动搬迁空间或重放旧任务。同一 Agent＋项目有绑定时不能跨连接追加；明确全部解绑后可在新连接绑定，旧批次仍保持原连接身份。

旧配置缺少协议字段时按工程接口＋Token 升级。算法项目 ID 缺失或空值在加载时补齐 `test1`；切换接口类型不会覆盖已有项目 ID，包括旧配置中已明确保存的值。旧数据库升级前备份，旧任务标记为工程连接，保留消息与成功回执。每次请求使用固定配置快照；响应在连接切换后也记录到原投递。

`completed` 只表示当前无整理任务。`open_episode_messages>0` 展示消息积累中并继续查询；缺字段展示整理状态待确认；明确为 0 才结束成功任务的跟踪。已接收与已整理分开，后续状态查询不重传消息。

参数/权限等明确失败不立即重试，写入超时、网络断开或无有效回执保留为结果未确认，停止自动重发。限流等待后续同步周期，在原次数上限内重试。

## 只读测试连接

`POST /api/connection-test` 使用已保存的连接配置，支持可选 `{ "spaceId": "已有空间ID" }`。有 ID 时读取空间以验证协议与鉴权；无 ID 时只探测基址的 HTTP 响应，并明确未完成业务验证。404 不是业务验证成功；不使用创建空间、上传消息或虚构健康检查接口测试。
