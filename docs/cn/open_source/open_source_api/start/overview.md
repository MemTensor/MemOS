---
title: 概述
---

## 1. 接口介绍

MemOS 开源项目提供了一套基于 **FastAPI** 编写的高性能 REST API 服务。系统采用 **Component (组件) + Handler (处理器)** 架构，所有核心逻辑（如记忆提取、语义搜索、异步调度）均可通过标准的 REST 接口进行调用。

![MemOS Architecture](https://cdn.memtensor.com.cn/img/memos_run_server_success_compressed.png)
<div style="text-align: center; margin-top: 10px">MemOS REST API 服务架构概览</div>

### 核心功能特点

* **多维记忆生产**：支持通过 `AddHandler` 处理对话、文本或文档，并自动转化为结构化记忆。
* **MemCube 物理隔离**：基于 Cube ID 实现不同用户或知识库之间的数据物理隔离与独立索引。
* **端到端对话闭环**：通过 `ChatHandler` 编排“检索 -> 生成 -> 异步存储”的全流程。
* **异步任务调度**：内置 `MemScheduler` 调度引擎，支持大规模记忆生产任务的削峰填谷与状态追踪。
* **自我纠偏机制**：提供反馈接口，允许利用自然语言对已存储的记忆进行修正或标记。

## 2. 入门指南

通过以下两个核心步骤，快速将记忆能力集成到您的 AI 应用中：

* [**添加记忆**](./core/add_memory.md)：通过 `POST /product/add` 接口，将原始消息流写入指定的 MemCube，开启生产链路。
* [**检索记忆**](./core/search_memory.md)：通过 `POST /product/search` 接口，基于语义相似度从多个 Cube 中召回相关上下文。

## 3. 接口分类

MemOS 的功能接口分为以下几大类：

* **[核心记忆 (Core)](./core/add_memory.md)**：包含记忆的增、删、改、查等原子操作。
* **[智能对话 (Chat)](./chat/chat.md)**：实现带记忆增强的流式或全量对话响应。
* **[消息管理 (Message)](./message/feedback.md)**：涵盖用户反馈、猜你想问（Suggestion）等增强交互接口。
* **[异步调度 (Scheduler)](./scheduler/get_status.md)**：用于监控后台记忆提取任务的进度与队列状态。
* **[系统工具 (Tools)](./tools/check_cube.md)**：提供 Cube 存在性校验及记忆归属反查等辅助功能。

## 4. 鉴权认证与上下文

### 鉴权机制
在开源环境中，所有的 API 请求需要在 Header 中包含 `Authorization` 字段。
* **开发环境**：您可以在本地 `.env` 或 `configuration.md` 中自定义 `API_KEY`。
* **生产部署**：建议通过 `RequestContextMiddleware` 扩展 OAuth2 或更高级的身份校验逻辑。

### 请求上下文
* **user_id**：请求体中必须包含此标识，用于 Handler 层的身份追踪。
* **MemCube ID**：开源版的核心隔离单元。通过指定 `readable_cube_ids` 或 `writable_cube_ids`，您可以精确控制数据读写的物理边界。

## 5. 下一步行动

* 👉 [**系统配置**](./start/configuration.md)：配置您的 LLM 提供商与向量数据库引擎。
* 👉 [**添加第一条记忆**](./core/add_memory.md)：尝试通过 SDK 或 Curl 提交第一组对话消息。
* 👉 [**探索常见错误**](./help/error_codes.md)：了解 API 状态码及其背后的异常处理机制。
