---
title: 反向查询用户 (Get User Names)
desc: 通过记忆唯一标识符 (ID) 反向查询该条记忆所属的用户名称。
---

**接口路径**：`POST /product/get_user_names_by_memory_ids`
**功能描述**：本接口提供了一种“逆向追踪”能力。当您在系统日志或共享存储中获取到特定的 `memory_id`，但无法确定其产生者时，可以使用此接口批量获取对应的用户名。

## 1. 核心机理：元数据溯源

在 MemOS 的存储架构中，每条生成的记忆条目都与原始用户的元数据绑定。本接口通过以下逻辑执行溯源：

* **多对一映射**：支持一次传入多个 `memory_id`，系统将返回对应的用户列表。
* **管理透明度**：该工具通常用于管理后台，帮助管理员识别公共 Cube 中不同条目的贡献者。



## 2. 关键接口参数

请求体定义如下：

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`memory_ids`** | `list[str]` | 是 | 待查询的记忆唯一标识符列表。 |

## 3. 工作原理 (MemoryHandler)

1. **ID 解析**：**MemoryHandler** 接收 ID 列表后，查询全局索引表。
2. **关系检索**：系统从底层的持久化层（或关系图谱节点）中提取关联的 `user_id` 或 `user_name` 属性。
3. **数据脱敏**：根据系统配置，返回对应的用户显示名称或标识符。

## 4. 快速上手示例

使用 SDK 执行反向查询：

```python
from memos.api.client import MemOSClient

client = MemOSClient(api_key="...", base_url="...")

# 准备待查的记忆 ID 列表
target_ids = [
    "2f40be8f-736c-4a5f-aada-9489037769e0",
    "5e92be1a-826d-4f6e-97ce-98b699eebb98"
]

# 执行查询
res = client.get_user_names_by_memory_ids(memory_ids=target_ids)

if res and res.code == 200:
    # res.data 通常返回一个映射字典或用户列表
    print(f"该记忆片段归属于用户: {res.data}")
```
