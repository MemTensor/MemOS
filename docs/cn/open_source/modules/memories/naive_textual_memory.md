---
title: "NaiveTextMemory: 简单明文记忆"
desc: "MemOS 中最轻量级的记忆模块，专为快速原型开发和简单场景设计。无需向量数据库，使用关键词匹配即可快速检索。让我们用最简单的方式开始使用 MemOS 记忆系统！
`NaiveTextMemory` 是一个基于内存的明文记忆模块，将记忆存储在内存列表中，使用关键词匹配进行检索。它是学习 MemOS 的最佳起点，也适用于演示、测试和小规模应用。"

---

## 目录

- [你将学到什么](#你将学到什么)
- [为什么选择 NaiveTextMemory](#为什么选择-naivetextmemory)
- [核心概念](#核心概念)
    - [记忆结构](#记忆结构)
    - [元数据字段](#元数据字段-textualmemorymetadata)
    - [搜索机制](#搜索机制)
- [API 参考](#api-参考)
    - [初始化](#初始化)
    - [核心方法](#核心方法)
    - [配置参数](#配置参数)
- [动手实践](#动手实践)
    - [快速开始](#快速开始)
    - [完整示例](#完整示例)
    - [文件存储](#文件存储)
- [使用场景指南](#使用场景指南)
- [与其他记忆模块对比](#与其他记忆模块对比)
- [最佳实践](#最佳实践)
- [下一步](#下一步)

## 你将学到什么

在本指南的最后，你将能够：
- 使用 LLM 从对话中自动提取结构化记忆
- 在内存中存储和管理记忆（无需数据库）
- 使用关键词匹配搜索记忆
- 持久化和恢复记忆数据
- 理解何时使用 NaiveTextMemory，何时升级到其他模块

## 为什么选择 NaiveTextMemory

### 优势特性

::list{icon="ph:check-circle-duotone"}
- **零依赖**：无需向量数据库或嵌入模型
- **快速启动**：几行代码即可运行
- **轻量高效**：低资源占用，执行速度快
- **简单直观**：关键词匹配，结果可预测
- **易于调试**：所有记忆都在内存中，方便查看
- **完美起点**：学习 MemOS 的最佳入门选择
::

### 适用场景

::list{icon="ph:lightbulb-duotone"}
- 快速原型开发和概念验证
- 简单对话代理（记忆数量 < 1000 条）
- 测试和演示场景
- 资源受限环境（无法运行嵌入模型）
- 关键词搜索场景（查询与记忆直接匹配）
::

::note
**性能提示**<br>
当记忆数量超过 1000 条时，建议升级到 [GeneralTextMemory](/open_source/modules/memories/general_textual_memory)，它使用向量搜索，性能更优。
::


## 核心概念

### 记忆结构

每个记忆表示为一个 `TextualMemoryItem` 对象，包含以下字段：

| 字段       | 类型                        | 必填 | 描述                          |
| ---------- | --------------------------- | ---- | ----------------------------- |
| `id`       | `str`                       | ✗    | 唯一标识符（自动生成 UUID）   |
| `memory`   | `str`                       | ✓    | 记忆的主要文本内容            |
| `metadata` | `TextualMemoryMetadata`     | ✗    | 元数据（用于分类、过滤和检索）|

### 元数据字段 (`TextualMemoryMetadata`)

元数据提供了丰富的上下文信息，用于分类、过滤和组织记忆：

| 字段          | 类型                                               | 默认值     | 描述                           |
| ------------- | -------------------------------------------------- | ---------- | ------------------------------ |
| `type`        | `"procedure"` / `"fact"` / `"event"` / `"opinion"` | `"fact"`   | 记忆类型分类                   |
| `memory_time` | `str (YYYY-MM-DD)`                                 | 当前日期   | 记忆关联的时间                 |
| `source`      | `"conversation"` / `"retrieved"` / `"web"` / `"file"` | -          | 记忆来源                       |
| `confidence`  | `float (0-100)`                                    | 80.0       | 确定性/可信度评分              |
| `entities`    | `list[str]`                                        | `[]`       | 提及的实体或概念               |
| `tags`        | `list[str]`                                        | `[]`       | 主题标签                       |
| `visibility`  | `"private"` / `"public"` / `"session"`            | `"private"` | 访问控制范围                   |
| `updated_at`  | `str`                                              | 自动生成   | 最近更新时间戳（ISO 8601）     |

## API 参考

### 初始化

```python
from memos.memories.textual.naive import NaiveTextMemory
from memos.configs.memory import NaiveTextMemoryConfig

memory = NaiveTextMemory(config: NaiveTextMemoryConfig)
```

### 核心方法

| 方法                     | 参数                                  | 返回值                        | 描述                                   |
| ------------------------ | ------------------------------------- | ----------------------------- | -------------------------------------- |
| `extract(messages)`      | `messages: list[dict]`                | `list[TextualMemoryItem]`     | 使用 LLM 从对话中提取结构化记忆        |
| `add(memories)`          | `memories: list / dict / Item`        | `None`                        | 添加一个或多个记忆                     |
| `search(query, top_k)`   | `query: str, top_k: int`              | `list[TextualMemoryItem]`     | 关键词匹配检索 top-k 记忆              |
| `get(memory_id)`         | `memory_id: str`                      | `TextualMemoryItem`           | 通过 ID 获取单个记忆                   |
| `get_by_ids(ids)`        | `ids: list[str]`                      | `list[TextualMemoryItem]`     | 通过 ID 列表批量获取记忆               |
| `get_all()`              | -                                     | `list[TextualMemoryItem]`     | 返回所有记忆                           |
| `update(memory_id, new)` | `memory_id: str, new: dict`           | `None`                        | 更新指定记忆的内容或元数据             |
| `delete(ids)`            | `ids: list[str]`                      | `None`                        | 删除一个或多个记忆                     |
| `delete_all()`           | -                                     | `None`                        | 清空所有记忆                           |
| `dump(dir)`              | `dir: str`                            | `None`                        | 将记忆序列化为 JSON 文件保存           |
| `load(dir)`              | `dir: str`                            | `None`                        | 从 JSON 文件加载记忆                   |

### 搜索机制

`NaiveTextMemory` 使用**关键词匹配算法**：

::steps{}

#### 步骤 1: 分词
将查询和每条记忆内容分解为词汇列表

#### 步骤 2: 计算匹配度
统计查询词汇与记忆词汇的交集数量

#### 步骤 3: 排序
按匹配词数降序排列所有记忆

#### 步骤 4: 返回结果
取前 top-k 条记忆作为搜索结果

::



::note
**示例对比**<br>
查询："猫咪" <br>
- **关键词匹配**：只匹配包含"猫"、"猫咪"的记忆<br>
- **语义搜索**：还能匹配"宠物"、"小猫"、"喵星人"等相关记忆（稍后我们将在“通用明文记忆”文章中学习）
::

### 配置参数

**NaiveTextMemoryConfig**

| 参数              | 类型                   | 必填 | 默认值                 | 描述                                       |
| ------------------ | ---------------------- | ---- | ---------------------- | ------------------------------------------ |
| `extractor_llm`    | `LLMConfigFactory`     | ✓    | -                      | 用于从对话中提取记忆的 LLM 配置            |
| `memory_filename`  | `str`                  | ✗    | `textual_memory.json`  | 持久化存储的文件名                         |

**配置示例**

```json
{
  "backend": "naive_text",
  "config": {
    "extractor_llm": {
      "backend": "openai",
      "config": {
        "model_name_or_path": "gpt-4o-mini",
        "temperature": 0.8,
        "max_tokens": 1024,
        "api_base": "xxx",
        "api_key": "sk-xxx"
      }
    },
    "memory_filename": "my_memories.json"
  }
}
```

## 动手实践

### 快速开始

只需 3 步即可开始使用 NaiveTextMemory：

::steps{}

#### 步骤 1: 创建配置

```python
from memos.configs.memory import MemoryConfigFactory

config = MemoryConfigFactory(
    backend="naive_text",
    config={
        "extractor_llm": {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": "your-api-key",
                "api_base": "your-api-base"
            },
        },
    },
)
```

#### 步骤 2: 初始化记忆模块

```python
from memos.memories.factory import MemoryFactory

memory = MemoryFactory.from_config(config)
```

#### 步骤 3: 提取并添加记忆

```python
# 从对话中自动提取记忆
memories = memory.extract([
    {"role": "user", "content": "I love tomatoes."},
    {"role": "assistant", "content": "Great! Tomatoes are delicious."},
])

# 添加到记忆库
memory.add(memories)
print(f"✓ 已添加 {len(memories)} 条记忆")
```

::alert{type="info"}
**进阶：使用 MultiModal Reader**<br>
如果需要处理图片、URL、文件等多模态内容，可以使用 `MultiModalStructMemReader`。<br>
查看完整示例：[使用 MultiModalStructMemReader](./tree_textual_memory#使用-multimodalstructmemreader高级)
::

::

### 完整示例

以下是一个完整的端到端示例，展示所有核心功能：

```python
from memos.configs.memory import MemoryConfigFactory
from memos.memories.factory import MemoryFactory

# ========================================
# 1. 初始化
# ========================================
config = MemoryConfigFactory(
    backend="naive_text",
    config={
        "extractor_llm": {
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-4o-mini",
                "api_key": "your-api-key",
            },
        },
    },
)
memory = MemoryFactory.from_config(config)

# ========================================
# 2. 提取并添加记忆
# ========================================
memories = memory.extract([
    {"role": "user", "content": "I love tomatoes."},
    {"role": "assistant", "content": "Great! Tomatoes are delicious."},
])
memory.add(memories)
print(f"✓ 已添加 {len(memories)} 条记忆")

# ========================================
# 3. 搜索记忆
# ========================================
results = memory.search("tomatoes", top_k=2)
print(f"\n🔍 找到 {len(results)} 条相关记忆:")
for i, item in enumerate(results, 1):
    print(f"  {i}. {item.memory}")

# ========================================
# 4. 获取所有记忆
# ========================================
all_memories = memory.get_all()
print(f"\n📊 总共 {len(all_memories)} 条记忆")

# ========================================
# 5. 更新记忆
# ========================================
if memories:
    memory_id = memories[0].id
    memory.update(
        memory_id,
        {
            "memory": "User loves tomatoes.",
            "metadata": {"type": "opinion", "confidence": 95.0}
        }
    )
    print(f"\n✓ 已更新记忆: {memory_id}")

# ========================================
# 6. 持久化存储
# ========================================
memory.dump("tmp/mem")
print("\n💾 记忆已保存到 tmp/mem/textual_memory.json")

# ========================================
# 7. 加载记忆
# ========================================
memory.load("tmp/mem")
print("✓ 记忆已从文件加载")

# ========================================
# 8. 删除记忆
# ========================================
if memories:
    memory.delete([memories[0].id])
    print(f"\n🗑️ 已删除 1 条记忆")

# 删除所有记忆
# memory.delete_all()
```

::note
**扩展：互联网检索**<br>
NaiveTextMemory 专注于本地记忆管理。如需从互联网检索信息并添加到记忆库，请查看：<br>
[从互联网检索记忆](./tree_textual_memory#从互联网检索记忆可选)
::

### 文件存储

调用 `dump(dir)` 时，系统会将记忆保存到：

```
<dir>/<config.memory_filename>
```

该文件包含所有记忆条目的JSON列表，可以使用`load(dir)`重新加载.

**默认文件结构**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "memory": "User loves tomatoes.",
    "metadata": {
      "type": "opinion",
      "confidence": 95.0,
      "entities": ["user", "tomatoes"],
      "tags": ["food", "preference"],
      "updated_at": "2026-01-14T10:30:00Z"
    }
  },
  ...
]
```

使用 `load(dir)` 可以完整恢复所有记忆数据。

::note
**重要提示**<br>
记忆存储在内存中，进程重启后会丢失。请定期调用 `dump()` 保存数据！
::
## 使用场景指南

### 最适合的场景

::list{icon="ph:check-circle-duotone"}
- **快速原型开发**：无需配置向量数据库，几分钟即可启动
- **简单对话代理**：记忆数量 < 1000 条的小规模应用
- **测试和演示**：快速验证记忆提取和检索逻辑
- **资源受限环境**：无法运行嵌入模型或向量数据库的场景
- **关键词搜索**：查询内容与记忆文本直接匹配的场景
- **学习和教学**：了解 MemOS 记忆系统的最佳起点
::

### 不推荐的场景

::list{icon="ph:x-circle-duotone"}
- **大规模应用**：超过 10,000 条记忆（搜索性能退化）
- **语义搜索需求**：需要理解同义词（如"猫"和"宠物"）
- **生产环境**：对性能和准确性有严格要求
- **多语言场景**：需要跨语言语义理解
- **复杂关系推理**：需要理解记忆之间的关联关系
::

::alert{type="info"}
**升级路径**<br>
对于上述不推荐的场景，建议升级到：
- [GeneralTextMemory](/open_source/modules/memories/general_textual_memory) - 向量语义搜索，适合 10K-100K 条记忆
- [TreeTextMemory](/open_source/modules/memories/tree_textual_memory) - 图结构存储，支持关系推理和多跳查询
::

## 与其他记忆模块对比

选择合适的记忆模块对于项目成功至关重要。以下对比帮助你做出决策：

| 特性           | **NaiveTextMemory**   | **GeneralTextMemory**      | **TreeTextMemory**          |
| -------------- | --------------------- | -------------------------- | --------------------------- |
| **搜索方式**   | 关键词匹配            | 向量语义搜索               | 图结构 + 向量搜索           |
| **依赖组件**   | 仅 LLM                | LLM + 嵌入器 + 向量数据库  | LLM + 嵌入器 + 图数据库     |
| **适用规模**   | < 1K 条               | 1K - 100K 条               | 10K - 1M 条                 |
| **查询复杂度** | O(n) 线性扫描         | O(log n) 近似最近邻        | O(log n) + 图遍历           |
| **语义理解**   | ❌                     | ✅                          | ✅                           |
| **关系推理**   | ❌                     | ❌                          | ✅                           |
| **多跳查询**   | ❌                     | ❌                          | ✅                           |
| **存储后端**   | 内存列表              | 向量数据库（Qdrant 等）    | 图数据库（Neo4j/PolarDB）   |
| **配置复杂度** | 低 ⭐                 | 中 ⭐⭐                    | 高 ⭐⭐⭐                   |
| **学习曲线**   | 极简                  | 中等                       | 较陡                        |
| **生产就绪**   | ❌ 仅原型/演示         | ✅ 适合大多数场景           | ✅ 适合复杂应用             |

::alert{type="success"}
**选择建议**<br>
- **刚开始学习？** → 从 NaiveTextMemory 开始<br>
- **需要语义搜索？** → 使用 GeneralTextMemory<br>
- **需要关系推理？** → 选择 TreeTextMemory
::

## 最佳实践

遵循以下建议，充分发挥 NaiveTextMemory 的优势：

::steps{}

### 1. 定期持久化数据

```python
# 在关键操作后立即保存
memory.add(new_memories)
memory.dump("tmp/mem")  # ✓ 立即持久化

# 定期自动备份
import schedule
schedule.every(10).minutes.do(lambda: memory.dump("tmp/mem"))
```

### 2. 控制记忆规模

```python
# 定期清理旧记忆
if len(memory.get_all()) > 1000:
    old_memories = sorted(
        memory.get_all(),
        key=lambda m: m.metadata.updated_at
    )[:100]  # 最旧的 100 条

    memory.delete([m.id for m in old_memories])
    print("✓ 已清理 100 条旧记忆")
```

### 3. 优化搜索查询

```python
# ❌ 不好：模糊查询
results = memory.search("东西", top_k=5)

# ✅ 好：使用具体关键词
results = memory.search("番茄 西红柿", top_k=5)
```

### 4. 合理使用元数据

```python
# 添加记忆时设置清晰的元数据
memory.add({
    "memory": "User prefers dark mode",
    "metadata": {
        "type": "opinion",          # ✓ 明确分类
        "tags": ["UI", "preference"],  # ✓ 便于过滤
        "confidence": 90.0,         # ✓ 标注可信度
        "entities": ["user", "dark mode"]  # ✓ 实体标注
    }
})
```

### 5. 规划升级路径

```python
# 监控记忆数量，及时升级
memory_count = len(memory.get_all())
if memory_count > 800:
    print("⚠️ 记忆数量接近上限，建议升级到 GeneralTextMemory")
    # 迁移代码参考：
    # 1. 导出现有记忆：memory.dump("backup")
    # 2. 创建 GeneralTextMemory 配置
    # 3. 导入记忆到新模块
```

::


## 下一步

恭喜！你已经掌握了 NaiveTextMemory 的核心用法。接下来可以：

::list{icon="ph:arrow-right-duotone"}
- **升级到向量搜索**：学习 [GeneralTextMemory](/open_source/modules/memories/general_textual_memory) 的语义检索能力
- **探索图结构**：了解 [TreeTextMemory](/open_source/modules/memories/tree_textual_memory) 的关系推理功能
- **集成到应用**：查看 [完整 API 文档](/api-reference/search-memories) 构建生产级应用
- **运行示例代码**：浏览 `/examples/` 目录获取更多实战案例
- **了解图数据库**：如果需要高级功能，可以学习 [Neo4j](/open_source/modules/memories/neo4j_graph_db) 或 [PolarDB](/open_source/modules/memories/polardb_graph_db)
::

::alert{type="success"}
**提示**<br>
NaiveTextMemory 是学习 MemOS 的完美起点。当你的应用需要更强大的功能时，可以无缝迁移到其他记忆模块！
::
