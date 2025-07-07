# MemOS API 模块

## 概述

MemOS API 模块提供了 RESTful API 接口，用于管理 MemOS 系统的用户、内存和聊天功能。经过重构后，代码结构更加清晰和模块化。

## 目录结构

```
src/memos/api/
├── __init__.py
├── config.py              # 配置管理
├── exceptions.py          # 异常处理
├── product_models.py      # Product API 数据模型
├── product_api.py         # Product API 主应用
├── start_api.py           # Start API 主应用
└── routers/               # 路由模块
    ├── __init__.py
    └── product_router.py  # Product API 路由
```

## 重构改进

### 1. 模块化设计
- **配置管理**: 统一的配置管理模块 (`config.py`)
- **异常处理**: 集中的异常处理 (`exceptions.py`)
- **数据模型**: 分离的请求/响应模型 (`product_models.py`)
- **路由分离**: 按功能分离的路由模块 (`routers/`)

### 2. 代码复用
- 消除了重复的配置代码
- 统一的异常处理机制
- 共享的基础模型类

### 3. 维护性提升
- 单一职责原则：每个文件都有明确的职责
- 易于测试：模块化的结构便于单元测试
- 易于扩展：新增功能只需添加相应的路由和模型

## API 接口

### Product API (`/product`)

#### 用户管理
- `POST /product/users/register` - 注册新用户
- `GET /product/users` - 获取所有用户列表
- `GET /product/users/{user_id}` - 获取用户信息
- `GET /product/users/{user_id}/config` - 获取用户配置
- `PUT /product/users/{user_id}/config` - 更新用户配置

#### 内存管理
- `POST /product/add` - 创建新内存
- `POST /product/memories/get_all` - 获取所有内存
- `POST /product/search` - 搜索内存

#### 聊天功能
- `POST /product/chat` - 与 MemOS 聊天（SSE流式响应）
- `GET /product/suggestions/{user_id}` - 获取建议查询

#### 配置管理
- `POST /product/configure` - 设置配置
- `GET /product/configure/{user_id}` - 获取配置

#### 系统状态
- `GET /product/instances/status` - 获取用户实例状态
- `GET /product/instances/count` - 获取活跃用户数量

## 启动方式

### 1. 启动 Product API
```bash
cd src/memos/api
python product_api.py
```
服务将在 `http://localhost:8001` 启动

### 2. 启动 Start API
```bash
cd src/memos/api
python start_api.py
```
服务将在 `http://localhost:8000` 启动

## 配置说明

API 配置通过环境变量管理：

```bash
# OpenAI 配置
export OPENAI_API_KEY="your-api-key"
export OPENAI_API_BASE="https://api.openai.com/v1"
export MOS_CHAT_MODEL="gpt-4o-mini"
export MOS_CHAT_TEMPERATURE="0.8"

# Neo4j 配置
export NEO4J_URI="bolt://localhost:7687"
export NEO4J_USER="neo4j"
export NEO4J_PASSWORD="password"

# 其他配置
export MOS_USER_ID="root"
export MOS_TOP_K="5"
export MOS_MAX_TURNS_WINDOW="20"
```

## 使用示例

### 注册用户
```bash
curl -X POST "http://localhost:8001/product/users/register" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "caroline",
    "user_name": null,
    "interests": "I love machine learning and AI"
  }'
```

**响应示例:**
```json
{
  "code": 200,
  "message": "User registered successfully",
  "data": {
    "user_id": "alice",
    "mem_cube_id": "alice_default_cube"
  }
}
```

### 获取所有用户列表
```bash
curl -X GET "http://localhost:8001/product/users"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Users retrieved successfully",
  "data": [
    {
      "user_id": "caroline",
      "user_name": None,
      "role": "user",
      "created_at": "2024-01-01T00:00:00",
      "is_active": true
    }
  ]
}
```

### 获取用户信息
```bash
curl -X GET "http://localhost:8001/product/users/alice"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "User info retrieved successfully",
  "data": {
    "user_id": "alice",
    "user_name": "Alice",
    "role": "user",
    "created_at": "2024-01-01T00:00:00",
    "accessible_cubes": [
      {
        "cube_id": "alice_default_cube",
        "cube_name": "alice_default_cube",
        "cube_path": "/tmp/data/alice_default_cube",
        "owner_id": "alice",
        "is_loaded": true
      }
    ]
  }
}
```

### 获取建议查询
```bash
curl -X GET "http://localhost:8001/product/suggestions/alice"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Suggestions retrieved successfully",
  "data": {
    "query": [
      "What are my interests?",
      "Tell me about my recent activities",
      "What should I focus on today?"
    ]
  }
}
```

### 创建内存
```bash
curl -X POST "http://localhost:8001/product/add" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "caroline",
    "memory_content": "I attended a machine learning conference today",
    "mem_cube_id": "b0aade07-0a41-4e63-94f1-398c2aab66fb"
  }'
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Memory created successfully",
  "data": null
}
```

### 获取所有内存
```bash
curl -X POST "http://localhost:8001/product/get_all" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "caroline",
    "memory_type": "text_mem",
    "mem_cube_ids": ["b0aade07-0a41-4e63-94f1-398c2aab66fb"]
  }'
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Memories retrieved successfully",
  "data": [
    {
      "cube_id": "alice_default_cube",
      "memories": [
        {
          "memory": "I love machine learning and AI",
          "metadata": {
            "user_id": "alice",
            "session_id": "session_123",
            "source": "conversation"
          }
        }
      ]
    }
  ]
}
```

