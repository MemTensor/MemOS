"""
Kilimanjaro trek map (Conquer Kilimanjaro theme).
Same node_id / edge structure as AoTai for game logic compatibility;
names and labels are Kilimanjaro-themed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import ClassVar

from aotai_hike.schemas import AoTaiEdge, AoTaiNode


# Same node_ids as AoTai (start, slope_forest, camp_2800, ...) for phase/terminal logic.
# Names and hints are Kilimanjaro route themed (Marangu / Machame style).
KILIMANJARO_NODES: dict[str, AoTaiNode] = {
    "start": AoTaiNode(
        node_id="start",
        name="Marangu Gate",
        altitude_m=1879,
        scene_id="trailhead",
        hint="Gear check, team briefing.",
        x=5,
        y=55,
        kind="start",
    ),
    "slope_forest": AoTaiNode(
        node_id="slope_forest",
        name="Forest Trail",
        altitude_m=2700,
        scene_id="forest",
        hint="Dense forest, humidity rises.",
        x=18,
        y=55,
        kind="main",
    ),
    "camp_2800": AoTaiNode(
        node_id="camp_2800",
        name="Mandara Hut",
        altitude_m=2720,
        scene_id="camp",
        hint="First camp, rest or evacuate from here.",
        x=30,
        y=45,
        kind="camp",
    ),
    "stone_sea": AoTaiNode(
        node_id="stone_sea",
        name="Moorland Zone",
        altitude_m=3200,
        scene_id="stone",
        hint="Rocky terrain, pace yourself.",
        x=42,
        y=55,
        kind="main",
    ),
    "ridge_wind": AoTaiNode(
        node_id="ridge_wind",
        name="Horombo / Saddle",
        altitude_m=3720,
        scene_id="ridge",
        hint="Wind exposure, stay together.",
        x=55,
        y=45,
        kind="junction",
    ),
    "da_ye_hai": AoTaiNode(
        node_id="da_ye_hai",
        name="Kibo Hut",
        altitude_m=4703,
        scene_id="lake",
        hint="Summit push base, weather can change fast.",
        x=66,
        y=55,
        kind="lake",
    ),
    "ba_xian_tai": AoTaiNode(
        node_id="ba_xian_tai",
        name="Uhuru Peak",
        altitude_m=5895,
        scene_id="summit",
        hint="Summit. Proceed with care.",
        x=82,
        y=45,
        kind="peak",
    ),
    "end_exit": AoTaiNode(
        node_id="end_exit",
        name="Descent Finish",
        altitude_m=1879,
        scene_id="end",
        hint="Trek complete, memories saved.",
        x=95,
        y=55,
        kind="end",
    ),
    "bailout_2800": AoTaiNode(
        node_id="bailout_2800",
        name="Mandara Evacuation",
        altitude_m=2720,
        scene_id="end",
        hint="Evacuation from Mandara Hut (demo).",
        x=30,
        y=70,
        kind="exit",
    ),
    "bailout_ridge": AoTaiNode(
        node_id="bailout_ridge",
        name="Horombo Evacuation",
        altitude_m=3720,
        scene_id="end",
        hint="Emergency evacuation from saddle (demo).",
        x=55,
        y=70,
        kind="exit",
    ),
}

KILIMANJARO_EDGES: list[AoTaiEdge] = [
    AoTaiEdge(
        from_node_id="start",
        to_node_id="slope_forest",
        kind="main",
        label="Enter forest",
        distance_km=4.0,
    ),
    AoTaiEdge(
        from_node_id="slope_forest",
        to_node_id="camp_2800",
        kind="main",
        label="To Mandara",
        distance_km=6.0,
    ),
    AoTaiEdge(
        from_node_id="camp_2800",
        to_node_id="stone_sea",
        kind="main",
        label="Continue main route",
        distance_km=4.0,
    ),
    AoTaiEdge(
        from_node_id="stone_sea",
        to_node_id="ridge_wind",
        kind="main",
        label="To saddle",
        distance_km=6.0,
    ),
    AoTaiEdge(
        from_node_id="ridge_wind",
        to_node_id="da_ye_hai",
        kind="main",
        label="To Kibo Hut",
        distance_km=3.0,
    ),
    AoTaiEdge(
        from_node_id="da_ye_hai",
        to_node_id="ba_xian_tai",
        kind="main",
        label="Summit push",
        distance_km=8.0,
    ),
    AoTaiEdge(
        from_node_id="ba_xian_tai",
        to_node_id="end_exit",
        kind="main",
        label="Descent",
        distance_km=10.0,
    ),
    AoTaiEdge(
        from_node_id="camp_2800",
        to_node_id="bailout_2800",
        kind="exit",
        label="Evacuate",
        distance_km=7.0,
    ),
    AoTaiEdge(
        from_node_id="ridge_wind",
        to_node_id="bailout_ridge",
        kind="exit",
        label="Emergency evacuate",
        distance_km=9.0,
    ),
]


@dataclass(frozen=True)
class KilimanjaroGraph:
    start_node_id: ClassVar[str] = "start"

    @staticmethod
    def get_node(node_id: str) -> AoTaiNode:
        return KILIMANJARO_NODES[node_id]

    @staticmethod
    def nodes() -> list[AoTaiNode]:
        return list(KILIMANJARO_NODES.values())

    @staticmethod
    def edges() -> list[AoTaiEdge]:
        return list(KILIMANJARO_EDGES)

    @staticmethod
    def outgoing(node_id: str) -> list[AoTaiEdge]:
        return [e for e in KILIMANJARO_EDGES if e.from_node_id == node_id]

    @staticmethod
    def next_node_ids(node_id: str) -> list[str]:
        return [e.to_node_id for e in KilimanjaroGraph.outgoing(node_id)]
