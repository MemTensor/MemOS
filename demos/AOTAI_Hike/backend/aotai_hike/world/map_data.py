from __future__ import annotations

from aotai_hike.schemas import AoTaiNode


AO_TAI_NODES: list[AoTaiNode] = [
    AoTaiNode(
        node_id="start",
        name="塘口起点",
        altitude_m=2350,
        scene_id="trailhead",
        hint="补给检查，确认队伍状态。",
    ),
    AoTaiNode(
        node_id="forest",
        name="林间缓坡",
        altitude_m=2550,
        scene_id="forest",
        hint="树影摇晃，风开始大了。",
    ),
    AoTaiNode(
        node_id="stone_river",
        name="石海边缘",
        altitude_m=2900,
        scene_id="stone",
        hint="碎石路更耗体力，注意脚下。",
    ),
    AoTaiNode(
        node_id="ridge_1",
        name="风口山脊",
        altitude_m=3150,
        scene_id="ridge",
        hint="能见度下降，队形别散。",
    ),
    AoTaiNode(
        node_id="camp_1", name="临时营地", altitude_m=3050, scene_id="camp", hint="适合扎营或短休。"
    ),
    AoTaiNode(
        node_id="lake",
        name="大爷海（远眺）",
        altitude_m=3250,
        scene_id="lake",
        hint="湖面雾气，心情容易波动。",
    ),
    AoTaiNode(
        node_id="ridge_2",
        name="拔仙台方向",
        altitude_m=3500,
        scene_id="highridge",
        hint="海拔上升，呼吸变急促。",
    ),
    AoTaiNode(
        node_id="snowline",
        name="雪线附近",
        altitude_m=3600,
        scene_id="snow",
        hint="风雪随时可能来。",
    ),
    AoTaiNode(
        node_id="taibai_ridge",
        name="太白梁",
        altitude_m=3700,
        scene_id="summit",
        hint="最后一段，别硬撑。",
    ),
    AoTaiNode(
        node_id="end", name="下撤终点", altitude_m=3200, scene_id="end", hint="抵达终点，整理记忆。"
    ),
]
