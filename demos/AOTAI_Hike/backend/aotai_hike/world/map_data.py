from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from aotai_hike.schemas import AoTaiEdge, AoTaiNode


# NOTE: This is a demo-scale AoTai graph with key landmarks + branches.
# It is not a precise topo map, but it encodes the core "mainline + bailout" structure.


NODES: dict[str, AoTaiNode] = {
    # Start
    "start": AoTaiNode(
        node_id="start",
        name="塘口起点",
        altitude_m=2350,
        scene_id="trailhead",
        hint="补给检查，确认队伍状态。",
        x=5,
        y=55,
        kind="start",
    ),
    # Mainline
    "slope_forest": AoTaiNode(
        node_id="slope_forest",
        name="林间缓坡",
        altitude_m=2550,
        scene_id="forest",
        hint="树影摇晃，风开始大了。",
        x=18,
        y=55,
        kind="main",
    ),
    "camp_2800": AoTaiNode(
        node_id="camp_2800",
        name="2800营地",
        altitude_m=2800,
        scene_id="camp",
        hint="常见营地节点，可休整/扎营，也可能下撤。",
        x=30,
        y=45,
        kind="camp",
    ),
    "stone_sea": AoTaiNode(
        node_id="stone_sea",
        name="石海边缘",
        altitude_m=2900,
        scene_id="stone",
        hint="碎石路更耗体力，注意脚下。",
        x=42,
        y=55,
        kind="main",
    ),
    "ridge_wind": AoTaiNode(
        node_id="ridge_wind",
        name="风口山脊",
        altitude_m=3150,
        scene_id="ridge",
        hint="能见度下降，队形别散。",
        x=55,
        y=45,
        kind="junction",
    ),
    "da_ye_hai": AoTaiNode(
        node_id="da_ye_hai",
        name="大爷海",
        altitude_m=3250,
        scene_id="lake",
        hint="关键地标，天气变化快。",
        x=66,
        y=55,
        kind="lake",
    ),
    "ba_xian_tai": AoTaiNode(
        node_id="ba_xian_tai",
        name="拔仙台（太白最高点）",
        altitude_m=3767,
        scene_id="summit",
        hint="海拔最高点，谨慎推进。",
        x=82,
        y=45,
        kind="peak",
    ),
    "end_exit": AoTaiNode(
        node_id="end_exit",
        name="下撤终点",
        altitude_m=3200,
        scene_id="end",
        hint="抵达终点，整理记忆。",
        x=95,
        y=55,
        kind="end",
    ),
    # Bailout / branch nodes
    "bailout_2800": AoTaiNode(
        node_id="bailout_2800",
        name="2800下撤口",
        altitude_m=2700,
        scene_id="end",
        hint="从 2800营地下撤的出口（demo）。",
        x=30,
        y=70,
        kind="exit",
    ),
    "bailout_ridge": AoTaiNode(
        node_id="bailout_ridge",
        name="山脊下撤口",
        altitude_m=3000,
        scene_id="end",
        hint="山脊处紧急下撤节点（demo）。",
        x=55,
        y=70,
        kind="exit",
    ),
}


EDGES: list[AoTaiEdge] = [
    AoTaiEdge(from_node_id="start", to_node_id="slope_forest", kind="main", label="进入山林"),
    AoTaiEdge(from_node_id="slope_forest", to_node_id="camp_2800", kind="main", label="上到2800"),
    AoTaiEdge(from_node_id="camp_2800", to_node_id="stone_sea", kind="main", label="继续主线"),
    AoTaiEdge(from_node_id="stone_sea", to_node_id="ridge_wind", kind="main", label="上山脊"),
    AoTaiEdge(from_node_id="ridge_wind", to_node_id="da_ye_hai", kind="main", label="去大爷海"),
    AoTaiEdge(from_node_id="da_ye_hai", to_node_id="ba_xian_tai", kind="main", label="冲顶"),
    AoTaiEdge(from_node_id="ba_xian_tai", to_node_id="end_exit", kind="main", label="下撤"),
    # Branches / exits
    AoTaiEdge(from_node_id="camp_2800", to_node_id="bailout_2800", kind="exit", label="下撤"),
    AoTaiEdge(from_node_id="ridge_wind", to_node_id="bailout_ridge", kind="exit", label="紧急下撤"),
]


@dataclass(frozen=True)
class AoTaiGraph:
    start_node_id: ClassVar[str] = "start"

    @staticmethod
    def get_node(node_id: str) -> AoTaiNode:
        return NODES[node_id]

    @staticmethod
    def nodes() -> list[AoTaiNode]:
        return list(NODES.values())

    @staticmethod
    def edges() -> list[AoTaiEdge]:
        return list(EDGES)

    @staticmethod
    def outgoing(node_id: str) -> list[AoTaiEdge]:
        return [e for e in EDGES if e.from_node_id == node_id]

    @staticmethod
    def next_node_ids(node_id: str) -> list[str]:
        return [e.to_node_id for e in AoTaiGraph.outgoing(node_id)]
