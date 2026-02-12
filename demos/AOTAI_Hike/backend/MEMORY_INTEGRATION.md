# 游戏系统与记忆系统交互说明（AoTai Hike）

本文说明 AoTai Hike 中游戏系统与记忆系统的交互方式，并给出关键代码位置。

## 总体流程概览

一次 `act` 的主链路如下：

1. 游戏处理阶段门控与动作执行（更新世界状态）。
2. 写入世界事件记忆（world cube）。
3. 检索世界记忆，作为 NPC 对话上下文。
4. 若触发 NPC 对话：
   - 每个 NPC 检索自身记忆（role cube）
   - 调用 chat 生成回复
   - 将对话写回角色记忆
5. 写入 `chat_history` 供后续对话使用。

## 关键交互点与代码位置

### 1) 游戏事件写入（world 记忆）

- 位置：`GameService.act`
- 作用：把本轮事件结构化写入记忆系统（world cube）

代码位置：
- `demos/AOTAI_Hike/backend/aotai_hike/services/game_service.py`
  - `GameService.act()` 内：
    - `mem_event = self._format_memory_event(...)`
    - `self._memory.add_event(...)`

### 2) 世界记忆检索（world 记忆）

- 位置：`GameService.act`
- 作用：为 NPC 对话提供全局上下文

代码位置：
- `demos/AOTAI_Hike/backend/aotai_hike/services/game_service.py`
  - `mem_res = self._memory.search(...)`

### 3) NPC 对话（角色记忆检索 + chat + 回写）

- 位置：`MemoryCompanionBrain._generate_role_reply`
- 作用：每个 NPC 走完整记忆链路生成发言

代码位置：
- `demos/AOTAI_Hike/backend/aotai_hike/adapters/companion.py`
  - `self._memory.search_memory(...)` 角色记忆检索
  - `self._memory.chat_complete(...)` 调用算法 chat
  - `self._memory.add_memory(...)` 写回角色记忆

### 4) 记忆命名空间（cube_id）

- 位置：`MemoryNamespace`
- 规则：
  - 角色记忆：`cube_{user_id}_{role_id}`
  - 世界记忆：`cube_{user_id}_world`

代码位置：
- `demos/AOTAI_Hike/backend/aotai_hike/adapters/memory.py`

### 5) 记忆适配与客户端

- 位置：`MemOSMemoryClient` / `MemOSMemoryAdapter`
- 作用：封装 MemOS `/product/add`、`/product/search`、`/product/chat/complete`

代码位置：
- `demos/AOTAI_Hike/backend/aotai_hike/adapters/memory.py`

### 6) 对话历史记录

- 位置：`GameService._append_chat_history`
- 作用：将系统/发言消息转为 `chat_history`，供后续对话使用

代码位置：
- `demos/AOTAI_Hike/backend/aotai_hike/services/game_service.py`

## 算法回放脚本（调试用）

脚本 `algorithm_tuning.py` 以 1:1 的方式调用 `GameService.act`，并打印记忆/对话日志：

- `demos/AOTAI_Hike/backend/aotai_hike/scripts/algorithm_tuning.py`

常用参数：
- `--user-id`：指定用户
- `--base-url`：MemOS 服务地址
- `--log-world-search`：打印 world 搜索
- `--log-full-prompt`：打印完整 prompt

## 简要链路图

```
GameService.act
  ├─ add_event (world add)
  ├─ search (world search)
  └─ MemoryCompanionBrain.generate
        ├─ search_memory (role search)
        ├─ chat_complete (LLM)
        └─ add_memory (role add)
```

## 多视角记忆集成

本游戏完整集成了 MemOS 的多视角记忆系统，实现了每个角色拥有独立记忆空间、从角色视角提取记忆的功能。

**详细文档**：
- [多视角记忆集成 PR 文档](../PR_MULTI_VIEW_MEMORY_INTEGRATION.md) - 完整的技术实现说明
- [PR 摘要](../PR_SUMMARY.md) - 快速概览

**核心特性**：
- ✅ 自动多视角模式检测（通过 `role_id` 和 `role_name` 字段）
- ✅ 角色记忆隔离（每个角色独立的记忆空间）
- ✅ 第一人称视角记忆提取
- ✅ 基于记忆的智能 NPC 对话生成
