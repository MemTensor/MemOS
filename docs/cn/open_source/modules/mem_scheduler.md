---
title: "MemScheduler"
desc: "MemScheduler 是你的“记忆组织调度器”，它在后台异步管理记忆的流转和更新，协调工作记忆、长时记忆和激活记忆之间的交互，让对话系统能够动态地组织和利用记忆。"
---

## 主要特性

- 🚀 **与 MemOS 系统并发操作**：独立线程/进程运行，不阻塞主业务逻辑。
- 🧠 **多记忆协调**：智能管理工作记忆、长时记忆和用户个性化记忆的流转。
- ⚡ **事件驱动调度**：基于消息队列（Redis/Local）的异步任务分发机制。
- 🔍 **高效检索**：集成向量检索与图谱检索，快速定位相关记忆。
- 📊 **全面监控**：实时监控记忆使用率、任务队列状态和调度延迟。
- 📝 **详细日志记录**：全链路追踪记忆操作，便于调试和系统分析。

##  MemScheduler 架构

`MemScheduler` 采用模块化架构，分为三层：

### 调度层（核心）
1. **调度器（路由器）**：智能消息路由器，根据消息类型（`QUERY`, `ANSWER`, `MEM_UPDATE` 等）将任务分发给对应的处理器。
2. **消息处理**：通过带有特定标签（Label）的消息驱动业务逻辑，定义消息格式和处理规则。

### 执行层（保障）
3. **任务队列**：支持 Redis Stream（生产环境）和 Local Queue（开发测试）两种模式，提供异步任务缓冲和持久化。
4. **记忆管理**：执行三层记忆（Working/Long-term/User）的读写、压缩、遗忘和类型转换。
5. **检索系统**：混合检索模块，结合用户意图、场景管理与关键词匹配，快速定位相关记忆。

### 支撑层（辅助）
6. **监控**：跟踪任务积压、处理耗时和记忆库健康状态。
7. **日志记录**：维护全链路记忆操作日志，便于调试和分析。

##  MemScheduler 初始化

在 MemOS 的架构中，`MemScheduler` 是作为服务器组件的一部分在启动时被初始化的。

### 在 Server Router 中初始化

在 `src/memos/api/routers/server_router.py` 中，调度器通过 `init_server()` 函数被自动加载：

```python
from memos.api import handlers
from memos.api.handlers.base_handler import HandlerDependencies
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.utils.status_tracker import TaskStatusTracker

# ... 其他导入 ...

# 1. 初始化所有服务器组件 (包括 DB, LLM, Memory, Scheduler)
# init_server() 会读取环境变量并初始化全局单例组件
components = handlers.init_server()

# Create dependency container for handlers
dependencies = HandlerDependencies.from_init_server(components)

# Initialize handlers...
# search_handler = SearchHandler(dependencies)
# ...

# 2. 从组件字典中获取调度器实例
# 调度器在 init_server 内部已经被初始化并启动（如果启用了的话）
mem_scheduler: BaseScheduler = components["mem_scheduler"]

# 3. 用户还可以在components中获取其他调度相关组件 (可选，用于自定义任务处理)
# redis_client 用于直接操作 Redis 或监控任务状态
redis_client = components["redis_client"]
# ...
```


## 调度任务与数据模型

调度器通过消息驱动的方式分发和执行任务。本节介绍支持的任务类型、消息结构和执行日志。

### 消息类型与处理器

调度器通过注册特定的任务标签（Label）与处理器（Handler）来分发和执行任务。以下是当前版本（基于 `GeneralScheduler` 和 `OptimizedScheduler`）默认支持的调度任务：

