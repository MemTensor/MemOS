---
title: MemOS MCP集成指南
description: 在Coze等平台配置MemOS的MCP服务，实现智能体与记忆系统的无缝集成
---

本指南将帮助您在Coze空间等平台中配置MemOS的MCP服务，实现智能体与记忆系统的无缝集成。

## 选择MCP部署方式

MemOS提供两种MCP部署方式，您可以根据实际需求选择：

### 使用MemOS云服务（推荐）

如果您希望快速接入，无需自己部署服务器，推荐使用MemOS官方云服务。

**优势：**
- ✅ 开箱即用，无需部署
- ✅ 高可用性保障
- ✅ 自动扩展和维护
- ✅ 支持多种客户端（Claude、Cursor、Cline等）

**配置方式：**

请访问 [MemOS云服务MCP配置指南](https://memos-docs.openmem.net/cn/mcp_agent/mcp/guide) 获取详细的配置说明。

主要步骤：
1. 在 [MemOS API控制台](https://memos-dashboard.openmem.net/cn/apikeys/) 注册账号并获取API Key
2. 在MCP客户端中配置 `@memtensor/memos-api-mcp` 服务
3. 设置环境变量（`MEMOS_API_KEY`、`MEMOS_USER_ID`、`MEMOS_CHANNEL`）

### 自己部署MCP服务

如果您需要私有化部署或定制化需求，可以在自己的服务器上部署MCP服务。

**优势：**
- ✅ 数据完全私有化
- ✅ 可定制化配置
- ✅ 完全掌控服务
- ✅ 适合企业内部使用

**前置要求：**
- Python 3.9+
- Neo4j数据库（或其他支持的图数据库）
- HTTPS域名（用于Coze等平台）

继续阅读下方内容了解详细部署步骤。

---

## 自部署MCP服务配置

以下内容适用于需要自己部署MCP服务的用户。

## 架构说明

自部署MCP服务采用以下架构：

```
客户端(Coze/Claude等)
    ↓ [HTTPS]
MCP服务器(8002端口)
    ↓ [HTTP调用]
Server API(8001端口)
    ↓
MemOS核心服务
```

**组件说明：**
- **Server API**: 提供REST API接口（`/product/*`），处理记忆的增删改查
- **MCP服务器**: 通过HTTP传输暴露MCP协议，调用Server API完成操作
- **HTTPS反向代理**: Coze等平台要求使用HTTPS安全连接

::steps{level="3"}

### 步骤1: 启动Server API

Server API是MCP服务的后端，提供实际的记忆管理功能。

```bash
cd /path/to/MemOS
python src/memos/api/server_api.py --port 8001
```

验证Server API是否正常运行：

```bash
curl http://localhost:8001/docs
```

如果返回API文档页面，说明启动成功。

::note
**配置文件**<br>
Server API会自动加载配置，确保Neo4j等依赖服务已正确配置。可参考 `examples/data/config/tree_config_shared_database.json` 配置示例。
::

### 步骤2: 启动MCP HTTP服务

在另一个终端启动MCP服务：

```bash
cd /path/to/MemOS
python examples/mem_mcp/simple_fastmcp_serve.py --transport http --port 8002
```

MCP服务启动后会显示类似以下信息：

```
╭──────────────────────────────────────────────────╮
│       MemOS MCP via Server API                   │
│       Transport:   HTTP                          │
│       Server URL:  http://localhost:8002/mcp     │
╰──────────────────────────────────────────────────╯
```

**环境变量配置（可选）：**

可以通过`.env`文件或环境变量配置Server API地址：

```bash
export MEMOS_API_BASE_URL="http://localhost:8001/product"
```

::note
**工具列表**<br>
MCP服务提供以下工具：
- `add_memory`: 添加记忆
- `search_memories`: 搜索记忆
- `chat`: 与记忆系统对话

完整工具列表参考 `examples/mem_mcp/simple_fastmcp_serve.py`
::

### 步骤3: 配置HTTPS反向代理

Coze等平台要求使用HTTPS连接。您需要配置HTTPS反向代理（如Nginx）将流量转发到MCP服务。

**Nginx配置示例：**

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /mcp {
        proxy_pass http://localhost:8002/mcp;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE支持
        proxy_buffering off;
        proxy_cache off;
    }
}
```

::warning
**HTTPS证书**<br>
确保使用有效的SSL证书，自签名证书可能无法被Coze等平台接受。可使用Let's Encrypt免费获取证书。
::

### 步骤4: 测试MCP服务

使用客户端测试脚本验证服务：

```bash
cd /path/to/MemOS
python examples/mem_mcp/simple_fastmcp_client.py
```

成功输出示例：

```
Working FastMCP Client
========================================
Connected to MCP server

  1. Adding memory...
    Result: Memory added successfully

  2. Searching memories...
    Result: [搜索结果]

  3. Chatting...
    Result: [AI响应]

✓ All tests completed!
```

::

## 在Coze空间配置MCP

服务部署完成后，在Coze空间中配置MCP连接。

::steps{level="3"}

### 步骤1: 打开Coze空间并进入工具配置页面

![Coze空间配置页面](https://statics.memtensor.com.cn/memos/coze_space_1.png)

### 步骤2: 添加自定义MCP工具

在工具配置页面中添加自定义工具：

![添加自定义工具](https://statics.memtensor.com.cn/memos/coze_space_2.png)

### 步骤3: 配置MCP连接地址

配置MCP连接URL，使用您配置的HTTPS地址：

```
https://your-domain.com/mcp
```
可用的MCP工具：
- **add_memory**: 添加新记忆
- **search_memories**: 搜索已有记忆
- **chat**: 基于记忆的对话

::note
**测试连接**<br>
配置完成后，在Coze中测试MCP连接是否正常。确保能够成功调用各个工具。
::

::

---

## 直接使用REST API（高级）

对于需要更灵活集成的场景，可以直接使用Server API的REST接口。

::steps{level="3"}

### 步骤1: 启动Server API

```bash
cd /path/to/MemOS
python src/memos/api/server_api.py --port 8001
```
**端口说明**
- Server API默认运行在8001端口
- 提供 `/product/*` REST API端点

### 步骤2: 在Coze IDE配置自定义工具

1. 在Coze中选择"IDE插件"创建方式
2. 配置请求到您部署的Server API服务

![Coze IDE插件配置](https://statics.memtensor.com.cn/memos/coze_tools_1.png)

### 步骤3: 实现add_memory工具

![配置add_memory操作](https://statics.memtensor.com.cn/memos/coze_tools_2.png)

**代码示例：** IDE中配置`add_memory`操作并发布：

![配置add_memory操作](https://statics.memtensor.com.cn/memos/coze_tools_2.png)
详细代码如下

```python
import json
import requests
from runtime import Args
from typings.add_memory.add_memory import Input, Output

def handler(args: Args[Input])->Output:
    memory_content = args.input.memory_content
    user_id = args.input.user_id
    cube_id = args.input.cube_id

    # 调用Server API的add接口
    url = "https://your-domain.com:8001/product/add"
    payload = json.dumps({
        "user_id": user_id,
        "messages": memory_content,  # 支持字符串或消息数组
        "writable_cube_ids": [cube_id] if cube_id else None
    })
    headers = {
        'Content-Type': 'application/json'
    }

    response = requests.post(url, headers=headers, data=payload, timeout=30)
    response.raise_for_status()

    return response.json()
```

**其他工具实现：**

类似地实现search和chat工具：

```python
# Search工具
def search_handler(args: Args[Input]) -> Output:
    url = "https://your-domain.com:8001/product/search"
    payload = json.dumps{
        "user_id": args.input.user_id,
        "query": args.input.query,
    })
    headers = {
        'Content-Type': 'application/json'
    }

    response = requests.post(url, headers=headers, data=payload, timeout=30)
    response.raise_for_status()

    return response.json()

# Chat工具
def chat_handler(args: Args[Input]) -> Output:
    url = "https://your-domain.com:8001/product/chat/complete"
    payload = json.dumps({
        "user_id": args.input.user_id,
        "query": args.input.query
    })
    response = requests.post(url, json=payload, timeout=30)
    return response.json()
```

### 步骤4: 发布并测试工具

发布完成后，可以在"我的资源"中查看插件：

![发布后的插件资源](https://statics.memtensor.com.cn/memos/coze_tools_3.png)

### 步骤5: 集成到智能体工作流

将插件添加到智能体工作流中：

1. 创建新的智能体或编辑现有智能体
2. 在工具列表中添加已发布的MemOS插件
3. 配置工作流，调用记忆工具
4. 测试记忆存储和检索功能

::

---

## 常见问题

### Q1: MCP服务无法连接到Server API

**解决方案：**
- 检查Server API是否正常运行：`curl http://localhost:8001/docs`
- 检查环境变量`MEMOS_API_BASE_URL`配置是否正确
- 查看MCP服务日志，确认调用地址

### Q2: Coze无法连接到MCP服务

**解决方案：**
- 确保使用HTTPS连接
- 检查SSL证书是否有效
- 测试反向代理配置：`curl https://your-domain.com/mcp`
- 检查防火墙和安全组设置

### Q3: Neo4j连接失败

**解决方案：**
- 确保Neo4j服务正常运行
- 检查配置文件中的连接信息（uri、user、password）
- 参考 `examples/data/config/tree_config_shared_database.json` 配置示例

### Q4: 如何查看完整的API示例？

**参考文件：**
- MCP服务端: `examples/mem_mcp/simple_fastmcp_serve.py`
- MCP客户端: `examples/mem_mcp/simple_fastmcp_client.py`
- API测试: `examples/api/server_router_api.py`

---

## 总结

通过本指南，您可以：
- ✅ 选择适合的MCP部署方式（云服务或自部署）
- ✅ 完成MCP服务的完整部署流程
- ✅ 在Coze等平台中集成MemOS记忆功能
- ✅ 使用REST API直接集成

无论选择哪种方式，MemOS都能为您的智能体提供强大的记忆管理ders=headers, data=payload)
    return json.loads(response.text)

::note
**API参数说明**
- 使用Server API的标准参数格式
- `messages`: 替代原来的 `memory_content`，支持字符串或消息数组
- `writable_cube_ids`: 替代原来的 `mem_cube_id`，支持多个cube
- Server API运行在8001端口，路径为 `/product/add`
- 确保与MemOS Server API接口一致，可参考 `examples/api/server_router_api.py` 中的示例
**IDE配置**<br>在IDE中可以自定义工具的参数、返回值格式等，确保与MemOS API接口一致。 采用此方法完成 search 接口以及用户注册接口的编写，并点点击发布
::

### 发布并使用插件

发布完成后，可以在"我的资源"中查看插件，以插件形式融入智能体工作流：

![发布后的插件资源](https://statics.memtensor.com.cn/memos/coze_tools_3.png)

### 构建智能体并测试

构建最简易智能体后，即可进行记忆操作测试：

1. 创建新的智能体
2. 添加已发布的记忆插件
3. 配置工作流
4. 测试记忆存储和检索功能

通过以上配置，您就可以在Coze空间中成功集成MemOS的记忆功能，为您的智能体提供强大的记忆能力。
