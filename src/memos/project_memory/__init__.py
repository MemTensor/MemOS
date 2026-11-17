"""项目记忆（Project Memory）：MemOS 新增的一种记忆 view（`project`）。

口径：基于 MemOS 现有能力实现，不另起一套存储。Space 对应一个 mem_cube，
主题 / 决策 / 经验都是 `Memory` 表里的一行，靠 `properties.memory_type` 区分。

模块：
- `types`      数据结构（决策、经验、主题、动作）
- `judge`      判定与生成的统一接口 judge() / write()，后端可换（mock 现可用）
- `episode`    段切分（决策与经验共用）
- `decision`   抽取 → 同类识别 → 冲突识别与解决 + 按动作落库
- `experience` 规则闸 → 过滤 → 抽卡片 → 合并
- `store`      存进 Memory 节点（GraphProjectStore / InMemoryProjectStore）
- `pipeline`   主干（add → 整理 → 落库；search → topic_detail_list）
- `plugin`     插件入口，照 Dream 的形状（需要 memos.plugins，故延迟导入）

延迟导入插件，是为了让算法与存储这几层能脱离完整 MemOS 依赖单独跑（见 demo_mock_add）。
"""

from typing import Any


__all__ = ["CommunityProjectMemoryPlugin"]


def __getattr__(name: str) -> Any:
    if name == "CommunityProjectMemoryPlugin":
        from memos.project_memory.plugin import CommunityProjectMemoryPlugin

        return CommunityProjectMemoryPlugin
    raise AttributeError(name)
