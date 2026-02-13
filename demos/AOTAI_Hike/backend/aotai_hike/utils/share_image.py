"""
Independent module for generating share images when the game ends (success or failure).
Generates pixel-style images showing character config, route, journey, distance, outcome, and current location.
"""

from __future__ import annotations

import io

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from aotai_hike.theme import (
    _lang,
    _theme,
    share_days_unit,
    share_epithet_first_timer,
    share_epithet_junction,
    share_epithet_leader,
    share_epithet_night_walker,
    share_epithet_retreat_fail,
    share_epithet_retreat_snow,
    share_epithet_steadfast,
    share_epithet_storm_walker,
    share_epithet_veteran,
    share_failure_all_stamina,
    share_failure_challenge_failed,
    share_final_weather_time,
    share_footer,
    share_journey_summary_label,
    share_key_memories_label,
    share_lore_first_timer,
    share_lore_junction,
    share_lore_leader,
    share_lore_night_walker,
    share_lore_retreat_fail,
    share_lore_retreat_snow,
    share_lore_steadfast,
    share_lore_storm_walker,
    share_lore_veteran,
    share_outcome_fail,
    share_outcome_success_cross,
    share_outcome_success_retreat,
    share_result_finished_fail,
    share_result_finished_success,
    share_result_running,
    share_role_leader,
    share_role_line,
    share_route_nodes_label,
    share_stat_days,
    share_stat_distance,
    share_stat_location,
    share_stat_sep,
    share_status_running,
    share_summary_nodes_events,
    share_team_members_label,
    share_team_stat_mood,
    share_team_stat_risk,
    share_team_stat_stamina,
    share_title,
)
from aotai_hike.world.map_data import get_graph, get_node_display_name
from PIL import Image, ImageDraw, ImageFilter, ImageFont


if TYPE_CHECKING:
    from aotai_hike.schemas import Role, WorldState, WorldStats


