---
title: MemOS NEO 版本
desc: 通过 `MOS.simple()` 在几分钟内快速使用 MemOS——构建记忆增强应用最快捷的方式。
---

## 快速开始

### 环境变量

设置你的 API 凭证：

```bash
export OPENAI_API_KEY="sk-your-api-key-here"
export OPENAI_API_BASE="https://api.openai.com/v1"  # Optional
export MOS_TEXT_MEM_TYPE="general_text"  #or "tree_text" for advanced

#tips: general_text only support one-user when init MOS
```

### 一行代码启动

```python
from memos.mem_os.main import MOS

# Auto-configured instance
memory = MOS.simple()
```
::note
**注意：**<br>`MOS.simple()` 会使用默认的 embedding 模型 text-embedding-3-large（维度 3027）。如果你之前使用过其他版本的 MemOS，需要先删除目录 `~/.memos` 以创建新的 qdrant，或删除 neo4j 数据库。
::

## 基础用法

```python
#!/usr/bin/env python3
import os
from memos.mem_os.main import MOS

# Set environment variables
os.environ["OPENAI_API_KEY"] = "sk-your-api-key"
os.environ["MOS_TEXT_MEM_TYPE"] = "general_text"

# Create memory system
memory = MOS.simple()

# Add memories
memory.add("My favorite color is blue")
memory.add("I work as a software engineer")
memory.add("I live in San Francisco")

# Chat with memory context
response = memory.chat("What is user favorite color?")
print(response)  # "favorite color is blue!"

response = memory.chat("Tell me about user job and location")
print(response)  # Uses stored memories to respond
```

## 记忆类型

### General Text Memory（推荐新手使用）
- **存储**：本地 JSON 文件 + Qdrant 向量数据库
- **依赖**：无需外部依赖
- **适用场景**：大多数使用场景与快速原型开发

```bash
export MOS_TEXT_MEM_TYPE="general_text"
```

### Tree Text Memory（高级）
- **存储**：Neo4j 图数据库
- **依赖**：需要 Neo4j 服务
- **适用场景**：复杂的关系推理

```bash
export MOS_TEXT_MEM_TYPE="tree_text"
export NEO4J_URI="bolt://localhost:7687"  # Optional
export NEO4J_PASSWORD="your-password"     # Optional
```

## Neo 版本概览

`MOS.simple()` 会基于合理的默认值自动创建完整配置：

### 默认设置
- **LLM**：GPT-4o-mini，temperature 为 0.8
- **Embedder**：OpenAI text-embedding-3-large
- **Chunking**：512 tokens，overlap 128
- **Graph-DB**：使用 neo4j 作为图数据库

### 默认配置工具

MemOS 在 `default_config.py` 中提供了三个主要的配置工具：

- **`get_default_config()`**：基于合理默认值创建完整的 MOS 配置
- **`get_default_cube_config()`**：为记忆存储创建 MemCube 配置
- **`get_default()`**：同时返回 MOS 配置与 MemCube 实例

```python
from memos.mem_os.utils.default_config import get_default, get_default_cube_config

# Get both MOS config and MemCube instance
mos_config, default_cube = get_default(
    openai_api_key="sk-your-key",
    text_mem_type="general_text"
)

# Or create just MemCube config
cube_config = get_default_cube_config(
    openai_api_key="sk-your-key",
    text_mem_type="general_text"
)
```

### 手动配置（可选）

如果你需要更精细的控制，可以使用配置工具：

```python
from memos.mem_os.main import MOS
from memos.mem_os.utils.default_config import get_default_config

# Custom configuration
config = get_default_config(
    openai_api_key="sk-your-key",
    text_mem_type="general_text",
    user_id="my_user",
    model_name="gpt-4",           # Different model
    temperature=0.5,              # Lower creativity
    chunk_size=256,               # Smaller chunks
    top_k=10                      # More search results
)

memory = MOS(config)
```

### 高级功能

启用额外能力：

```python
config = get_default_config(
    openai_api_key="sk-your-key",
    enable_activation_memory=True,    # KV-cache memory
    enable_mem_scheduler=True,        # Background processing
)
```


## 其他建议

1. **从简单开始**：先使用 `general_text` 记忆类型
2. **环境配置**：将 API key 存放在环境变量中
3. **记忆质量**：添加具体、事实性的信息可获得最佳效果
4. **批量操作**：一次性添加多条相关记忆
5. **用户上下文**：仅 `tree_text` 模式下，多用户场景需使用 `user_id` 参数

## 故障排查

### 常见问题

**缺少 API Key 错误**：
```bash
# Ensure environment variable is set
echo $OPENAI_API_KEY
```

**Neo4j 连接错误**（tree_text 模式）：
```bash
# Check Neo4j is running desktop for local user or enterprise neo4j
```