| 消息标签 (Label) | 对应常量 | 处理器方法 | 描述 |
| :--- | :--- | :--- | :--- |
| `query` | `QUERY_TASK_LABEL` | `_query_message_consumer` | 处理用户查询，触发意图识别、记忆检索，并将其转换为记忆更新任务。 |
| `answer` | `ANSWER_TASK_LABEL` | `_answer_message_consumer` | 处理 AI 回复，记录对话日志。 |
| `mem_update` | `MEM_UPDATE_TASK_LABEL` | `_memory_update_consumer` | 核心任务。执行长时记忆的更新流程，包括提取 Query Keyword、更新 Monitor、检索相关记忆并替换工作记忆（Working Memory）。 |
| `add` | `ADD_TASK_LABEL` | `_add_message_consumer` | 处理新记忆的添加日志记录（支持本地和云端日志）。 |
| `mem_read` | `MEM_READ_TASK_LABEL` | `_mem_read_message_consumer` | 使用 `MemReader` 深度处理和导入外部记忆内容。 |
| `mem_organize` | `MEM_ORGANIZE_TASK_LABEL` | `_mem_reorganize_message_consumer` | 触发记忆的重组和合并（Merge）操作。 |
| `pref_add` | `PREF_ADD_TASK_LABEL` | `_pref_add_message_consumer` | 处理用户偏好记忆（Preference Memory）的提取和添加。 |
| `mem_feedback` | `MEM_FEEDBACK_TASK_LABEL` | `_mem_feedback_message_consumer` | 处理用户反馈，用于修正记忆或强化偏好。 |
| `api_mix_search` | `API_MIX_SEARCH_TASK_LABEL` | `_api_mix_search_message_consumer` | (OptimizedScheduler 特有) 执行异步混合搜索任务，结合快速检索与精细检索。 |

### 消息数据结构 (ScheduleMessageItem)

调度器使用统一的 `ScheduleMessageItem` 结构在队列中传递消息。

> **注意**：`mem_cube` 对象本身不直接包含在消息模型中，而是通过 `mem_cube_id` 在运行时由调度器解析。

| 字段 | 类型 | 描述 | 默认值/备注 |
| :--- | :--- | :--- | :--- |
| `item_id` | `str` | 消息唯一标识符 (UUID) | 自动生成 |
| `user_id` | `str` | 关联的用户 ID | (必需) |
| `mem_cube_id` | `str` | 关联的 Memory Cube ID | (必需) |
| `label` | `str` | 任务标签 (如 `query`, `mem_update`) | (必需) |
| `content` | `str` | 消息载荷 (通常为 JSON 字符串或文本) | (必需) |
| `timestamp` | `datetime` | 消息提交时间 | 自动生成 (UTC now) |
| `session_id` | `str` | 会话 ID，用于上下文隔离 | `""` |
| `trace_id` | `str` | 链路追踪 ID，用于全链路日志关联 | 自动生成 |
| `user_name` | `str` | 用户显示名称 | `""` |
| `task_id` | `str` | 业务级任务 ID (用于关联多个消息) | `None` |
| `info` | `dict` | 额外的自定义上下文信息 | `None` |
| `stream_key` | `str` | (内部使用) Redis Stream 的键名 | `""` |

### 执行日志结构 (ScheduleLogForWebItem)

调度器会生成用于前端展示或持久化存储的结构化日志消息。

| 字段 | 类型 | 描述 | 备注 |
| :--- | :--- | :--- | :--- |
| `item_id` | `str` | 日志条目唯一标识符 | 自动生成 |
| `task_id` | `str` | 关联的父任务 ID | 可选 |
| `user_id` | `str` | 用户 ID | (必需) |
| `mem_cube_id` | `str` | Memory Cube ID | (必需) |
| `label` | `str` | 日志类别 (如 `addMessage`, `addMemory`) | (必需) |
| `log_content` | `str` | 简短的日志描述文本 | (必需) |
| `from_memory_type` | `str` | 源记忆区域 | 如 `UserInput`, `LongTermMemory` |
| `to_memory_type` | `str` | 目标记忆区域 | 如 `WorkingMemory` |
| `memcube_log_content` | `list[dict]` | 结构化的详细内容 | 包含具体的记忆文本、引用 ID 等 |
| `metadata` | `list[dict]` | 记忆项元数据 | 包含置信度、状态、标签等 |
| `status` | `str` | 任务状态 | 如 `completed`, `failed` |
| `timestamp` | `datetime` | 日志创建时间 | 自动生成 |
| `current_memory_sizes` | `MemorySizes` | 当前各区域记忆数量快照 | 用于监控面板展示 |
| `memory_capacities` | `MemoryCapacities` | 各区域记忆容量限制 | 用于监控面板展示 |