def _node_exists(node_id: str, theme: str | None = None) -> bool:
    """Check if a node exists in the graph."""
    try:
        get_graph(theme).get_node(node_id)
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

    @staticmethod
    def _short_text(s: str, limit: int = 10) -> str:
        s = (s or "").strip()
        if len(s) <= limit:
            return s
        return s[:limit] + "…"

    @staticmethod
    def _pick_epithet_and_lore(
        stats: WorldStats, outcome: GameOutcome, world_state: WorldState
    ) -> tuple[str, str]:
        """Rule-based epithet + lore (localized by session language)."""
        lang = _lang(world_state)
        d = float(getattr(stats, "total_distance_km", 0.0) or 0.0)
        decisions = int(getattr(stats, "decision_times", 0) or 0)
        leader = int(getattr(stats, "leader_times", 0) or 0)
        bad_weather = int(getattr(stats, "bad_weather_steps", 0) or 0)
        weather = str(world_state.weather)

        # Failure path first
        if outcome.is_finished and not outcome.is_success:
            if bad_weather > 0:
                return (share_epithet_retreat_snow(lang), share_lore_retreat_snow(lang))
            return (share_epithet_retreat_fail(lang), share_lore_retreat_fail(lang))

        # Base by distance
        if d >= 40:
            epithet, lore = share_epithet_veteran(lang), share_lore_veteran(lang)
        elif d >= 20:
            epithet, lore = share_epithet_steadfast(lang), share_lore_steadfast(lang)
        else:
            epithet, lore = share_epithet_first_timer(lang), share_lore_first_timer(lang)

        # Strategy / leadership
        if decisions >= 8 and leader >= 2:
            epithet, lore = share_epithet_leader(lang), share_lore_leader(lang)
        elif decisions >= 5:
            epithet, lore = share_epithet_junction(lang), share_lore_junction(lang)

        # Harsh weather
        if bad_weather >= 5:
            if weather in {"snowy", "foggy"}:
                epithet, lore = share_epithet_night_walker(lang), share_lore_night_walker(lang)
            elif weather in {"rainy", "windy"}:
                epithet, lore = share_epithet_storm_walker(lang), share_lore_storm_walker(lang)

        return epithet, lore

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

        # Convert to RGBA and add a dark, textured panel behind text
        img = img.convert("RGBA")

        # === Dark panel with subtle vignette & texture =======================
        overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))

        # Panel margins
        panel_margin_x = 72
        panel_margin_top = 96
        panel_margin_bottom = 132
        panel_rect = (
            panel_margin_x,
            panel_margin_top,
            self.WIDTH - panel_margin_x,
            self.HEIGHT - panel_margin_bottom,
        )

        base_panel_color_top = (18, 24, 40, 220)
        base_panel_color_bottom = (10, 12, 22, 235)
        panel = Image.new("RGBA", img.size, (0, 0, 0, 0))
        panel_draw = ImageDraw.Draw(panel)
        panel_draw.rectangle(panel_rect, fill=base_panel_color_bottom)

        grad_steps = 32
        top, bottom = panel_rect[1], panel_rect[3]
        height_panel = bottom - top
        for i in range(grad_steps):
            t = i / max(1, grad_steps - 1)
            alpha = int(220 + (235 - 220) * t)
            r = int(
                base_panel_color_top[0] + (base_panel_color_bottom[0] - base_panel_color_top[0]) * t
            )
            g = int(
                base_panel_color_top[1] + (base_panel_color_bottom[1] - base_panel_color_top[1]) * t
            )
            b = int(
                base_panel_color_top[2] + (base_panel_color_bottom[2] - base_panel_color_top[2]) * t
            )
            y = top + int(height_panel * t)
            panel_draw.line([(panel_rect[0], y), (panel_rect[2], y)], fill=(r, g, b, alpha))

        border_color = (220, 180, 90, 120)
        for i in range(2):
            inset = i
            panel_draw.rectangle(
                (
                    panel_rect[0] + inset,
                    panel_rect[1] + inset,
                    panel_rect[2] - inset,
                    panel_rect[3] - inset,
                ),
                outline=border_color,
            )

        vignette = Image.new("L", img.size, 0)
        v_draw = ImageDraw.Draw(vignette)
        v_draw.ellipse(
            (
                panel_rect[0] - 80,
                panel_rect[1] - 60,
                panel_rect[2] + 80,
                panel_rect[3] + 120,
            ),
            fill=255,
        )
        vignette = vignette.filter(ImageFilter.GaussianBlur(60))
        panel.putalpha(vignette)

        overlay = Image.alpha_composite(overlay, panel)
        img = Image.alpha_composite(img, overlay)

        draw = ImageDraw.Draw(img)

        # Vertical layout metrics tuned for the new panel
        y_offset = panel_rect[1] + 36
        line_height = 34
        section_spacing = 22

        # Precompute epithet
        epithet, lore = self._pick_epithet_and_lore(world_state.stats, outcome, world_state)

        lang = _lang(world_state)
        theme = _theme(world_state)
        graph = get_graph(theme)
        title_font = self._get_font(50)
        title_text = share_title(lang)
        draw.text(
            (self.WIDTH // 2, y_offset),
            title_text,
            fill=(234, 242, 255),
            anchor="mt",
            font=title_font,
            stroke_width=2,
            stroke_fill=(20, 24, 40),
        )
        y_offset += 68

        # Outcome banner (only show if game is finished)
        if outcome.is_finished:
            if outcome.is_success:
                if outcome.outcome_type == "cross_success":
                    outcome_text = share_outcome_success_cross(lang, outcome.current_node_name)
                    outcome_color = self.SUCCESS_COLOR
                else:  # retreat_success
                    outcome_text = share_outcome_success_retreat(lang, outcome.current_node_name)
                    outcome_color = self.SUCCESS_COLOR
            else:
                outcome_text = share_outcome_fail(lang, outcome.failure_reason)
                outcome_color = self.FAILURE_COLOR

            outcome_font = self._get_font(32)
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
            status_font = self._get_font(32)
            status_text = share_status_running(lang)
            draw.text(
                (self.WIDTH // 2, y_offset),
                status_text,
                fill=self.ACCENT_COLOR,
                anchor="mt",
                font=status_font,
            )
            y_offset += 50

        # Epithet + lore block
        epithet_font = self._get_font(32)
        lore_font = self._get_font(22)

        draw.text(
            (self.WIDTH // 2, y_offset + 10),
            epithet,
            fill=(236, 228, 196),
            anchor="mt",
            font=epithet_font,
            stroke_width=2,
            stroke_fill=(20, 18, 12),
        )
        y_offset += 52

        draw.text(
            (self.WIDTH // 2, y_offset),
            lore,
            fill=(210, 208, 222),
            anchor="mt",
            font=lore_font,
        )
        y_offset += 46

        stats_font = self._get_font(28)
        left_x = panel_rect[0] + 36
        sep = share_stat_sep(lang)
        days_unit = share_days_unit(lang)

        stats = [
            f"{share_stat_distance(lang)}{sep}{outcome.total_distance_km:.1f} km",
            f"{share_stat_days(lang)}{sep}{outcome.days_spent} {days_unit}",
            f"{share_stat_location(lang)}{sep}{outcome.current_node_name}",
        ]
        for stat in stats:
            draw.text(
                (left_x, y_offset),
                stat,
                fill=(225, 235, 248),
                font=stats_font,
                stroke_width=1,
                stroke_fill=(10, 12, 20),
            )
            y_offset += line_height
        y_offset += section_spacing

        # Separator line
        sep_y = y_offset - int(section_spacing * 0.4)
        draw.line(
            (panel_rect[0] + 20, sep_y, panel_rect[2] - 20, sep_y),
            fill=(210, 170, 90, 180),
            width=1,
        )

        # Roles section
        role_font = self._get_font(28)
        draw.text(
            (left_x, y_offset),
            share_team_members_label(lang),
            fill=self.ACCENT_COLOR,
            font=role_font,
        )
        y_offset += line_height + 5
        for role in outcome.roles:
            role_text = share_role_line(lang, role.name, role.attrs.stamina, role.attrs.mood)
            draw.text(
                (left_x + 8, y_offset),
                role_text,
                fill=(225, 235, 248),
                font=role_font,
            )
            y_offset += line_height - 5
        y_offset += section_spacing

        # Route section
        route_font = self._get_font(28)
        draw.text(
            (left_x, y_offset),
            share_route_nodes_label(lang),
            fill=self.ACCENT_COLOR,
            font=route_font,
        )
        y_offset += line_height + 5

        # Show visited nodes (limit to fit on image, localized)
        visited_display = outcome.visited_nodes[:15]  # Limit display
        node_names = []
        for nid in visited_display:
            node_names.append(get_node_display_name(theme, lang, nid))
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
            draw.text(
                (left_x + 8, y_offset),
                line,
                fill=(215, 225, 240),
                font=route_font,
            )
            y_offset += line_height - 5
        y_offset += section_spacing

        # Journey summary as human-readable sentences (no raw JSON)
        summary_font = self._get_font(28)
        draw.text(
            (left_x, y_offset),
            share_journey_summary_label(lang),
            fill=self.ACCENT_COLOR,
            font=summary_font,
        )
        y_offset += line_height + 2

        total_nodes = outcome.journey_summary.get("total_nodes_visited", 0)
        key_events = outcome.journey_summary.get("key_events") or []
        final_weather = outcome.journey_summary.get("final_weather", "")
        final_time = outcome.journey_summary.get("final_time", "")

        summary_lines = []
        summary_lines.append(share_summary_nodes_events(lang, total_nodes, len(key_events)))
        if final_weather or final_time:
            summary_lines.append(share_final_weather_time(lang, final_weather, final_time))

        for line in summary_lines:
            draw.text(
                (left_x + 8, y_offset),
                line,
                fill=(200, 210, 230),
                font=summary_font,
            )
            y_offset += line_height - 6

        memory_font = self._get_font(24)
        highlights = list(getattr(world_state.stats, "memory_highlights", []) or [])
        if highlights:
            y_offset += section_spacing
            draw.text(
                (left_x, y_offset),
                share_key_memories_label(lang),
                fill=self.ACCENT_COLOR,
                font=memory_font,
            )
            y_offset += line_height
            for h in highlights:
                draw.text(
                    (left_x + 8, y_offset),
                    f"· {self._short_text(h, 24)}",
                    fill=(210, 220, 235),
                    font=memory_font,
                )
                y_offset += line_height - 4

        # Footer
        footer_font = self._get_font(28)
        footer_text = share_footer(lang)
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

        # Structured JSON data (v2-style, compatible with original info)
        result_text = (
            share_result_finished_success(lang)
            if outcome.is_finished and outcome.is_success
            else (
                share_result_finished_fail(lang)
                if outcome.is_finished
                else share_result_running(lang)
            )
        )
        json_data = {
            "summary": {
                "title": share_title(lang),
                "status": "finished"
                if outcome.is_finished and outcome.is_success
                else ("failed" if outcome.is_finished else "running"),
                "result_text": result_text,
                "fail_reason": outcome.failure_reason or "",
                "epithet": epithet,
                "lore": lore,
            },
            "party": [
                {
                    "role_id": r.role_id,
                    "name": r.name,
                    "persona": r.persona,
                    "persona_short": self._short_text(r.persona, 10),
                    "role_tag": (
                        share_role_leader(lang) if r.role_id == world_state.leader_role_id else ""
                    ),
                    "is_player": (r.role_id == world_state.active_role_id),
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
            "team_stats": [
                {
                    "label": share_team_stat_stamina(lang),
                    "value": round(
                        sum(r.attrs.stamina for r in outcome.roles) / max(1, len(outcome.roles)), 1
                    ),
                    "max": 100,
                },
                {
                    "label": share_team_stat_mood(lang),
                    "value": round(
                        sum(r.attrs.mood for r in outcome.roles) / max(1, len(outcome.roles)), 1
                    ),
                    "max": 100,
                },
                {
                    "label": share_team_stat_risk(lang),
                    "value": round(
                        sum(r.attrs.risk_tolerance for r in outcome.roles)
                        / max(1, len(outcome.roles)),
                        1,
                    ),
                    "max": 100,
                },
            ],
            "map": {
                "distance_km": outcome.total_distance_km,
                "current_node": outcome.current_node_name,
                "key_nodes": [
                    get_node_display_name(theme, lang, nid)
                    for nid in outcome.visited_nodes
                    if _node_exists(nid, theme)
                    and graph.get_node(nid).kind in {"camp", "junction", "exit", "peak", "lake"}
                ],
            },
            "env": {
                "weather_main": world_state.weather,
                "road_tags": list(
                    {
                        get_node_display_name(theme, lang, nid)
                        for nid in outcome.visited_nodes
                        if _node_exists(nid, theme)
                    }
                ),
            },
            "memory": {
                "tags": [],
                "highlight": list(getattr(world_state.stats, "memory_highlights", []) or []),
                "count_new": len(getattr(world_state.stats, "memory_highlights", []) or []),
                "count_forgot": 0,
            },
            "actions": {
                "download_enabled": True,
                "close_enabled": True,
            },
            "watermark": share_footer(lang),
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
            "route": {
                "visited_node_ids": outcome.visited_nodes,
                "visited_node_names": [
                    get_node_display_name(theme, lang, nid)
                    for nid in outcome.visited_nodes
                    if _node_exists(nid, theme)
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
        GameOutcome with current state information (node names and failure reasons localized).
    """
    theme = _theme(world_state)
    lang = _lang(world_state)
    graph = get_graph(theme)
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
            failure_reason = share_failure_challenge_failed(lang)
    elif all_stamina_zero:
        is_finished = True
        outcome_type = "failure"
        is_success = False
        failure_reason = share_failure_all_stamina(lang)
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
        edges = graph.outgoing(from_id)
        for edge in edges:
            if edge.to_node_id == to_id:
                total_distance += getattr(edge, "distance_km", 1.0)
                break

    # Add current transit progress if in transit
    if world_state.in_transit_progress_km:
        total_distance += world_state.in_transit_progress_km

    # Get current node name (localized)
    current_node_name = get_node_display_name(theme, lang, current_node_id)

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
