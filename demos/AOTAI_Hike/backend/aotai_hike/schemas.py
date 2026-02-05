from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class ActionType(str, Enum):
    MOVE_FORWARD = "MOVE_FORWARD"
    REST = "REST"
    CAMP = "CAMP"
    OBSERVE = "OBSERVE"
    SAY = "SAY"
    DECIDE = "DECIDE"


class Phase(str, Enum):
    FREE = "free"
    AWAIT_PLAYER_SAY = "await_player_say"
    CAMP_MEETING_DECIDE = "camp_meeting_decide"
    JUNCTION_DECISION = "junction_decision"


class LockStrength(str, Enum):
    SOFT = "soft"
    HARD = "hard"
    IRON = "iron"


class CampMeetingState(BaseModel):
    active: bool = False
    options_next_node_ids: list[str] = Field(default_factory=list)
    proposals_order_role_ids: list[str] = Field(default_factory=list)
    proposed_at_ms: int | None = None


class AoTaiNode(BaseModel):
    node_id: str
    name: str
    altitude_m: int | None = None
    scene_id: str = Field(..., description="Background scene identifier")
    hint: str | None = None

    # For frontend map rendering (0-100 coordinate space, scaled by client)
    x: int = Field(0, ge=0, le=100)
    y: int = Field(0, ge=0, le=100)
    kind: Literal["main", "camp", "lake", "peak", "exit", "junction", "start", "end"] = "main"


class AoTaiEdge(BaseModel):
    from_node_id: str
    to_node_id: str
    kind: Literal["main", "branch", "exit"] = "main"
    label: str | None = None
    distance_km: float = Field(1.0, gt=0, description="Distance along this segment (km)")


class RoleAttrs(BaseModel):
    stamina: int = Field(70, ge=0, le=100)
    mood: int = Field(60, ge=0, le=100)
    experience: int = Field(10, ge=0, le=100)
    risk_tolerance: int = Field(50, ge=0, le=100)


class Role(BaseModel):
    role_id: str
    name: str
    avatar_key: str = "default"
    persona: str = "普通徒步爱好者，话不多但靠谱。"
    attrs: RoleAttrs = Field(default_factory=RoleAttrs)


class WorldState(BaseModel):
    session_id: str
    user_id: str

    active_role_id: str | None = None
    roles: list[Role] = Field(default_factory=list)

    # Party governance / phase machine
    phase: Phase = Phase.FREE
    leader_role_id: str | None = None
    lock_strength: LockStrength = LockStrength.SOFT
    consensus_next_node_id: str | None = None
    camp_meeting: CampMeetingState = Field(default_factory=CampMeetingState)

    # Map state (graph-based)
    current_node_id: str = "start"
    visited_node_ids: list[str] = Field(default_factory=lambda: ["start"])
    available_next_node_ids: list[str] = Field(default_factory=list)

    # Transit state (step-by-step walking)
    in_transit_from_node_id: str | None = None
    in_transit_to_node_id: str | None = None
    in_transit_progress_km: float = 0.0
    in_transit_total_km: float = 0.0

    # Backward compatibility: interpreted as progress count
    route_node_index: int = 0

    day: int = 1
    time_of_day: Literal["morning", "noon", "afternoon", "evening", "night"] = "morning"
    weather: Literal["sunny", "cloudy", "windy", "rainy", "snowy", "foggy"] = "cloudy"
    recent_events: list[str] = Field(default_factory=list)


class Message(BaseModel):
    message_id: str
    role_id: str | None = None
    role_name: str | None = None
    kind: Literal["system", "speech", "action"] = "speech"
    content: str
    emote: str | None = None
    action_tag: str | None = None
    timestamp_ms: int


class BackgroundAsset(BaseModel):
    scene_id: str
    asset_url: str | None = None
    type: Literal["svg", "png", "gif", "spritesheet", "none"] = "none"
    meta: dict[str, Any] = Field(default_factory=dict)


class MapResponse(BaseModel):
    start_node_id: str
    nodes: list[AoTaiNode]
    edges: list[AoTaiEdge]


class SessionNewRequest(BaseModel):
    user_id: str = "demo_user"
    seed: int | None = None


class SessionNewResponse(BaseModel):
    session_id: str
    world_state: WorldState


class RoleUpsertRequest(BaseModel):
    session_id: str
    role: Role


class RoleUpsertResponse(BaseModel):
    roles: list[Role]
    active_role_id: str | None = None


class RolesQuickstartRequest(BaseModel):
    session_id: str
    overwrite: bool = Field(
        default=False,
        description="If true, replace existing roles with the default 3 roles.",
    )


class SetActiveRoleRequest(BaseModel):
    session_id: str
    active_role_id: str


class ActRequest(BaseModel):
    session_id: str
    action: ActionType
    payload: dict[str, Any] = Field(default_factory=dict)


class ActResponse(BaseModel):
    world_state: WorldState
    messages: list[Message]
    background: BackgroundAsset
