---
title: 任务调度与状态监控 (Scheduler Status)
desc: 监控 MemOS 异步任务的生命周期，提供包括任务进度、队列积压及系统负载在内的全方位观测能力。
---

**接口路径**：
* **系统级概览**：`GET /product/scheduler/allstatus`
* **任务进度查询**：`GET /product/scheduler/status`
* **用户队列指标**：`GET /product/scheduler/task_queue_status`

**功能描述**：本模块接口旨在为开发者提供异步记忆生产链路的可观测性。通过这些接口，您可以实时追踪特定任务的完成状态，监控 Redis 任务队列的积压情况，以及获取整个调度系统的运行指标。

## 1. 核心机理：MemScheduler 调度体系

在开源架构中，**MemScheduler** 负责处理所有高耗时的后台任务（如 LLM 记忆提取、向量索引构建等）：

* **状态流转**：任务在生命周期内会经历 `waiting` (等待中)、`in_progress` (执行中)、`completed` (已完成) 或 `failed` (失败) 等状态。
* **队列监控**：系统基于 Redis Stream 实现任务分发。通过监控 `pending` (已交付未确认) 和 `remaining` (排队中) 任务数，可以评估系统的处理压力。
* **多维度观测**：支持从“单任务”、“单用户队列”以及“全系统 summary”三个维度进行状态透视。


## 2. 接口详解

### 2.1 任务进度查询 (`/status`)
用于追踪特定异步任务的当前执行阶段。

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | 是 | 请求查询的用户唯一标识符。 |
| `task_id` | `str` | 否 | 可选。若提供，则仅查询该特定任务的状态。 |

**返回状态说明**：
* `waiting`: 任务已进入队列，等待空闲 Worker 执行。
* `in_progress`: Worker 正在调用大模型提取记忆或写入数据库。
* `completed`: 记忆已成功持久化并完成向量索引同步。
* `failed`: 任务失败。

### 2.2 用户队列指标 (`/task_queue_status`)
用于监控指定用户在 Redis 中的任务积压情况。

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`user_id`** | `str` | 是 | 需查询队列状况的用户 ID。 |

**核心指标项**：
* `pending_tasks_count`: 已分发给 Worker 但尚未收到确认（Ack）的任务数。
* `remaining_tasks_count`: 当前仍在队列中排队等待分配的任务总数。
* `stream_keys`: 匹配到的 Redis Stream 键名列表。

### 2.3 系统级概览 (`/allstatus`)
获取调度器的全局运行概况，通常用于管理员后台监控。

* **核心返回信息**：
    * `scheduler_summary`: 包含系统当前的负载与健康状况。
    * `all_tasks_summary`: 所有正在运行及排队任务的聚合统计。

## 3. 工作原理 (SchedulerHandler)

当您发起状态查询请求时，**SchedulerHandler** 会执行以下操作：

1. **缓存检索**：首先从 Redis 状态缓存中查找 `task_id` 对应的实时进度。
2. **队列确认**：若查询队列指标，Handler 会调用 Redis 统计指令（如 `XLEN`, `XPENDING`）分析 Stream 状态。
3. **指标聚合**：对于全局状态请求，Handler 会汇总所有活跃节点的指标，生成系统级的 summary 数据。

## 4. 快速上手示例

使用 SDK 轮询任务状态直至完成：

```python
from memos.api.client import MemOSClient
import time

client = MemOSClient(api_key="...", base_url="...")

# 1. 系统级概览：查看整个 MemOS 系统的运行健康度
global_res = client.get_all_scheduler_status()
if global_res:
    print(f"系统运行概况: {global_res.data['scheduler_summary']}")

# 2. 队列指标监控：检查特定用户的任务积压情况
queue_res = client.get_task_queue_status(user_id="dev_user_01")
if queue_res:
    print(f"待处理任务数: {queue_res.data['remaining_tasks_count']}")
    print(f"已下发未完成任务数: {queue_res.data['pending_tasks_count']}")

# 3. 任务进度追踪：轮询特定任务直至结束
task_id = "task_888999"
while True:
    res = client.get_task_status(user_id="dev_user_01", task_id=task_id)
    if res and res.code == 200:
        current_status = res.data[0]['status'] # data 为状态列表
        print(f"任务 {task_id} 当前状态: {current_status}")

        if current_status in ['completed', 'failed', 'cancelled']:
            break
    time.sleep(2)
```
