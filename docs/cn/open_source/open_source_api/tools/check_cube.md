---
title: 检查 MemCube 存在性 (Check Cube Existence)
desc: 校验指定的 MemCube ID 是否已在系统中初始化并可用。
---

**接口路径**：`POST /product/exist_mem_cube_id`
**功能描述**：本接口用于验证指定的 `mem_cube_id` 是否已经存在于系统中。它是确保数据一致性的“守门员”接口，建议在动态创建知识库或为新用户分配空间前调用，以避免重复初始化或无效操作。

## 1. 核心机理：Cube 索引校验

在 MemOS 架构中，MemCube 的存在性决定了后续所有记忆操作的合法性：

* **逻辑校验**：系统通过 **MemoryHandler** 检索底层存储索引，确认该 ID 是否已注册。
* **冷启动保障**：对于按需创建 Cube 的场景，该接口可用于判断是否需要执行初次 `add` 操作来激活记忆空间。



## 2. 关键接口参数
请求体定义如下：

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`mem_cube_id`** | `str` | 是 | 待校验的 MemCube 唯一标识符。 |

## 3. 工作原理 (MemoryHandler)

1. **直通索引**：**MemoryHandler** 接收请求后，直接调用底层 **naive_mem_cube** 的元数据查询接口。
2. **状态检索**：系统在持久化层中查找该 ID 对应的配置文件或数据库记录。
3. **布尔反馈**：返回结果不包含记忆内容，仅以 `code` 或 `data` 形式告知该 Cube 是否已激活。

## 4. 快速上手示例

使用 SDK 校验目标 Cube 状态：

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# 场景：在导入文档前确认目标知识库已创建
kb_id = "kb_finance_2026"
res = client.exist_mem_cube_id(mem_cube_id=kb_id)

if res and res.code == 200:
    # 假设 data 字段返回布尔值或存在性对象
    if res.data.get('exists'):
        print(f"✅ MemCube '{kb_id}' 已就绪。")
    else:
        print(f"❌ MemCube '{kb_id}' 尚未初始化。")
```