## 调度功能示例

### 1. 消息处理与自定义 Handler

调度器最强大的功能是支持注册自定义的消息处理器（Handler）。你可以定义特定类型的消息（如 `MY_CUSTOM_TASK`），并编写函数来处理它。

```python
import uuid
from datetime import datetime

# 1. 导入必要的类型定义和调度器实例
# 注意：mem_scheduler 需要从 server_router 导入，因为它是一个全局单例
from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem

# 定义一个自定义的任务标签
MY_TASK_LABEL = "MY_CUSTOM_TASK"


# 定义处理器函数
def my_task_handler(messages: list[ScheduleMessageItem]):
    """
    处理自定义任务的函数
    """
    for msg in messages:
        print(f"⚡️ [Handler] 收到任务: {msg.item_id}")
        print(f"📦 内容: {msg.content}")
        # 在这里执行你的业务逻辑，例如：调用 LLM、写数据库、触发其他任务等


# 2. 注册处理器到调度器
# 这一步将您的自定义逻辑挂载到调度系统中
mem_scheduler.register_handlers({
    MY_TASK_LABEL: my_task_handler
})

# 3. 提交任务
task = ScheduleMessageItem(
    item_id=str(uuid.uuid4()),
    user_id="user_123",
    mem_cube_id="cube_001",
    label=MY_TASK_LABEL,
    content="这是一条测试消息",
    timestamp=datetime.now()
)

# 如果调度器未启动，这里会直接放入队列等待处理（如果是 Redis 队列）
# 或者在本地队列模式下可能需要先调用 mem_scheduler.start()
mem_scheduler.submit_messages([task])

print(f"Task submitted: {task.item_id}")

# 防止调度器主进程提前退出
time.sleep(10)
```

### 2. Redis 队列 vs 本地队列

- **本地队列 (Local Queue)**：
  - **适用场景**：单元测试、简单的单机脚本。
  - **特点**：速度快，但进程重启后数据丢失，不支持多进程/多实例共享。
  - **配置**：`MOS_SCHEDULER_USE_REDIS_QUEUE=false`

- **Redis 队列 (Redis Stream)**：
  - **适用场景**：生产环境、分布式部署。
  - **特点**：数据持久化，支持消费者组（Consumer Group），允许多个调度器实例共同处理任务（负载均衡）。
  - **配置**：`MOS_SCHEDULER_USE_REDIS_QUEUE=true`
  - **调试**：可以使用 `show_redis_status.py` 脚本查看队列堆积情况。

## 综合应用场景

### 场景 1: 基础对话流与记忆更新

以下是一个完善的示例，展示了如何初始化环境、注册自定义逻辑、模拟对话流以及触发记忆更新。

