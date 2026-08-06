---
title: "记忆模块总览"
desc: "MemOS 记忆系统完整指南 - MemOS 提供了丰富的记忆模块，满足从轻量级文本记忆到高级图结构的各种需求。本指南帮助你快速找到最适合的记忆解决方案。"
---

# 为什么需要不同的记忆模块

记忆模块是赋予Agent“长期记忆”能力的核心组件。它不只是像数据库一样死板地存取数据，而是能够像人类一样，对信息进行自动化地提取、分类、关联和动态更新。通过选择不同的记忆模块，你可以让 Agent拥有不同能力。

## 🎯 快速选择指南

::alert{type="info"}
**不确定选哪个？** 跟随这个决策树：
- 🚀 **快速测试/演示：简单上手，无需额外软件** → [NaiveTextMemory](#naivetextmemory-简单明文记忆)
- 📝 **通用文本记忆：记住聊天内容或大量文档，并能根据语义搜索** → [GeneralTextMemory](#generaltextmemory-通用文本记忆)
- 👤 **用户偏好管理：专门针对用户画像设计** → [PreferenceTextMemory](#preferencetextmemory-偏好记忆)
- 🌳 **结构化知识图谱：数据之间有复杂的逻辑关联** → [TreeTextMemory](#treetextmemory-分层结构记忆)
- ⚡ **推理加速：访问量很大，希望回复能更平稳、响应更快** → [KVCacheMemory](#kvcachememory-激活记忆)
::

---

## 📚 记忆模块分类

### 一、文本记忆系列

专注于存储和检索文本形式的记忆，适用于绝大多数应用场景。

#### NaiveTextMemory: 简单明文记忆
::card
**适用场景：** 快速原型、演示、教学、小规模应用

**核心特性：**
- ✅ 零依赖，纯内存存储
- ✅ 关键词匹配检索
- ✅ 极简 API，5 分钟上手
- ✅ 支持文件持久化

**局限性：**
- ❌ 无向量语义搜索
- ❌ 不适合大规模数据
- ❌ 检索精度有限

📖 [查看文档](./naive_textual_memory)
::

#### GeneralTextMemory: 通用文本记忆
::card
**适用场景：** 会话代理、个人助理、知识管理系统

**核心特性：**
- ✅ 基于向量的语义搜索
- ✅ 丰富的元数据支持（类型、时间、来源等）
- ✅ 灵活的过滤和查询
- ✅ 适合中大规模应用

**技术要求：**
- 需要向量数据库（Qdrant 等）
- 需要 Embedding 模型

📖 [查看文档](./general_textual_memory)
::

#### PreferenceTextMemory: 偏好记忆
::card
**适用场景：** 个性化推荐、用户画像、智能助理

**核心特性：**
- ✅ 自动识别显式和隐式偏好
- ✅ 偏好去重与冲突检测
- ✅ 按偏好类型、强度筛选
- ✅ 向量语义检索

**专用功能：**
- 双重偏好提取（explicit/implicit）
- 偏好强度评分
- 时间衰减支持

📖 [查看文档](./preference_textual_memory)
::

#### TreeTextMemory: 分层结构记忆
::card
**适用场景：** 知识图谱、复杂关系推理、多跳查询

**核心特性：**
- ✅ 基于图数据库的结构化存储
- ✅ 支持层次关系和因果链
- ✅ 多跳推理能力
- ✅ 去重、冲突检测、记忆调度

**高级功能：**
- 支持 MultiModal Reader（图片、URL、文件）
- 支持互联网检索（BochaAI、Google、Bing）
- 工作记忆替换机制

**技术要求：**
- 需要图数据库（Neo4j 等）
- 需要向量数据库和 Embedding 模型

📖 [查看文档](./tree_textual_memory)
::

---

### 二、专用记忆模块

针对特定场景优化的记忆系统。

#### KVCacheMemory: 激活记忆
::card
**适用场景：** LLM 推理加速、高频背景知识复用

**核心特性：**
- ⚡ 预计算 KV Cache，跳过重复编码
- ⚡ 大幅减少预填充阶段计算
- ⚡ 适合高吞吐量场景

**典型用例：**
- 常见问题（FAQ）缓存
- 对话历史复用
- 领域知识预加载

**工作原理：**
稳定的文本记忆 → 预转换为 KV Cache → 推理时直接注入

📖 [查看文档](./kv_cache_memory)
::

#### ParametricMemory: 参数化记忆
::card
**状态：** 🚧 正在开发中

**设计目标：**
- 将知识编码到模型权重（LoRA、专家模块）
- 动态加载/卸载能力模块
- 支持多任务、多角色架构

**未来功能：**
- 参数模块生成与压缩
- 版本控制与回滚
- 热插拔能力模块

📖 [查看文档](./parametric_memory)
::

---

### 三、图数据库后端

为 TreeTextMemory 提供图存储能力。

#### Neo4j Graph DB
::card
**推荐度：** ⭐⭐⭐⭐⭐

**特性：**
- 完整的图数据库功能
- 支持向量增强检索
- 多租户架构（v0.2.1+）
- 兼容社区版

📖 [查看文档](./neo4j_graph_db)
::

#### Nebula Graph DB
::card
**特性：**
- 分布式图数据库
- 高可用性
- 适合大规模部署

📖 [查看文档](./nebula_graph_db)
::

#### PolarDB Graph DB
::card
**特性：**
- 阿里云 PolarDB 图计算
- 云原生架构
- 企业级可靠性

📖 [查看文档](./polardb_graph_db)
::

---

## 🛠️ 使用场景推荐

### 场景 1: 快速原型开发
**推荐：** [NaiveTextMemory](./naive_textual_memory)
```python
from memos.memories import NaiveTextMemory
memory = NaiveTextMemory()
memory.add("用户喜欢喝咖啡")
results = memory.search("咖啡")
```

### 场景 2: 聊天机器人记忆
**推荐：** [GeneralTextMemory](./general_textual_memory)
- 支持语义搜索
- 按时间、类型、来源过滤
- 适合对话历史管理

### 场景 3: 个性化推荐系统
**推荐：** [PreferenceTextMemory](./preference_textual_memory)
- 自动提取用户偏好
- 偏好冲突检测
- 强度评分与筛选

### 场景 4: 知识图谱应用
**推荐：** [TreeTextMemory](./tree_textual_memory)
- 多跳关系查询
- 层次结构管理
- 复杂推理场景

### 场景 5: 高性能 LLM 服务
**推荐：** [KVCacheMemory](./kv_cache_memory)
- FAQ 系统
- 客服机器人
- 大批量请求处理

---

## 🔗 高级功能

### MultiModal Reader（多模态读取）
在 TreeTextMemory 中支持处理：
- 对话中的图片
- 网页 URL
- 本地文件（PDF、DOCX、TXT、Markdown）
- 混合模式（文本+图片+URL）

👉 [查看示例](./tree_textual_memory#使用-multimodalstructmemreader高级)

### Internet Retrieval（互联网检索）
从网络获取实时信息并添加到记忆：
- BochaAI 搜索
- Google 搜索
- Bing 搜索

👉 [查看示例](./tree_textual_memory#从互联网检索记忆可选)

---
