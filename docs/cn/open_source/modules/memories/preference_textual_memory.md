---
title: "PreferenceTextMemory: 存储和管理用户偏好的明文记忆"
desc: "`PreferenceTextMemory` 是MemOS中用于存储和管理用户偏好的明文记忆模块。它适用于需要根据用户偏好进行记忆检索的场景。"
---

## 目录

- [为什么需要偏好记忆](#为什么需要偏好记忆)
  - [优势特性](#优势特性)
  - [应用场景](#应用场景)
- [核心概念与工作流程](#核心概念与工作流程)
  - [记忆结构](#记忆结构)
  - [元数据字段](#元数据字段)
  - [核心工作流](#核心工作流)
- [API 参考](#api-参考)
  - [初始化](#初始化)
  - [核心方法](#核心方法)
  - [文件存储](#文件存储)
- [动手实践：从 0 到 1](#动手实践从-0-到-1)
  - [创建 PreferenceTextMemory 配置](#创建-preferencetextmemory-配置)
  - [初始化 PreferenceTextMemory](#初始化-preferencetextmemory)
  - [抽取结构化记忆](#抽取结构化记忆)
  - [搜索记忆](#搜索记忆)
  - [备份与恢复](#备份与恢复)
  - [完整代码示例](#完整代码示例)


## 为什么需要偏好记忆

### 优势特性

::list{icon="ph:check-circle-duotone"}
- **双重偏好提取**：自动识别显式偏好和隐式偏好
- **语义理解**：使用向量嵌入理解偏好的深层含义
- **智能去重**：自动检测和合并重复或冲突的偏好
- **精准检索**：基于向量相似度的语义搜索
- **持久化存储**：支持向量数据库（Qdrant/Milvus）
- **可扩展性**：支持大规模偏好数据管理
- **个性化增强**：为每个用户维护独立的偏好档案
::

### 应用场景

::list{icon="ph:lightbulb-duotone"}
- 个性化对话代理（记住用户喜好）
- 智能推荐系统（基于偏好推荐）
- 客户服务系统（提供定制化服务）
- 内容过滤系统（根据偏好筛选内容）
- 学习辅助系统（适应学习风格）
::

::alert{type="info"}

总结来说，当你需要构建能够"记住"用户喜好并据此提供个性化服务的系统时，`PreferenceTextMemory` 是最佳选择。
::

## 核心概念与工作流程
### 记忆结构

在MemOS中，偏好记忆以`PreferenceTextMemory`表示，每条记忆都是一个`TextualMemoryItem`，使用Milvus数据库存储。
- `id`: 唯一记忆ID（如果省略则自动生成）
- `memory`: 主要文本
- `metadata`: 包括层次结构信息、嵌入、标签、实体、源和状态

偏好记忆又可以分为显式偏好记忆和隐式偏好记忆：
- **显式偏好记忆**：用户明确表达的喜好或厌恶。**示例**：
    - "我喜欢深色模式"
    - "我不吃辣"
    - "请用简短的回答"
    - "我更喜欢技术文档而不是视频教程"

- **隐式偏好记忆**：从用户行为和对话模式中推断出的偏好。**示例**：
    - 用户总是询问代码示例 → 偏好实践导向的学习
    - 用户经常要求详细解释 → 偏好深入理解
    - 用户多次提到环保话题 → 关注可持续发展

::alert{type="success"}
**智能提取**<br>
`PreferenceTextMemory` 使用 LLM 自动从对话中同时提取显式和隐式偏好，无需手动标注！
::

### 元数据字段 （`PreferenceTextualMemoryMetadata`）

| 字段         | 类型                                               | 描述                         |
| ------------- | -------------------------------------------------- | ----------------------------------- |
| `preference_type`        | `"explicit_preference"`, `"implicit_preference"`                                    | 偏好记忆类型，分为显式偏好记忆和隐式偏好记忆                         |
| `dialog_id`        | `str`                                    | 对话ID，用于关联偏好记忆与特定对话                         |
| `original_text`        | `str`                                    | 原始文本，包含用户偏好信息                         |
| `embedding`        | `str`                                    | 嵌入向量，用于语义搜索和检索                         |
| `preference`        | `str`                                    | 用户偏好信息              |
| `create_at`        | `str`                                    | 创建时间戳 (ISO 8601)                         |
| `mem_cube_id`        | `str`                                    | 记忆立方ID，用于关联偏好记忆与特定记忆立方                         |
| `score`        | `float `                                | 检索结果中偏好记忆和query的相似度评分   |

### 核心工作流

当您运行此示例时，您的工作流将:

1. **抽取:** 使用LLM从原始文本中提取结构化记忆.


2. **嵌入:** 为相似性搜索生成向量嵌入.


3. **存储:** 将偏好记忆存储到Milvus数据库中，同时更新元数据字段.


4. **搜索:** 通过向量相似度查询，返回最相关的偏好记忆.

## API 参考

### 初始化

```python
PreferenceTextMemory(config: PreferenceTextMemoryConfig)
```

### 核心方法

| 方法                      | 描述                                           |
| --------------------------- | ----------------------------------------------------- |
| `get_memory(messages)` | 从原始对话中抽取偏好记忆. |
| `search(query, top_k)` | 使用向量相似度检索top-k偏好记忆. |
| `load(dir)` | 从存储的文件中加载偏好记忆. |
| `dump(dir)` | 将所有偏好记忆序列化到目录中的JSON文件. |
| `add(memories)` | 批量添加偏好记忆到Milvus数据库.  |
| `get_with_collection_name(collection_name, memory_id)` | 通过集合名称和记忆ID获取特定类型的偏好记忆. |
| `get_by_ids_with_collection_name(collection_name, memory_ids)` | 通过集合名称和记忆IDs**批量**获取特定类型的偏好记忆. |
| `get_all()` | 获取所有偏好记忆. |
| `get_memory_by_filter(filter)` | 根据过滤条件获取偏好记忆. |
| `delete(memory_ids)` | 删除指定ID的偏好记忆. |
| `delete_by_filter(filter)` | 根据过滤条件删除偏好记忆. |
| `delete_with_collection_name(collection_name, memory_ids)` | 删除指定集合名称和IDs的所有偏好记忆. |
| `delete_all()` | 删除所有偏好记忆. |


### 文件存储

当调用 `dump(dir)` 时，MemOS将所有偏好记忆序列化到目录中的JSON文件中:
```
<dir>/<config.memory_filename>
```

---

## 动手实践：从 0 到 1

::steps{}

### 创建 PreferenceTextMemory 配置
定义:
- 你的embedding模型（例如，nomic-embed-text:latest）,
- 你的Milvus数据库后端,
- 记忆抽取器（基于LLM）（可选）.

```python
from memos.configs.memory import PreferenceTextMemoryConfig

config = PreferenceTextMemoryConfig.from_json_file("examples/data/config/preference_config.json")
```

### 初始化 PreferenceTextMemory

```python
from memos.memories.textual.preference import PreferenceTextMemory

preference_memory = PreferenceTextMemory(config)
```

### 抽取结构化记忆

使用记忆抽取器将对话、文件或文档解析为多个`TextualMemoryItem`.

```python
scene_data = [[
    {"role": "user", "content": "Tell me about your childhood."},
    {"role": "assistant", "content": "I loved playing in the garden with my dog."}
]]

memories = preference_memory.get_memory(scene_data, type="chat", info={"user_id": "1234"})
preference_memory.add(memories)
```

### 搜索记忆

```python
results = preference_memory.search("Tell me more about the user", top_k=2)
```

### 备份与恢复
支持偏好记忆的持久化存储与随时重载：
```python
preference_memory.dump("tmp/pref_memories")
preference_memory.load("tmp/pref_memories")
```

::

### 完整代码示例

该示例整合了上述所有步骤，提供一个端到端的完整流程，以Milvus为例 —— 复制即可运行！

```python
from memos.configs.memory import PreferenceTextMemoryConfig
from memos.memories.textual.preference import PreferenceTextMemory

# 创建PreferenceTextMemory
config = PreferenceTextMemoryConfig.from_json_file("examples/data/config/preference_config.json")

preference_memory = PreferenceTextMemory(config)
preference_memory.delete_all()

scene_data = [[
    {"role": "user", "content": "Tell me about your childhood."},
    {"role": "assistant", "content": "I loved playing in the garden with my dog."}
]]

# 从原始对话中抽取偏好记忆，并添加到Milvus数据库中
memories = preference_memory.get_memory(scene_data, type="chat", info={"user_id": "1234"})
preference_memory.add(memories)

# 搜索记忆
results = preference_memory.search("Tell me more about the user", top_k=2)

# 持久化存储偏好记忆
preference_memory.dump("tmp/pref_memories")
```
