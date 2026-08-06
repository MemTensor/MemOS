---
title: 删除记忆 (Delete Memory)
desc: 从指定的 MemCube 中永久移除记忆条目、关联文件或符合特定过滤条件的记忆集合。
---

**接口路径**：`POST /product/delete_memory`
**功能描述**：本接口用于维护记忆库的准确性与合规性。当用户要求遗忘特定信息、数据过时或需要清理特定的上传文件时，可以通过此接口在向量数据库与图数据库中同步执行物理删除。

## 1. 核心机理：Cube 级物理清理

在开源版中，删除操作遵循严格的 **MemCube** 隔离逻辑：

* **作用域限制**：通过 `writable_cube_ids` 参数，删除操作被严格锁定在指定的记忆体中，绝不会误删其他 Cube 的内容。
* **多维删除**：支持按 **记忆 ID**（精确）、**文件 ID**（关联删除）以及 **Filter 过滤器**（条件逻辑）三种维度并发执行清理。
* **原子性同步**：删除操作由 **MemoryHandler** 触发，确保底层向量索引与图数据库中的实体节点同步移除，防止召回“幻觉”。



## 2. 关键接口参数
核心参数定义如下：

| 参数名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| **`writable_cube_ids`** | `list[str]` | 是 | 指定执行删除操作的目标 Cube 列表。 |
| **`memory_ids`** | `list[str]` | 否 | 待删除的记忆唯一标识符列表。 |
| **`file_ids`** | `list[str]` | 否 | 待删除的原始文件标识符列表，将同步清理该文件产生的全部记忆。 |
| **`filter`** | `object` | 否 | 逻辑过滤器。支持按标签、元信息或时间戳批量删除符合条件的记忆。 |

## 3. 工作原理 (MemoryHandler)

1. **权限与路由**：系统通过 `user_id` 校验操作权限，并将请求路由至 **MemoryHandler**。
2. **定位存储**：根据 `writable_cube_ids` 定位底层的 **naive_mem_cube** 组件。
3. **分发清理任务**：
    * **按 ID 清理**：直接根据 UUID 在主数据库和向量库中执行记录抹除。
    * **按 Filter 清理**：先检索出符合条件的记忆 ID 集合，再执行批量物理移除。
4. **状态反馈**：操作完成后返回成功状态，相关内容将立即从 [**检索接口**](./search_memory.md) 的召回范围中消失。

## 4. 快速上手示例

使用 `MemOSClient` 执行不同维度的删除操作：

```python
# 初始化客户端
client = MemOSClient(api_key="...", base_url="...")

# 场景一：精确删除单条已知的错误记忆
client.delete_memory(
    writable_cube_ids=["user_01_private"],
    memory_ids=["2f40be8f-736c-4a5f-aada-9489037769e0"]
)

# 场景二：批量清理某一特定标签下的所有过时记忆
client.delete_memory(
    writable_cube_ids=["kb_finance_2026"],
    filter={"tags": {"contains": "deprecated_policy"}}
)
```
## 5. 注意事项

不可恢复性：删除操作是物理删除。一旦执行成功，该记忆将无法再通过检索接口召回。

文件关联性：通过 `file_ids` 删除时，系统会自动溯源并清理该文件解析出的事实记忆和摘要。