```python
import asyncio
import json
import os
import sys
import time
from pathlib import Path

# --- 环境准备 ---
# 1. 设置项目根目录到 sys.path，确保能导入 memos 模块
FILE_PATH = Path(__file__).absolute()
BASE_DIR = FILE_PATH.parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

# 2. 设置必要的环境变量 (模拟 .env 配置)
os.environ["ENABLE_CHAT_API"] = "true"
os.environ["MOS_ENABLE_SCHEDULER"] = "true"
# 决定使用 Redis 还是 Local 队列
os.environ["MOS_SCHEDULER_USE_REDIS_QUEUE"] = "false"

# --- 导入组件 ---
# 注意：导入 server_router 会触发组件初始化，确保环境变量在此之前设置好
from memos.api.product_models import APIADDRequest, ChatPlaygroundRequest
from memos.api.routers.server_router import (
    add_handler,
    chat_stream_playground,
    mem_scheduler,  # 这里的 mem_scheduler 已经是初始化好的单例
)
from memos.log import get_logger
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    MEM_UPDATE_TASK_LABEL,
    QUERY_TASK_LABEL,
)

logger = get_logger(__name__)

# 全局变量用于演示记忆检索结果
working_memories = []

# --- 自定义处理器 ---

def custom_query_handler(messages: list[ScheduleMessageItem]):
    """
    处理用户查询消息：
    1. 打印查询内容
    2. 将消息转换为 MEM_UPDATE 任务，触发记忆检索/更新流程
    """
    for msg in messages:
        print(f"\n[Scheduler 🟢] 收到用户查询: {msg.content}")

        # 复制消息并将标签改为 MEM_UPDATE，这是一种常见的“任务链”模式
        new_msg = msg.model_copy(update={"label": MEM_UPDATE_TASK_LABEL})

        # 提交新任务回调度器
        mem_scheduler.submit_messages([new_msg])


def custom_mem_update_handler(messages: list[ScheduleMessageItem]):
    """
    处理记忆更新任务：
    1. 使用检索器 (Retriever) 查找相关记忆
    2. 更新全局的工作记忆列表
    """
    global working_memories
    search_args = {}
    top_k = 2

    for msg in messages:
        print(f"[Scheduler 🔵] 正在为查询检索记忆...")
        # 调用核心检索功能
        results = mem_scheduler.retriever.search(
            query=msg.content,
            user_id=msg.user_id,
            mem_cube_id=msg.mem_cube_id,
            mem_cube=mem_scheduler.current_mem_cube,
            top_k=top_k,
            method=mem_scheduler.search_method,
            search_args=search_args,
        )

        # 模拟工作记忆的更新
        working_memories.extend(results)
        working_memories = working_memories[-5:] # 保持最新的5条

        for mem in results:
            # 打印检索到的记忆片段
            print(f"  ↳ [Memory Found]: {mem.memory[:50]}...")

# --- 模拟业务数据 ---

def get_mock_data():
    """生成模拟对话数据"""
    conversations = [
        {"role": "user", "content": "I just adopted a golden retriever puppy named Max."},
        {"role": "assistant", "content": "That's exciting! Max is a great name."},
        {"role": "user", "content": "He loves peanut butter treats but I am allergic to nuts."},
        {"role": "assistant", "content": "Noted. Peanut butter for Max, no nuts for you."},
    ]

    questions = [
        {"question": "What is my dog's name?", "category": "Pet"},
        {"question": "What am I allergic to?", "category": "Allergy"},
    ]
    return conversations, questions

# --- 主流程 ---

async def run_demo():
    print("==== MemScheduler Demo Start ====")
    conversations, questions = get_mock_data()

    user_id = "demo_user_001"
    mem_cube_id = "cube_demo_001"

    print(f"1. 初始化用户记忆库 ({user_id})...")
    # 使用 API Handler 添加初始记忆 (同步模式)
    add_req = APIADDRequest(
        user_id=user_id,
        writable_cube_ids=[mem_cube_id],
        messages=conversations,
        async_mode="sync",
    )
    add_handler.handle_add_memories(add_req)
    print("   记忆添加完成。")

    print("\n2. 开始对话测试 (并在后台触发调度任务)...")
    for item in questions:
        query = item["question"]
        print(f"\n>> User: {query}")

        # 发起聊天请求
        chat_req = ChatPlaygroundRequest(
            user_id=user_id,
            query=query,
            readable_cube_ids=[mem_cube_id],
            writable_cube_ids=[mem_cube_id],
        )

        # 获取流式响应
        response = chat_stream_playground(chat_req)

        # 处理流式输出 (简化版)
        full_answer = ""
        buffer = ""
        async for chunk in response.body_iterator:
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8")
            buffer += chunk
            while "\n\n" in buffer:
                msg, buffer = buffer.split("\n\n", 1)
                for line in msg.split("\n"):
                    if line.startswith("data: "):
                        try:
                            data = json.loads(line[6:])
                            if data.get("type") == "text":
                                full_answer += data["data"]
                        except: pass

        print(f">> AI: {full_answer}")

        # 等待一小会儿让后台调度器处理任务并打印日志
        await asyncio.sleep(1)

if __name__ == "__main__":
    # 1. 注册我们的自定义 Handler
    # 这会覆盖或添加到默认的调度逻辑中
    mem_scheduler.register_handlers(
        {
            QUERY_TASK_LABEL: custom_query_handler,
            MEM_UPDATE_TASK_LABEL: custom_mem_update_handler,
        }
    )

    # 2. 确保调度器已启动
    if not mem_scheduler._running:
        mem_scheduler.start()

    try:
        asyncio.run(run_demo())
    except KeyboardInterrupt:
        pass
    finally:
        # 防止调度器主进程提前退出
        time.sleep(10)

        print("\n==== 停止调度器 ====")
        mem_scheduler.stop()
```

