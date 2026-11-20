# MemOS API

## 默认入口与部署方式

- **公开开源使用**时，请使用 **`server_api.py`** 作为 API 服务的入口。
- 您可以通过 **`docker/Dockerfile`** 进行部署。

以上是运行和部署 API 的默认通用方式。

## 扩展功能与参考实现

- **`server_api_ext.py`** 和 **`Dockerfile.krolik`** 是某位开发者扩展后的 API 及部署配置，**仅供参考**。这些内容尚未与云服务集成，仍处于测试阶段。
- 如需扩展或自定义行为，可参考上述文件，按需使用或改造。

## 项目记忆接口联调

未配置项目数据库连接 `MEMOS_PROJECT_MEMORY_DSN` 时，MemOS 启动后默认提供联调空间 `mock-space`。不同测试者可以用自己的 `user_id` 检索同一组内置样例，无需建空间、准备数据或设置环境变量。部署后，把下面的地址换成联调服务的 IP 和端口即可。

```bash
MEMOS_URL=http://127.0.0.1:9801
curl -sS "$MEMOS_URL/product/search" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"tester","space_ids":["mock-space"],"include_memory_view":["project"],"project_result_format":"item","project_item_types":["decision"],"query":"项目采用什么数据库？"}'

curl -sS "$MEMOS_URL/product/get_memory/mock-decision"
```

第一条响应的 `data.project_item_list` 里应有 `mock-decision`，第二条能用这个 ID 读到相同的决策内容。任意非空查询都使用同一组样例，适合核对请求参数和返回字段。其他读接口也可以直接测试。

| 接口 | 请求示例 |
| --- | --- |
| `POST /product/get_memory` | `{"space_id":"mock-space","page":1,"page_size":10}` |
| `GET /product/get_memory/mock-experience` | 按 ID 读经验 |
| `POST /product/get_message` | `{"conversation_id":"mock-session","space_id":"mock-space"}` |

接入项目数据库后，设置 `MEMOS_PROJECT_MEMORY_DSN` 并重启，默认使用真实数据。需要临时切回样例时可设置 `MEMOS_PROJECT_MEMORY_MOCK=1`。设置为 `0` 可关闭样例，此时项目检索需要数据库连接。
