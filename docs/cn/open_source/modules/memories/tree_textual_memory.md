---
title: "TreeTextMemory: 树形明文记忆"
desc: >
    让我们在MemOS中构建你的第一个**基于图的、树形明文记忆**！
    <br>
    **TreeTextMemory** 支持以结构化方式组织、关联并检索记忆，同时保留丰富的上下文信息与良好的可解释性。
    <br>
    MemOS当前使用[Neo4j](/open_source/modules/memories/neo4j_graph_db)作为后端，未来计划支持更多图数据库。
---



## 目录

- [你将学到什么](#你将学到什么)
- [核心概念与工作流程](#核心概念与工作流程)
    - [记忆结构](#记忆结构)
    - [元数据字段](#元数据字段-treenodetextualmemorymetadata)
    - [核心工作流](#核心工作流)
- [API 参考](#api-参考)
- [动手实践：从 0 到 1](#动手实践从-0-到-1)
    - [创建 TreeTextMemory 配置](#创建-treetextmemory-配置)
    - [初始化 TreeTextMemory](#初始化-treetextmemory)
    - [抽取结构化记忆](#抽取结构化记忆)
    - [搜索记忆](#搜索记忆)
    - [从互联网检索记忆（可选）](#从互联网检索记忆可选)
    - [替换工作记忆](#替换工作记忆)
    - [备份与恢复](#备份与恢复)
    - [完整代码示例](#完整代码示例)
- [为什么选择 TreeTextMemory](#为什么选择-treetextmemory)
- [下一步](#下一步)

## 你将学到什么

在本指南的最后，你会:
- 从原始文本或对话中提取结构化记忆
- 在图数据库中存储他们作为**节点**
- 将记忆链接成**层次结构**和语义图
- 使用**向量相似度+图遍历**进行搜索

## 核心概念与工作流程

### 记忆结构

每个节点在`TreeTextMemory` 是一个 `TextualMemoryItem`:
- `id`: 唯一记忆ID（如果省略则自动生成）
- `memory`: 主要文本
- `metadata`: 包括层次结构信息、嵌入、标签、实体、源和状态

### 元数据字段 (`TreeNodeTextualMemoryMetadata`)

| 字段           | 类型                                                  | 描述                                |
| --------------- |-------------------------------------------------------| ------------------------------------------ |
| `memory_type`   | `"WorkingMemory"`, `"LongTermMemory"`, `"UserMemory"` | 生命周期分类                         |
| `status`        | `"activated"`, `"archived"`, `"deleted"`              | 节点状态                                |
| `visibility`    | `"private"`, `"public"`, `"session"`                  | 访问范围                               |
| `sources`       | `list[str]`                                           | 来源列表 (例如: 文件, URLs)        |
| `source`        | `"conversation"`, `"retrieved"`, `"web"`, `"file"`    | 原始来源类型                       |
| `confidence`    | `float (0-100)`                                       | 确定性得分                           |
| `entities`      | `list[str]`                                           | 提及的实体或概念             |
| `tags`          | `list[str]`                                           | 主题标签                              |
| `embedding`     | `list[float]`                                         | 基于向量嵌入的相似性搜索     |
| `created_at`    | `str`                                                 | 创建时间戳(ISO 8601)              |
| `updated_at`    | `str`                                                 | 最近更新时间戳(ISO 8601)           |
| `usage`         | `list[str]`                                           | 使用历史                           |
| `background`    | `str`                                                 | 附加上下文                        |


::note
**最佳实践**<br>
  使用有意义的标签和背景——它们有助于组织你的图进行多跳推理。
::

### 核心工作流

当您运行此示例时，您的工作流将:

1. **抽取:** 使用LLM从原始文本中提取结构化记忆.


2. **嵌入:** 为相似性搜索生成向量嵌入.


3. **存储和链接:** 将具有关系的节点添加到图数据库（Neo4j）中.


4. **搜索:** 通过向量相似度查询，然后通过图跳数展开结果.


::note
**提示**<br>图链接有助于检索纯向量搜索可能遗漏的上下文!
::

## API 参考

### 初始化

```python
TreeTextMemory(config: TreeTextMemoryConfig)
```

### 核心方法

| 方法                      | 描述                                           |
| --------------------------- | ----------------------------------------------------- |
| `add(memories)`             | 添加一个或多个记忆（项目或字典）             |
| `replace_working_memory()`  | 更换所有的WorkingMemory节点                      |
| `get_working_memory()`      | 得到所有的WorkingMemory节点                          |
| `search(query, top_k)`      | 使用向量+图搜索检索top-k个记忆   |
| `get(memory_id)`            | 通过ID获取单个记忆                             |
| `get_by_ids(ids)`           | 通过IDs获取多个记忆                        |
| `get_all()`                 | 将整个记忆图导出为字典            |
| `update(memory_id, new)`    | 通过ID更新记忆                                 |
| `delete(ids)`               | 通过IDs删除记忆                                |
| `delete_all()`              | 删除所有的记忆和关系                 |
| `dump(dir)`                 | 在目录中将图序列化为JSON              |
| `load(dir)`                 | 从保存的JSON文件加载图                     |
| `drop(keep_last_n)`         | 备份图和删除数据库，保留N个备份       |

### 文件存储

当调用 `dump(dir)`, MemOS将树形明文记忆导出为JSON文件:

```
<dir>/<config.memory_filename>
```

这个文件包含一个JSON结构，有 `nodes` and `edges`. 它可以使用 `load(dir)`重新加载.

---

## 动手实践：从 0 到 1

::steps{}

### 创建 TreeTextMemory 配置
定义:
- 你的embedding模型（例如，nomic-embed-text:latest）,
- 你的图数据库后端(Neo4j),
- 记忆抽取器（基于LLM）（可选）.

```python
from memos.configs.memory import TreeTextMemoryConfig

config = TreeTextMemoryConfig.from_json_file("examples/data/config/tree_config.json")
```


### 初始化 TreeTextMemory

```python
from memos.memories.textual.tree import TreeTextMemory

tree_memory = TreeTextMemory(config)
```

### 抽取结构化记忆

使用记忆抽取器将对话、文件或文档解析为多个`TextualMemoryItem`.

#### 使用 SimpleStructMemReader（基础）

```python
from memos.mem_reader.simple_struct import SimpleStructMemReader

reader = SimpleStructMemReader.from_json_file("examples/data/config/simple_struct_reader_config.json")

scene_data = [[
    {"role": "user", "content": "Tell me about your childhood."},
    {"role": "assistant", "content": "I loved playing in the garden with my dog."}
]]

memories = reader.get_memory(scene_data, type="chat", info={"user_id": "1234"})
for m_list in memories:
    tree_memory.add(m_list)
```

#### 使用 MultiModalStructMemReader（高级）

`MultiModalStructMemReader` 支持处理多模态内容（文本、图片、URL、文件等），能够自动感知（智能路由）到不同的解析器：

```python
from memos.configs.mem_reader import MultiModalStructMemReaderConfig
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader

# 创建 MultiModal Reader 配置
multimodal_config = MultiModalStructMemReaderConfig(
    llm={
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-4o-mini",
            "api_key": "your-api-key"
        }
    },
    embedder={
        "backend": "openai",
        "config": {
            "model_name_or_path": "text-embedding-3-small",
            "api_key": "your-api-key"
        }
    },
    chunker={
        "backend": "text_splitter",
        "config": {
            "chunk_size": 1000,
            "chunk_overlap": 200
        }
    },
    extractor_llm={
        "backend": "openai",
        "config": {
            "model_name_or_path": "gpt-4o-mini",
            "api_key": "your-api-key"
        }
    },
    # 可选：指定哪些域名直接返回 Markdown
    direct_markdown_hostnames=["github.com", "docs.python.org"]
)

# 初始化 MultiModal Reader
multimodal_reader = MultiModalStructMemReader(multimodal_config)

# ========================================
# 示例 1: 处理包含图片的对话
# ========================================
scene_with_image = [[
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "这是我家的花园"},
            {"type": "image_url", "image_url": {"url": "https://example.com/garden.jpg"}}
        ]
    },
    {
        "role": "assistant",
        "content": "你的花园很漂亮！"
    }
]]

memories = multimodal_reader.get_memory(
    scene_with_image,
    type="chat",
    info={"user_id": "1234", "session_id": "session_001"}
)
for m_list in memories:
    tree_memory.add(m_list)
print(f"✓ 已添加 {len(memories)} 条多模态记忆")

# ========================================
# 示例 2: 处理网页 URL
# ========================================
scene_with_url = [[
    {
        "role": "user",
        "content": "请分析这篇文章: https://example.com/article.html"
    },
    {
        "role": "assistant",
        "content": "我会帮你分析这篇文章"
    }
]]

url_memories = multimodal_reader.get_memory(
    scene_with_url,
    type="chat",
    info={"user_id": "1234", "session_id": "session_002"}
)
for m_list in url_memories:
    tree_memory.add(m_list)
print(f"✓ 已从 URL 提取并添加 {len(url_memories)} 条记忆")

# ========================================
# 示例 3: 处理本地文件
# ========================================
# 支持的文件类型: PDF, DOCX, TXT, Markdown, HTML 等
file_paths = [
    "./documents/report.pdf",
    "./documents/notes.md",
    "./documents/data.txt"
]

file_memories = multimodal_reader.get_memory(
    file_paths,
    type="doc",
    info={"user_id": "1234", "session_id": "session_003"}
)
for m_list in file_memories:
    tree_memory.add(m_list)
print(f"✓ 已从文件提取并添加 {len(file_memories)} 条记忆")

# ========================================
# 示例 4: 混合模式（文本 + 图片 + URL）
# ========================================
mixed_scene = [[
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "这是我的项目文档:"},
            {"type": "text", "text": "https://github.com/user/project/README.md"},
            {"type": "image_url", "image_url": {"url": "https://example.com/diagram.png"}}
        ]
    }
]]

mixed_memories = multimodal_reader.get_memory(
    mixed_scene,
    type="chat",
    info={"user_id": "1234", "session_id": "session_004"}
)
for m_list in mixed_memories:
    tree_memory.add(m_list)
print(f"✓ 已从混合内容提取并添加 {len(mixed_memories)} 条记忆")
```

::alert{type="info"}
**MultiModal Reader 优势**<br>
- **智能路由**：自动识别内容类型（图片/URL/文件）并选择合适的解析器<br>
- **格式支持**：支持 PDF、DOCX、Markdown、HTML、图片等多种格式<br>
- **URL 解析**：自动提取网页内容（包括 GitHub、文档站点等）<br>
- **大文件处理**：自动分块处理超大文件，避免 token 超限<br>
- **上下文保持**：使用滑动窗口保持分块间的上下文连续性
::

::note
**配置提示**<br>
- 使用 `direct_markdown_hostnames` 参数可以指定哪些域名直接返回 Markdown 格式<br>
- 支持 `mode="fast"` 和 `mode="fine"` 两种提取模式，fine 模式提取更详细<br>
- 查看完整示例: `/examples/mem_reader/multimodal_struct_reader.py`
::

### 搜索记忆

尝试向量搜索+图搜索:
```python
results = tree_memory.search("Talk about the garden", top_k=5)
for i, node in enumerate(results):
    print(f"{i}: {node.memory}")
```

### 从互联网检索记忆（可选）
你也可以从 Google / Bing / Bocha（博查） 等搜索引擎实时获取网页内容，并自动切分为记忆节点。MemOS 提供了统一接口。

以下示例演示如何检索“Alibaba 2024 ESG report”相关网页，并自动提取为结构化记忆。

```python

# 创建embedder
embedder = EmbedderFactory.from_config(
    EmbedderConfigFactory.model_validate({
        "backend": "ollama",
        "config": {"model_name_or_path": "nomic-embed-text:latest"},
    })
)

# 配置检索器（以 BochaAI 为例）
retriever_config = InternetRetrieverConfigFactory.model_validate({
    "backend": "bocha",
    "config": {
        "api_key": "sk-xxx",  # 替换为你的 BochaAI API Key
        "max_results": 5,
        "reader": {  # 自动分块的 Reader 配置
            "backend": "simple_struct",
            "config": ...,  # 你的mem-reader config
        },
    }
})

# 实例化检索器
retriever = InternetRetrieverFactory.from_config(retriever_config, embedder)

# 执行网页检索
results = retriever.retrieve_from_internet("Alibaba 2024 ESG report")

# 添加到记忆图中
for m in results:
    tree_memory.add(m)

```
你也可以直接在 TreeTextMemoryConfig 中配置 internet_retriever 字段，例如：


```json
{
  "internet_retriever": {
    "backend": "bocha",
    "config": {
      "api_key": "sk-xxx",
      "max_results": 5,
      "reader": {
        "backend": "simple_struct",
        "config": ...
      }
    }
  }
}
```

这样，在调用 tree_memory.search(query) 时，系统会自动调用互联网检索（如 BochaAI / Google / Bing）然后将结果与本地图中的节点一起排序返回，无需手动调用 retriever.retrieve_from_internet

### 替换工作记忆

用一个新的节点替换你当前的 `WorkingMemory`:
```python
tree_memory.replace_working_memory(
    [{
        "memory": "User is discussing gardening tips.",
        "metadata": {"memory_type": "WorkingMemory"}
    }]
)
```

### 备份与恢复
支持树结构的持久化存储与随时重载:
```python
tree_memory.dump("tmp/tree_memories")
tree_memory.load("tmp/tree_memories")
```

::


### 完整代码示例

该示例整合了上述所有步骤，提供一个端到端的完整流程 —— 复制即可运行！

```python
from memos.configs.embedder import EmbedderConfigFactory
from memos.configs.memory import TreeTextMemoryConfig
from memos.configs.mem_reader import SimpleStructMemReaderConfig
from memos.embedders.factory import EmbedderFactory
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memories.textual.tree import TreeTextMemory

# 嵌入设置
embedder_config = EmbedderConfigFactory.model_validate({
    "backend": "ollama",
    "config": {"model_name_or_path": "nomic-embed-text:latest"}
})
embedder = EmbedderFactory.from_config(embedder_config)

# 创建TreeTextMemory
tree_config = TreeTextMemoryConfig.from_json_file("examples/data/config/tree_config.json")
my_tree_textual_memory = TreeTextMemory(tree_config)
my_tree_textual_memory.delete_all()

# 阅读器设置
reader_config = SimpleStructMemReaderConfig.from_json_file(
    "examples/data/config/simple_struct_reader_config.json"
)
reader = SimpleStructMemReader(reader_config)

# 从对话中抽取
scene_data = [[
    {
        "role": "user",
        "content": "Tell me about your childhood."
    },
    {
        "role": "assistant",
        "content": "I loved playing in the garden with my dog."
    },
]]
memory = reader.get_memory(scene_data, type="chat", info={"user_id": "1234", "session_id": "2222"})
for m_list in memory:
    my_tree_textual_memory.add(m_list)

# 搜索
results = my_tree_textual_memory.search(
    "Talk about the user's childhood story?",
    top_k=10
)
for i, r in enumerate(results):
    print(f"{i}'th result: {r.memory}")

# 从文档添加[可选项]
doc_paths = ["./text1.txt", "./text2.txt"]
doc_memory = reader.get_memory(
  doc_paths, "doc", info={
      "user_id": "your_user_id",
      "session_id": "your_session_id",
  }
)
for m_list in doc_memory:
    my_tree_textual_memory.add(m_list)

# 转储和丢弃[可选项]
my_tree_textual_memory.dump("tmp/my_tree_textual_memory")
my_tree_textual_memory.drop()
```

## 为什么选择 TreeTextMemory

- **结构层次:** 像思维导图一样组织记忆——节点可以有父母、孩子和交叉链接。
- **图风格的链接:** 超越纯粹的层次结构-建立多跳推理链。
- **语义搜索+图扩展:** 结合向量和图形的优点。
- **可解释性:** 追踪记忆是如何连接、合并或随时间演变的.

::note
**尝试一下**<br>从文档或web内容中添加记忆节点。手动链接它们或自动合并类似的节点！
::

## 下一步

- **了解更多[Neo4j](/open_source/modules/memories/neo4j_graph_db):** treeTextMemory由图数据库后端提供支持。了解Neo4j如何处理节点、边和遍历将帮助您设计更有效的记忆层次结构、多跳推理和上下文链接策略。
- **添加 [Activation Memory](/open_source/modules/memories/kv_cache_memory):** 使用运行时KV-cache来测试会话状态。
- **探索图推理:** 为多跳检索和答案合成构建工作流。
- **更进一步:** 为高级应用检查 [API Reference](/api-reference/search-memories), 或者在 `examples/`运行更多的示例.

现在你的Agent不仅能记住事实，还能记住它们之间的联系！
