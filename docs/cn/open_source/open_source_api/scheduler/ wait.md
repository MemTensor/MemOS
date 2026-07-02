---
title: 高级任务同步 (Advanced Task Synchronization)
desc: 提供阻塞等待与流式进度观测能力，确保在执行后续操作前，指定用户的异步任务已全部处理完成。
---


**接口路径**：
* **同步阻塞等待**：`POST /product/scheduler/wait`
* **实时进度流 (SSE)**：`GET /product/scheduler/wait/stream`

**功能描述**：在自动化脚本、数据迁移或集成测试场景中，通常需要确保所有的异步记忆提取任务（如 LLM 事实提取、向量入库）已完全结束。本模块接口允许客户端“挂起”请求，直到调度器检测到目标用户的任务队列已清空。

## 1. 核心机理：调度器空闲检测

系统通过 **SchedulerHandler** 实时监控底层 **MemScheduler** 的运行状态：

* **队列检查**：系统会检查 Redis Stream 中属于该用户的待处理任务（Pending）及排队任务（Remaining）。
* **空闲判定**：仅当队列计数为 0 且当前没有 Worker 正在执行该用户的任务时，判定为“空闲 (Idle)”。
* **超时保护**：为防止无限期阻塞，接口支持设置 `timeout_seconds`。若达到上限任务仍未完成，接口将返回当前状态并停止等待。



## 2. 关键接口参数

这两个接口共享以下查询参数（Query Parameters）：

| 参数名 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| **`user_name`** | `str` | 是 | - | 目标用户的名称或 ID。 |
| `timeout_seconds`| `num` | 否 | - | 最大等待时长（秒）。超过此时间将自动返回。 |
| `poll_interval` | `num` | 否 | - | 内部检查队列状态的频率（秒）。 |

## 3. 响应模式选型

### 3.1 同步阻塞模式 (`/wait`)
* **特点**：标准的 HTTP 响应。连接会保持开启，直到任务清空或超时。
* **场景**：编写自动化测试脚本或在执行 `search` 前确保数据已入库。

### 3.2 实时流模式 (`/wait/stream`)
* **特点**：基于 **Server-Sent Events (SSE)** 技术。
* **场景**：在管理后台展示动态进度条，实时显示任务队列的缩减过程。

## 4. 快速上手示例

使用开源版 SDK 进行阻塞式等待：

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")
user_name = "dev_user_01"

# --- 场景 A：同步阻塞等待 (常用于 Python 自动化脚本) ---
print(f"正在等待用户 {user_name} 的任务队列清空...")
res = client.wait_until_idle(
    user_name=user_name,
    timeout_seconds=300,
    poll_interval=2
)
if res and res.code == 200:
    print("✅ 任务已全部完成。")

# --- 场景 B：流式进度观测 (常用于前端进度条渲染) ---
print("开始监听任务实时进度流...")
# 注意：SSE 接口在 SDK 中通常返回一个生成器 (Generator)
progress_stream = client.stream_scheduler_progress(
    user_name=user_name,
    timeout_seconds=300
)

for event in progress_stream:
    # 实时打印剩余任务数
    print(f"当前排队任务数: {event['remaining_tasks_count']}")
    if event['status'] == 'idle':
        print("🎉 调度器已空闲")
        break
```
