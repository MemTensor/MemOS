---
title: 常见错误与解决方案
---

## 1. 数据库与向量相关错误

### Embedding 维度不匹配

**现象**：
更改 Embedding 模型后（例如从 `openai` 切换到 `ollama`），系统报错或检索效果极差。
日志中可能出现 `Dimension mismatch` 或 Qdrant 相关的 `Wrong input vector size` 错误。

**原因**：
Qdrant 在创建 Collection 时会根据配置文件中的 `vector_dimension` 固定向量维度。
*   OpenAI `text-embedding-3-small`: 1536 维
*   Ollama `nomic-embed-text`: 768 维
*   BAAI `bge-m3`: 1024 维

MemOS 的 `QdrantVecDB` 在初始化时，如果发现 Collection 已存在，会跳过创建步骤。此时如果使用了新维度的模型，写入向量时就会报错。

**解决方案**：
1.  **修改 Collection 名称**：在配置文件中更改 `collection_name`，让 MemOS 创建一个新的 Collection。
    ```yaml
    vec_db:
      config:
        collection_name: "memos_v2" # 原名为 memos_v1
        vector_dimension: 768       # 确保此维度与新模型一致
    ```
2.  **删除旧数据**：如果你在开发环境，可以直接删除 Qdrant 的存储卷或 Drop 掉旧的 Collection。

### 数据后端启动失败 (Neo4j/Qdrant)

**现象**：
启动 MemOS 时报错 `ConnectionRefusedError`, `ServiceUnavailable` 或 `AuthError`。

**常见原因与检查清单**：

1.  **Docker 容器未启动**：
    确保你已经运行了必要的中间件容器。
    ```bash
    docker ps
    # 检查是否有 neo4j 和 qdrant 容器在运行
    ```

2.  **端口未映射**：
    检查 `docker run` 命令是否包含了 `-p` 参数。
    *   Qdrant 需要暴露 `6333` (gRPC/HTTP)
    *   Neo4j 需要暴露 `7474` (HTTP) 和 `7687` (Bolt)

3.  **Neo4j 认证失败**：
    MemOS 默认配置通常使用 `neo4j/password` 或 `neo4j/neo4j`。
    请检查你的环境变量或配置文件：
    ```bash
    export NEO4J_PASSWORD="your_actual_password"
    ```
    *注意：Neo4j 首次启动要求修改默认密码，请确保已在浏览器 (http://localhost:7474) 中完成此步骤。*

## 2. 模型服务错误

### Ollama 连接失败

**现象**：
报错 `Connection refused` 连接到 `localhost:11434` 失败，或者提示模型不存在。

**解决方案**：
1.  **启动服务**：确保在终端运行了 `ollama serve`。
2.  **拉取模型**：MemOS 的 `OllamaEmbedder` 会尝试检查本地模型，如果不存在会尝试 pull，但建议手动执行以确保成功：
    ```bash
    ollama pull nomic-embed-text
    ```
3.  **地址问题**：如果是 Docker 运行 MemOS，`localhost` 指向容器内部。需使用 `host.docker.internal` (Mac/Windows) 或宿主机 IP (Linux) 配置 `api_base`。

## 3. 配置错误

### 缺失必要字段

```python
# ✅ 始终需要包含必填字段
llm_config = {
    "backend": "openai",
    "config": {
        "api_key": "your-api-key",
        "model_name_or_path": "gpt-4"
    }
}
```

### 后端不匹配

```python
# ✅ KVCache 需要使用 HuggingFace 后端
# 参考 src/memos/memories/activation/kv.py
kv_config = {
    "backend": "kv_cache",
    "config": {
        "extractor_llm": {
            "backend": "huggingface",
            "config": {
                "model_name_or_path": "Qwen/Qwen3-1.7B"
            }
        }
    }
}
```

## 4. 运行时资源问题

### 记忆加载失败 (Schema Mismatch)

**现象**：
`mem_cube.load()` 报错，通常是因为 JSON 文件结构与当前代码版本不兼容。

**解决方案**：
重新初始化 MemCube 并覆盖旧数据（注意数据丢失风险）：

```python
try:
    mem_cube.load("memory_dir")
except Exception:
    logger.warning("Loading failed, initializing new memory cube")
    mem_cube = GeneralMemCube(config)
    # 谨慎操作：这会覆盖旧数据
    mem_cube.dump("memory_dir")
```

### GPU 显存不足

**解决方案**：
使用 `CUDA_VISIBLE_DEVICES` 指定显卡，或切换更小的模型（如 0.5B/1.5B 版本）。

```python
import os
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
```

## 5. 用户管理常见问题

**现象**：
调用 `get_user` 返回 None 或报错。

**解决方案**：
MemOS 需要明确的用户注册流程。

```python
# 1. 注册 MemCube 到特定用户
mos.register_mem_cube(cube_path="path", user_id="user_id", cube_id="cube_id")

# 2. 创建或获取用户
try:
    # 尝试创建用户
    user_id = mos.create_user(user_name="john", role=UserRole.USER)
except ValueError:
    # 如果用户已存在，则获取
    user = mos.user_manager.get_user_by_name("john")
```
