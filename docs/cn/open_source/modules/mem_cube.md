---
title: MemCube
desc: "MemCube 是你的“记忆收纳箱”，统一管理三种类型的记忆：明文记忆、激活记忆和参数化记忆。它提供简洁的接口，方便加载、保存和操作多个记忆模块，让开发者轻松构建、保存和共享记忆增强应用。"
---
## 什么是 MemCube？

**MemCube** 是一个容器，包含了三种主要类型的记忆：

- **明文记忆** (例如，`GeneralTextMemory`、`TreeTextMemory`): 用于存储和检索非结构化或结构化文本知识。
- **激活记忆** (例如，`KVCacheMemory`): 用于存储键值缓存以加速 LLM 推理和上下文重用。
- **参数化记忆** (例如，`LoRAMemory`): 用于存储模型适应参数（如 LoRA 权重）。

每种记忆都可以独立配置，根据应用需求灵活组合。

## 结构

MemCube 由配置定义（参见 `GeneralMemCubeConfig`），该配置为每种记忆类型指定后端和配置。典型结构是：

```
MemCube
 ├── user_id
 ├── cube_id
 ├── text_mem: TextualMemory
 ├── act_mem: ActivationMemory
 └── para_mem: ParametricMemory
```

所有记忆模块都可通过 MemCube 接口访问：

- `mem_cube.text_mem`
- `mem_cube.act_mem`
- `mem_cube.para_mem`

## View 架构

从 MemOS 2.0 开始，运行时操作（add/search）应通过 **View 架构**：

### SingleCubeView

用于管理单个 MemCube。当系统只需要一个记忆空间时使用。

```python
from memos.multi_mem_cube.single_cube import SingleCubeView

view = SingleCubeView(
    cube_id="my_cube",
    naive_mem_cube=naive_mem_cube,
    mem_reader=mem_reader,
    mem_scheduler=mem_scheduler,
    logger=logger,
    searcher=searcher,
    feedback_server=feedback_server,  # 可选
)

# 添加记忆
view.add_memories(add_request)

# 搜索记忆
view.search_memories(search_request)
```

### CompositeCubeView

用于管理多个 MemCube。当需要跨多个记忆空间进行统一操作时使用。

```python
from memos.multi_mem_cube.composite_cube import CompositeCubeView

# 创建多个 SingleCubeView
view1 = SingleCubeView(cube_id="cube_1", ...)
view2 = SingleCubeView(cube_id="cube_2", ...)

# 用于多 cube 操作的组合视图
composite = CompositeCubeView(cube_views=[view1, view2], logger=logger)

# 跨所有 cube 搜索
results = composite.search_memories(search_request)
# 结果包含 cube_id 字段以标识来源
```

### API 请求字段

#### 添加记忆（add模式）

| 字段                  | 描述                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `writable_cube_ids` | add 操作的目标 cube                                              |
| `async_mode`        | `"async"`（启用 scheduler 后台处理）或 `"sync"`（禁用 scheduler 同步处理） |

#### 搜索记忆（search模式）

| 字段                  | 描述                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `readable_cube_ids` | search 操作的目标 cube                                           |
| `async_mode`        | `"async"`（启用 scheduler 后台处理）或 `"sync"`（禁用 scheduler 同步处理） |

## 核心方法（GeneralMemCube）

GeneralMemCube 是 MemCube 的标准实现，通过统一的接口管理系统的所有记忆。GeneralMemCube 提供以下核心方法来管理记忆数据的生命周期。

### 初始化

```python
from memos.mem_cube.general import GeneralMemCube
mem_cube = GeneralMemCube(config)
```

### 静态数据操作

| 方法                                      | 描述                                      |
| ----------------------------------------- | ----------------------------------------- |
| `init_from_dir(dir)`                    | 从本地目录加载 MemCube                    |
| `init_from_remote_repo(repo, base_url)` | 从远程仓库加载 MemCube（如 Hugging Face） |
| `load(dir)`                             | 从目录加载所有记忆到现有实例              |
| `dump(dir)`                             | 将所有记忆保存到目录以持久化              |

## 文件存储

MemCube 保存后的目录包含以下文件，每个文件对应一种记忆类型：

- `config.json` (MemCube 配置)
- `textual_memory.json` (明文记忆)
- `activation_memory.pickle` (激活记忆)
- `parametric_memory.adapter` (参数化记忆)

## 使用示例

### 导出示例 (dump_cube.py)