### 场景 2: 异步任务并发与断点重启 (Redis)

该示例展示了如何使用 Redis 队列实现异步任务的并发处理以及断点重启功能。运行此示例需要配置 Redis 环境。

```python
from pathlib import Path
from time import sleep

from memos.api.routers.server_router import mem_scheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


# 调试：打印调度器配置
print("=== Scheduler Configuration Debug ===")
print(f"Scheduler type: {type(mem_scheduler).__name__}")
print(f"Config: {mem_scheduler.config}")
print(f"use_redis_queue: {mem_scheduler.use_redis_queue}")
print(f"Queue type: {type(mem_scheduler.memos_message_queue).__name__}")
print(f"Queue maxsize: {getattr(mem_scheduler.memos_message_queue, 'maxsize', 'N/A')}")
print("=====================================\n")

queue = mem_scheduler.memos_message_queue


# 定义处理函数
def my_test_handler(messages: list[ScheduleMessageItem]):
    print(f"My test handler received {len(messages)} messages: {[one.item_id for one in messages]}")
    for msg in messages:
        # 根据 task_id 创建文件（使用 item_id 作为数字 ID 0..99）
        task_id = str(msg.item_id)
        file_path = tmp_dir / f"{task_id}.txt"
        try:
            sleep(5)
            file_path.write_text(f"Task {task_id} processed.\n")
            print(f"writing {file_path} done")
        except Exception as e:
            print(f"Failed to write {file_path}: {e}")


def submit_tasks():
    mem_scheduler.memos_message_queue.clear()

    # 创建 100 条消息（task_id 0..99）
    users = ["user_A", "user_B"]
    messages_to_send = [
        ScheduleMessageItem(
            item_id=str(i),
            user_id=users[i % 2],
            mem_cube_id="test_mem_cube",
            label=TEST_HANDLER_LABEL,
            content=f"Create file for task {i}",
        )
        for i in range(100)
    ]
    # 批量提交消息并打印完成信息
    print(f"Submitting {len(messages_to_send)} messages to the scheduler...")
    mem_scheduler.memos_message_queue.submit_messages(messages_to_send)
    print(f"Task submission done! tasks in queue: {mem_scheduler.get_tasks_status()}")


# 注册处理函数
TEST_HANDLER_LABEL = "test_handler"
mem_scheduler.register_handlers({TEST_HANDLER_LABEL: my_test_handler})

# 5秒重启
mem_scheduler.orchestrator.tasks_min_idle_ms[TEST_HANDLER_LABEL] = 5_000

tmp_dir = Path("./tmp")
tmp_dir.mkdir(exist_ok=True)

# 测试停止并重启：如果 tmp 中已有 >1 个文件，跳过提交并打印信息
existing_count = len(list(Path("tmp").glob("*.txt"))) if Path("tmp").exists() else 0
if existing_count > 1:
    print(f"Skip submission: found {existing_count} files in tmp (>1), continue processing")
else:
    submit_tasks()

# 6. 等待直到 tmp 有 100 个文件或超时
poll_interval = 1
expected = 100
tmp_dir = Path("tmp")
tasks_status = mem_scheduler.get_tasks_status()
mem_scheduler.print_tasks_status(tasks_status=tasks_status)
while (
    mem_scheduler.get_tasks_status()["remaining"] != 0
    or mem_scheduler.get_tasks_status()["running"] != 0
):
    count = len(list(tmp_dir.glob("*.txt"))) if tmp_dir.exists() else 0
    tasks_status = mem_scheduler.get_tasks_status()
    mem_scheduler.print_tasks_status(tasks_status=tasks_status)
    print(f"[Monitor] Files in tmp: {count}/{expected}")
    sleep(poll_interval)
print(f"[Result] Final files in tmp: {len(list(tmp_dir.glob('*.txt')))})")

# 7. 停止调度器
sleep(20)
print("Stopping the scheduler...")
mem_scheduler.stop()
```
