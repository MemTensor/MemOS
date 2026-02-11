"""
Independent module for generating share images when the game ends (success or failure).
Generates pixel-style images showing character config, route, journey, distance, outcome, and current location.
"""

from __future__ import annotations

import io
import json

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from aotai_hike.world.map_data import AoTaiGraph
from PIL import Image, ImageDraw, ImageFont


if TYPE_CHECKING:
    from aotai_hike.schemas import Role, WorldState


def _node_exists(node_id: str) -> bool:
    """Check if a node exists in the graph."""
    try:
        AoTaiGraph.get_node(node_id)
        return True
    except Exception:
        return False


@dataclass
class GameOutcome:
    """Game outcome information."""

    is_success: bool
    outcome_type: str  # "cross_success" or "retreat_success" or "failure" or "in_progress"
    total_distance_km: float
    current_node_id: str
    current_node_name: str
    days_spent: int
    roles: list[Role]
    visited_nodes: list[str]
    journey_summary: dict[str, Any]
    is_finished: bool = False  # Whether the game has ended
    failure_reason: str | None = None  # Detailed failure reason if game failed


class ShareImageGenerator:
    """Generate pixel-style share images for game completion."""

    # Pixel art style constants
    # Keep share card at strict 3:4 (WIDTH : HEIGHT) to match frontend modal
    # and the 3:4 background asset in `frontend/assets/share_background.png`.
    WIDTH = 1024
    HEIGHT = 1365
    PIXEL_SIZE = 4  # Scale factor for pixel art effect
    BG_COLOR = (240, 240, 230)
    TEXT_COLOR = (40, 40, 40)
    ACCENT_COLOR = (100, 150, 200)
    SUCCESS_COLOR = (80, 180, 100)
    FAILURE_COLOR = (200, 100, 100)

    def __init__(self):
        """Initialize the generator."""
        self._font_cache: dict[str, ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

    def _get_font(self, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        """Get or create a font of the specified size that supports Chinese characters."""
        if size not in self._font_cache:
            # Try common Chinese fonts on different platforms
            font_paths = [
                # macOS
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/STHeiti Light.ttc",
                "/System/Library/Fonts/STHeiti Medium.ttc",
                "/System/Library/Fonts/Supplemental/Songti.ttc",
                # Linux
                "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
                "/usr/share/fonts/truetype/arphic/uming.ttc",
                # Windows (common paths)
                "C:/Windows/Fonts/msyh.ttc",  # Microsoft YaHei
                "C:/Windows/Fonts/simhei.ttf",  # SimHei
                "C:/Windows/Fonts/simsun.ttc",  # SimSun
            ]

            font_loaded = False
            for font_path in font_paths:
                try:
                    # For .ttc files, we need to specify index (0 for first font)
                    if font_path.endswith(".ttc"):
                        self._font_cache[size] = ImageFont.truetype(font_path, size, index=0)
                    else:
                        self._font_cache[size] = ImageFont.truetype(font_path, size)
                    font_loaded = True
                    break
                except Exception:
                    continue

            if not font_loaded:
                # Last resort: try to use default font (may not support Chinese)
                try:
                    self._font_cache[size] = ImageFont.load_default()
                except Exception:
                    # If all else fails, create a basic font
                    self._font_cache[size] = ImageFont.load_default()
        return self._font_cache[size]

    def generate(
        self, world_state: WorldState, outcome: GameOutcome
    ) -> tuple[bytes, dict[str, Any]]:
        """
        Generate a share image and return both the image bytes and structured JSON data.

        Returns:
            tuple[bytes, dict]: (image_bytes, structured_json_data)
        """
        # Create base image: try to use share_background.png, fallback to solid color
        img = None
        try:
            # Backend dir: demos/AOTAI_Hike/backend/aotai_hike/utils/share_image.py
            # Frontend assets: demos/AOTAI_Hike/frontend/assets/share_background.png
            root = Path(__file__).resolve().parents[3]
            bg_path = root / "frontend" / "assets" / "share_background.png"
            if bg_path.is_file():
                bg = Image.open(bg_path).convert("RGB")
                # Use NEAREST to keep a clear pixel-art look (avoid smoothing)
                bg = bg.resize((self.WIDTH, self.HEIGHT), Image.NEAREST)
                img = bg
        except Exception:
            img = None

        if img is None:
            img = Image.new("RGB", (self.WIDTH, self.HEIGHT), self.BG_COLOR)

        # Convert to RGBA and add a semi-transparent panel behind text
        img = img.convert("RGBA")
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
        # Slightly more transparent paper-like panel
        panel_color = (240, 240, 230, 190)  # light beige with alpha
        # Leave margins so background is still visible
        panel_margin_x = 40
        panel_margin_top = 50
        panel_margin_bottom = 50
        panel_rect = (
            panel_margin_x,
            panel_margin_top,
            self.WIDTH - panel_margin_x,
            self.HEIGHT - panel_margin_bottom,
        )
        overlay_draw = ImageDraw.Draw(overlay)
        overlay_draw.rectangle(panel_rect, fill=panel_color)
        img = Image.alpha_composite(img, overlay)

        draw = ImageDraw.Draw(img)

        # Vertical layout metrics (slightly larger fonts vs. original)
        y_offset = 110
        line_height = 34
        section_spacing = 24

        # Title
        title_font = self._get_font(40)
        title_text = "鳌太线徒步记录"
        draw.text(
            (self.WIDTH // 2, y_offset),
            title_text,
            fill=self.TEXT_COLOR,
            anchor="mt",
            font=title_font,
        )
        y_offset += 60

        # Outcome banner (only show if game is finished)
        if outcome.is_finished:
            if outcome.is_success:
                if outcome.outcome_type == "cross_success":
                    outcome_text = f"✓ 穿越成功 - 成功到达{outcome.current_node_name}"
                    outcome_color = self.SUCCESS_COLOR
                else:  # retreat_success
                    outcome_text = f"✓ 下撤成功 - 成功下撤至{outcome.current_node_name}"
                    outcome_color = self.SUCCESS_COLOR
            else:
                # Show detailed failure reason
                if outcome.failure_reason:
                    outcome_text = f"✗ {outcome.failure_reason}"
                else:
                    outcome_text = "✗ 挑战失败"
                outcome_color = self.FAILURE_COLOR

            outcome_font = self._get_font(28)
            draw.text(
                (self.WIDTH // 2, y_offset),
                outcome_text,
                fill=outcome_color,
                anchor="mt",
                font=outcome_font,
            )
            y_offset += 50
        else:
            # Game in progress - show status
            status_font = self._get_font(26)
            status_text = "进行中..."
            draw.text(
                (self.WIDTH // 2, y_offset),
                status_text,
                fill=self.ACCENT_COLOR,
                anchor="mt",
                font=status_font,
            )
            y_offset += 50

        # Stats section
        stats_font = self._get_font(22)
        stats = [
            f"总距离: {outcome.total_distance_km:.1f} km",
            f"用时: {outcome.days_spent} 天",
            f"当前位置: {outcome.current_node_name}",
        ]
        for stat in stats:
            draw.text((60, y_offset), stat, fill=self.TEXT_COLOR, font=stats_font)
            y_offset += line_height
        y_offset += section_spacing

        # Roles section
        role_font = self._get_font(20)
        draw.text((60, y_offset), "队伍成员:", fill=self.ACCENT_COLOR, font=role_font)
        y_offset += line_height + 5
        for role in outcome.roles:
            role_text = f"  • {role.name}: 体力{role.attrs.stamina}/100 情绪{role.attrs.mood}/100"
            draw.text((60, y_offset), role_text, fill=self.TEXT_COLOR, font=role_font)
            y_offset += line_height - 5
        y_offset += section_spacing

        # Route section
        route_font = self._get_font(20)
        draw.text((60, y_offset), "路线节点:", fill=self.ACCENT_COLOR, font=route_font)
        y_offset += line_height + 5

        # Show visited nodes (limit to fit on image)
        visited_display = outcome.visited_nodes[:15]  # Limit display
        node_names = []
        for nid in visited_display:
            try:
                node_names.append(AoTaiGraph.get_node(nid).name)
            except Exception:
                continue
        route_text = " → ".join(node_names)
        if len(outcome.visited_nodes) > 15:
            route_text += " ..."

        # Wrap long route text
        max_width = self.WIDTH - 120
        words = route_text.split(" → ")
        lines = []
        current_line = ""
        for word in words:
            test_line = current_line + (" → " if current_line else "") + word
            bbox = draw.textbbox((0, 0), test_line, font=route_font)
            if bbox[2] - bbox[0] <= max_width:
                current_line = test_line
            else:
                if current_line:
                    lines.append(current_line)
                current_line = word
        if current_line:
            lines.append(current_line)

        for line in lines[:5]:  # Limit to 5 lines
            draw.text((60, y_offset), line, fill=self.TEXT_COLOR, font=route_font)
            y_offset += line_height - 5
        y_offset += section_spacing

        # Journey summary (structured data preview)
        summary_font = self._get_font(18)
        draw.text((60, y_offset), "旅程摘要:", fill=self.ACCENT_COLOR, font=summary_font)
        y_offset += line_height + 5

        summary_preview = json.dumps(outcome.journey_summary, ensure_ascii=False, indent=2)
        summary_lines = summary_preview.split("\n")[:8]  # Limit preview
        for line in summary_lines:
            draw.text((60, y_offset), line[:80], fill=(100, 100, 100), font=summary_font)
            y_offset += line_height - 8
        if len(summary_preview.split("\n")) > 8:
            draw.text((60, y_offset), "...", fill=(100, 100, 100), font=summary_font)

        # Footer
        footer_font = self._get_font(14)
        footer_text = "Generated by AoTai Hike Demo"
        draw.text(
            (self.WIDTH // 2, self.HEIGHT - 30),
            footer_text,
            fill=(150, 150, 150),
            anchor="mt",
            font=footer_font,
        )

        # Convert to bytes
        img_bytes = io.BytesIO()
        img.save(img_bytes, format="PNG")
        img_bytes.seek(0)

        # Structured JSON data
        json_data = {
            "outcome": {
                "is_success": outcome.is_success,
                "outcome_type": outcome.outcome_type,
                "total_distance_km": outcome.total_distance_km,
                "days_spent": outcome.days_spent,
                "is_finished": outcome.is_finished,
                "failure_reason": outcome.failure_reason,
            },
            "current_location": {
                "node_id": outcome.current_node_id,
                "node_name": outcome.current_node_name,
            },
            "roles": [
                {
                    "role_id": r.role_id,
                    "name": r.name,
                    "persona": r.persona,
                    "attrs": {
                        "stamina": r.attrs.stamina,
                        "mood": r.attrs.mood,
                        "experience": r.attrs.experience,
                        "risk_tolerance": r.attrs.risk_tolerance,
                        "supplies": r.attrs.supplies,
                    },
                }
                for r in outcome.roles
            ],
            "route": {
                "visited_node_ids": outcome.visited_nodes,
                "visited_node_names": [
                    AoTaiGraph.get_node(nid).name
                    for nid in outcome.visited_nodes
                    if _node_exists(nid)
                ],
            },
            "journey_summary": outcome.journey_summary,
        }

        return img_bytes.getvalue(), json_data


def calculate_current_state(world_state: WorldState) -> GameOutcome:
    """
    Calculate current game state for sharing (works for both finished and in-progress games).

    Args:
        world_state: Current world state

    Returns:
        GameOutcome with current state information
    """
    current_node_id = world_state.current_node_id

    # Check if reached end nodes
    is_end = current_node_id in ("end_exit", "bailout_2800", "bailout_ridge")

    # Check for failure conditions
    all_stamina_zero = (
        all(role.attrs.stamina <= 0 for role in world_state.roles) if world_state.roles else False
    )

    # Determine outcome
    if is_end:
        is_finished = True
        if current_node_id == "end_exit":
            outcome_type = "cross_success"
            is_success = True
            failure_reason = None
        elif current_node_id in ("bailout_2800", "bailout_ridge"):
            outcome_type = "retreat_success"
            is_success = True
            failure_reason = None
        else:
            outcome_type = "failure"
            is_success = False
            failure_reason = "挑战失败"
    elif all_stamina_zero:
        is_finished = True
        outcome_type = "failure"
        is_success = False
        failure_reason = "所有人体力耗尽失败"
    else:
        is_finished = False
        outcome_type = "in_progress"
        is_success = False
        failure_reason = None

    # Calculate total distance
    total_distance = 0.0
    visited = world_state.visited_node_ids
    for i in range(len(visited) - 1):
        from_id = visited[i]
        to_id = visited[i + 1]
        edges = AoTaiGraph.outgoing(from_id)
        for edge in edges:
            if edge.to_node_id == to_id:
                total_distance += getattr(edge, "distance_km", 1.0)
                break

    # Add current transit progress if in transit
    if world_state.in_transit_progress_km:
        total_distance += world_state.in_transit_progress_km

    # Get current node name
    try:
        current_node = AoTaiGraph.get_node(current_node_id)
        current_node_name = current_node.name
    except Exception:
        current_node_name = current_node_id

    # Build journey summary
    journey_summary = {
        "total_nodes_visited": len(visited),
        "key_events": world_state.recent_events[-10:],  # Last 10 events
        "final_weather": world_state.weather,
        "final_time": world_state.time_of_day,
        "leader_history": [],  # Could be expanded to track leader changes
    }

    return GameOutcome(
        is_success=is_success,
        outcome_type=outcome_type,
        total_distance_km=total_distance,
        current_node_id=current_node_id,
        current_node_name=current_node_name,
        days_spent=world_state.day,
        roles=world_state.roles,
        visited_nodes=visited,
        journey_summary=journey_summary,
        is_finished=is_finished,
        failure_reason=failure_reason,
    )


def calculate_outcome(world_state: WorldState) -> GameOutcome | None:
    """
    Calculate game outcome based on current world state.
    Returns None if game is not finished yet.

    Args:
        world_state: Current world state

    Returns:
        GameOutcome if game is finished, None otherwise
    """
    outcome = calculate_current_state(world_state)
    if not outcome.is_finished:
        return None
    return outcome


def generate_share_image(world_state: WorldState) -> tuple[bytes, dict[str, Any]] | None:
    """
    Main entry point: generate share image if game is finished.

    Args:
        world_state: Current world state

    Returns:
        tuple[bytes, dict] if game finished: (image_bytes, json_data)
        None if game not finished
    """
    outcome = calculate_outcome(world_state)
    if outcome is None:
        return None

    generator = ShareImageGenerator()
    return generator.generate(world_state, outcome)


def generate_current_share_image(world_state: WorldState) -> tuple[bytes, dict[str, Any]]:
    """
    Generate share image for current game state (works for both finished and in-progress games).

    Args:
        world_state: Current world state

    Returns:
        tuple[bytes, dict]: (image_bytes, json_data)
    """
    outcome = calculate_current_state(world_state)
    generator = ShareImageGenerator()
    return generator.generate(world_state, outcome)
