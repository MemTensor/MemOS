---
title: MemOS NEO Version
desc: 使用 `MOS.simple()` 在几分钟内快速上手 MemOS —— 构建具备记忆增强能力的应用程序的最快方式。
---

## 快速设置

### 环境变量

设置您的 API 凭据：

```bash
export OPENAI_API_KEY="sk-your-api-key-here"
export OPENAI_API_BASE="https://api.openai.com/v1"  # Optional
export MOS_TEXT_MEM_TYPE="general_text"  #or "tree_text" for advanced

#tips: general_text only support one-user when init MOS
```

### 一行代码完成设置

```python
from memos.mem_os.main import MOS

# Auto-configured instance
memory = MOS.simple()
```
::note
**警告：**<br>`MOS.simple()` 将使用默认的嵌入模型，维度为 text-embedding-3-large（dim-size 3027）。如果您之前使用过其他版本的 memos，需要删除 `~/.memos` 目录以重置 qdrant，或清空 neo4j 数据库。
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

### 通用文本记忆（推荐新手使用）
- **存储方式**：本地 JSON 文件 + Qdrant 向量数据库
- **初始配置**：无需外部依赖
- **适用场景**：大多数用例、快速原型开发

```bash
export MOS_TEXT_MEM_TYPE="general_text"
```

### 树形文本记忆（进阶）
- **存储方式**：Neo4j 图数据库
- **初始配置**：需要 Neo4j 服务器
- **适用场景**：复杂关系推理

```bash
export MOS_TEXT_MEM_TYPE="tree_text"
export NEO4J_URI="bolt://localhost:7687"  # Optional
export NEO4J_PASSWORD="your-password"     # Optional
```

## Neo 版本概述

`MOS.simple()` 会自动使用合理的默认值创建完整配置：

### 默认设置
- **LLM**：GPT-4o-mini，temperature 为 0.8
- **嵌入器**：OpenAI text-embedding-3-large
- **分块策略**：512 个 token，重叠 128 个
- **图数据库**：Neo4j 图数据库

### 默认配置工具

MemOS 在 `default_config.py` 中提供了三个主要配置工具：

- **`get_default_config()`**：使用合理默认值创建完整的 MOS 配置
- **`get_default_cube_config()`**：创建用于记忆存储的 MemCube 配置
- **`get_default()`**：同时返回 MOS 配置和 MemCube 实例

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

如需更精细的控制，可使用配置工具：

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

启用附加能力：

```python
config = get_default_config(
    openai_api_key="sk-your-key",
    enable_activation_memory=True,    # KV-cache memory
    enable_mem_scheduler=True,        # Background processing
)
```


## 其他使用建议

1. **从简开始**：初始时使用 `general_text` 记忆类型
2. **环境配置**：将 API 密钥存储在环境变量中
3. **记忆质量**：添加具体、事实性的信息以获得最佳效果
4. **批量操作**：将多条相关记忆一起添加
5. **用户上下文**：多用户场景下仅在使用 `tree_text` 时使用 `user_id` 参数

## 故障排查

### 常见问题

**缺少 API 密钥错误**：
```bash
# Ensure environment variable is set
echo $OPENAI_API_KEY
```

**Neo4j 连接错误**（tree_text 模式）：
```bash
# Check Neo4j is running desktop for local user or enterprise neo4j
```