### 搜索内存
```bash
curl -X POST "http://localhost:8001/product/search" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "caroline",
    "query": "machine learning",
    "mem_cube_id": "b0aade07-0a41-4e63-94f1-398c2aab66fb"
  }'
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Search completed successfully",
  "data": {
    "text_mem": [
      {
        "cube_id": "alice_default_cube",
        "memories": [
          {
            "memory": "I love machine learning and AI",
            "metadata": {
              "user_id": "alice",
              "session_id": "session_123",
              "source": "conversation"
            }
          }
        ]
      }
    ],
    "act_mem": [],
    "para_mem": []
  }
}
```

### 聊天（SSE流式响应）
```bash
curl -X POST "http://localhost:8001/product/chat" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "caroline",
    "query": "我过往的memory都有哪些",
    "mem_cube_id": "b990b3cc-767f-4d53-98e6-d52e6d974f7f"
  }' \
  --no-buffer
```

**注意**: Chat接口返回SSE（Server-Sent Events）流式数据，格式如下：
```
data: {"type": "metadata", "content": ["memory1", "memory2"]}

data: {"type": "text", "content": "Hello"}

data: {"type": "text", "content": " how"}

data: {"type": "text", "content": " are"}

data: {"type": "text", "content": " you?"}

data: {"type": "reference", "content": [{"id": "1234"}]}

data: {"type": "end"}
```

### 设置配置
```bash
curl -X POST "http://localhost:8001/product/configure" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "root",
    "session_id": "session_123",
    "chat_model": {
      "backend": "openai",
      "model": "gpt-4o-mini",
      "temperature": 0.8
    },
    "top_k": 5,
    "enable_textual_memory": true,
    "enable_activation_memory": false
  }'
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Configuration set successfully",
  "data": null
}
```

### 获取配置
```bash
curl -X GET "http://localhost:8001/product/configure/alice"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Configuration retrieved successfully",
  "data": {
    "user_id": "alice",
    "session_id": "session_123",
    "chat_model": {
      "backend": "openai",
      "model": "gpt-4o-mini",
      "temperature": 0.8
    },
    "top_k": 5,
    "enable_textual_memory": true,
    "enable_activation_memory": false
  }
}
```

### 获取用户配置
```bash
curl -X GET "http://localhost:8001/product/users/alice/config"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "User configuration retrieved successfully",
  "data": {
    "user_id": "alice",
    "session_id": "session_123",
    "chat_model": {
      "backend": "openai",
      "model": "gpt-4o-mini",
      "temperature": 0.8
    },
    "top_k": 5,
    "enable_textual_memory": true,
    "enable_activation_memory": false
  }
}
```

### 更新用户配置
```bash
curl -X PUT "http://localhost:8001/product/users/alice/config" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "alice",
    "session_id": "session_123",
    "chat_model": {
      "backend": "openai",
      "model": "gpt-4o-mini",
      "temperature": 0.9
    },
    "top_k": 10,
    "enable_textual_memory": true,
    "enable_activation_memory": false
  }'
```

**响应示例:**
```json
{
  "code": 200,
  "message": "User configuration updated successfully",
  "data": null
}
```

### 获取用户实例状态
```bash
curl -X GET "http://localhost:8001/product/instances/status"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Instance status retrieved successfully",
  "data": {
    "active_instances": 2,
    "max_instances": 100,
    "user_ids": ["alice", "bob"],
    "lru_order": ["alice", "bob"]
  }
}
```

### 获取活跃用户数量
```bash
curl -X GET "http://localhost:8001/product/instances/count"
```

**响应示例:**
```json
{
  "code": 200,
  "message": "Active user count retrieved successfully",
  "data": 2
}
```

### JavaScript 客户端示例
```javascript
const response = await fetch('/product/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    user_id: 'alice',
    query: 'What are my interests?',
    cube_id: 'alice_default_cube'
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      
      switch (data.type) {
        case 'metadata':
          console.log('Retrieved memories:', data.content);
          break;
        case 'text':
          console.log('Text chunk:', data.content);
          break;
        case 'reference':
          console.log('References:', data.content);
          break;
        case 'end':
          console.log('Chat completed');
          break;
        case 'error':
          console.error('Error:', data.content);
          break;
      }
    }
  }
}
```

## 开发指南

### 添加新接口
1. 在 `product_models.py` 中添加请求/响应模型
2. 在 `routers/product_router.py` 中添加路由处理函数
3. 更新文档

### 修改配置
1. 在 `config.py` 中修改相应的配置方法
2. 更新环境变量或配置文件

### 异常处理
1. 在 `exceptions.py` 中添加新的异常处理逻辑
2. 在路由中使用适当的异常处理

## 注意事项

1. **用户注册**: 必须先注册用户才能使用其他功能
2. **内存管理**: 每个用户都有自己的内存立方体
3. **聊天功能**: 聊天接口返回SSE流式响应，需要特殊处理
4. **配置管理**: 配置更改会影响所有后续操作
5. **流式响应**: Chat接口使用SSE格式，客户端需要正确处理流式数据
6. **用户实例管理**: 系统使用LRU策略管理用户实例，最多保持100个活跃实例
7. **错误处理**: 所有接口都包含适当的错误处理和状态码 