```python
import json
import os
import shutil

from memos.api.handlers import init_server
from memos.api.product_models import APIADDRequest
from memos.log import get_logger
from memos.multi_mem_cube.single_cube import SingleCubeView

logger = get_logger(__name__)
EXAMPLE_CUBE_ID = "example_dump_cube"
EXAMPLE_USER_ID = "example_user"

# 1. 初始化服务
components = init_server()
naive = components["naive_mem_cube"]

# 2. 创建 SingleCubeView
view = SingleCubeView(
    cube_id=EXAMPLE_CUBE_ID,
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)

# 3. 通过 View 添加记忆
result = view.add_memories(APIADDRequest(
    user_id=EXAMPLE_USER_ID,
    writable_cube_ids=[EXAMPLE_CUBE_ID],
    messages=[
        {"role": "user", "content": "This is a test memory"},
        {"role": "user", "content": "Another memory to persist"},
    ],
    async_mode="sync",  # 使用同步模式确保立即完成
))
print(f"✓ Added {len(result)} memories")

# 4. 导出特定 cube_id 的数据
output_dir = "tmp/mem_cube_dump"
if os.path.exists(output_dir):
    shutil.rmtree(output_dir)
os.makedirs(output_dir, exist_ok=True)

# 导出图数据（仅导出当前 cube_id 的数据）
json_data = naive.text_mem.graph_store.export_graph(
    include_embedding=True,  # 包含 embedding 以支持语义搜索
    user_name=EXAMPLE_CUBE_ID,  # 按 cube_id 过滤
)

# 修复 embedding 格式：将字符串解析为列表以兼容导入
import contextlib
for node in json_data.get("nodes", []):
    metadata = node.get("metadata", {})
    if "embedding" in metadata and isinstance(metadata["embedding"], str):
        with contextlib.suppress(json.JSONDecodeError):
            metadata["embedding"] = json.loads(metadata["embedding"])

print(f"✓ Exported {len(json_data.get('nodes', []))} nodes")

# 保存到文件
memory_file = os.path.join(output_dir, "textual_memory.json")
with open(memory_file, "w", encoding="utf-8") as f:
    json.dump(json_data, f, indent=2, ensure_ascii=False)
print(f"✓ Saved to: {memory_file}")
```

### 导入与搜索示例 (load_cube.py)

> **Embedding 兼容性说明**：示例数据使用 **bge-m3** 模型，维度为 **1024**。如果您的环境使用不同的 embedding 模型或维度，导入后的语义搜索可能不准确或失败。请确保您的 `.env` 配置与导出时的 embedding 配置一致。

```python
import json
import os

from memos.api.handlers import init_server
from memos.api.product_models import APISearchRequest
from memos.log import get_logger
from memos.multi_mem_cube.single_cube import SingleCubeView

logger = get_logger(__name__)
EXAMPLE_CUBE_ID = "example_dump_cube"
EXAMPLE_USER_ID = "example_user"

# 1. 初始化服务
components = init_server()
naive = components["naive_mem_cube"]

# 2. 创建 SingleCubeView
view = SingleCubeView(
    cube_id=EXAMPLE_CUBE_ID,
    naive_mem_cube=naive,
    mem_reader=components["mem_reader"],
    mem_scheduler=components["mem_scheduler"],
    logger=logger,
    searcher=components["searcher"],
    feedback_server=components["feedback_server"],
)

# 3. 从文件加载数据到 graph_store
load_dir = "examples/data/mem_cube_tree"
memory_file = os.path.join(load_dir, "textual_memory.json")

with open(memory_file, encoding="utf-8") as f:
    json_data = json.load(f)

naive.text_mem.graph_store.import_graph(json_data, user_name=EXAMPLE_CUBE_ID)

nodes = json_data.get("nodes", [])
print(f"✓ Imported {len(nodes)} nodes")

# 4. 显示加载的数据
print(f"\nLoaded {len(nodes)} memories:")
for i, node in enumerate(nodes[:3], 1):  # 显示前3条
    metadata = node.get("metadata", {})
    memory_text = node.get("memory", "N/A")
    mem_type = metadata.get("memory_type", "unknown")
    print(f"  [{i}] Type: {mem_type}")
    print(f"      Content: {memory_text[:60]}...")

# 5. 语义搜索验证
query = "test memory dump persistence demonstration"
print(f'\nSearching: "{query}"')

search_result = view.search_memories(
    APISearchRequest(
        user_id=EXAMPLE_USER_ID,
        readable_cube_ids=[EXAMPLE_CUBE_ID],
        query=query,
    )
)

text_mem_results = search_result.get("text_mem", [])
memories = []
for group in text_mem_results:
    memories.extend(group.get("memories", []))

print(f"✓ Found {len(memories)} relevant memories")
for i, mem in enumerate(memories[:2], 1):  # 显示前2条
    print(f"  [{i}] {mem.get('memory', 'N/A')[:60]}...")
```

### 完整示例

参见代码仓库中的示例：

- `MemOS/examples/mem_cube/dump_cube.py` - 导出 MemCube 数据（add + export）
- `MemOS/examples/mem_cube/load_cube.py` - 导入 MemCube 数据并进行语义搜索（import + search）

### 旧 API 说明

早期版本中直接调用 `mem_cube.text_mem.get_all()` 的方式已废弃，请使用 View 架构。旧示例已移至 `MemOS/examples/mem_cube/_deprecated/`。

## 开发者说明

* MemCube 强制执行模式一致性，确保安全的加载/转储
* 每种记忆类型都是可插拔的，支持独立测试
* 参见 `/tests/mem_cube/` 了解集成测试和使用模式
