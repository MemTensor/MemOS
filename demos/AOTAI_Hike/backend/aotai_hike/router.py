from __future__ import annotations

import os
import uuid

from fastapi import APIRouter, HTTPException

from aotai_hike.adapters.background import BackgroundRequest, StaticBackgroundProvider
from aotai_hike.adapters.companion import MemoryCompanionBrain
from aotai_hike.adapters.memory import MemoryNamespace, MemOSMemoryAdapter, MemOSMemoryClient
from aotai_hike.schemas import (
    ActRequest,
    ActResponse,
    BackgroundAsset,
    MapResponse,
    Role,
    RoleAttrs,
    RolesQuickstartRequest,
    RoleUpsertRequest,
    RoleUpsertResponse,
    SessionNewRequest,
    SessionNewResponse,
    SetActiveRoleRequest,
    WorldState,
)
from aotai_hike.services.game_service import GameService
from aotai_hike.stores.session_store import InMemorySessionStore
from aotai_hike.world.map_data import AoTaiGraph


router = APIRouter(prefix="/api/demo/ao-tai", tags=["AoTai Demo"])

_sessions = InMemorySessionStore()
_background = StaticBackgroundProvider()
_memory_client = MemOSMemoryClient(base_url=os.getenv("MEMOS_API_BASE_URL", "http://0.0.0.0:8002"))
_game = GameService(
    memory=MemOSMemoryAdapter(_memory_client),
    companion=MemoryCompanionBrain(memory=_memory_client),
    background=_background,
)

# Default 3 roles (server-owned config; frontend should not hardcode)
_DEFAULT_ROLES: list[dict] = [
    {
        "name": "阿鳌",
        "avatar_key": "green",
        "persona": "阿鳌：持灯的领路者，熟知鳌太古道与太白山脉。谨慎、稳重，誓要带队抵达太白之巅。",
        "attrs": {
            "stamina": 75,
            "mood": 58,
            "experience": 35,
            "risk_tolerance": 35,
            "supplies": 80,
        },
    },
    {
        "name": "太白",
        "avatar_key": "blue",
        "persona": "太白：表面是器材与数据的虔信者，经验丰厚、言辞克制。暗闻2800下撤口藏有金矿，欲借“体力不支”脱队潜行。",
        "attrs": {
            "stamina": 68,
            "mood": 62,
            "experience": 42,
            "risk_tolerance": 45,
            "supplies": 80,
        },
    },
    {
        "name": "小山",
        "avatar_key": "red",
        "persona": "小山：笑容背后的新人徒步者，乐观只是外壳。多年前真主在2800下撤口埋下金矿，此行只为取回；若同伴相助便分金，不助则将其永远留在此地。",
        "attrs": {
            "stamina": 70,
            "mood": 72,
            "experience": 12,
            "risk_tolerance": 65,
            "supplies": 80,
        },
    },
]


def _get_ws(session_id: str) -> WorldState:
    ws = _sessions.get(session_id)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"Unknown session_id: {session_id}")
    return ws


@router.get("/map", response_model=MapResponse)
def get_map():
    return MapResponse(
        start_node_id=AoTaiGraph.start_node_id, nodes=AoTaiGraph.nodes(), edges=AoTaiGraph.edges()
    )


@router.get("/background/{scene_id}", response_model=BackgroundAsset)
def get_background(scene_id: str):
    return _background.get_background(BackgroundRequest(scene_id=scene_id))


@router.post("/session/new", response_model=SessionNewResponse)
def session_new(req: SessionNewRequest):
    ws = _sessions.new_session(user_id=req.user_id)
    _sessions.save(ws)
    return SessionNewResponse(session_id=ws.session_id, world_state=ws)


@router.get("/session/{session_id}", response_model=WorldState)
def get_session(session_id: str):
    return _get_ws(session_id)


@router.post("/roles/upsert", response_model=RoleUpsertResponse)
def roles_upsert(req: RoleUpsertRequest):
    ws = _get_ws(req.session_id)
    existing_ids = {r.role_id for r in ws.roles}
    is_new_role = req.role.role_id not in existing_ids

    resp = _game.upsert_role(ws, req)

    if is_new_role:
        role = req.role
        cube_id = MemoryNamespace.role_cube_id(user_id=role.role_id, role_id=role.role_id)
        intro = f"角色名：{role.name}。人设：{role.persona or '暂无设定'}。"
        _memory_client.add_memory(
            user_id=role.role_id,
            cube_id=cube_id,
            session_id=req.session_id,
            messages=[
                {
                    "role": "user",
                    "content": intro,
                    "role_id": role.role_id,
                    "role_name": role.name,
                }
            ],
            async_mode="async",
            mode="fine",
            source="aotai_hike_role_init",
        )
    _sessions.save(ws)
    return resp


@router.post("/roles/quickstart", response_model=RoleUpsertResponse)
def roles_quickstart(req: RolesQuickstartRequest):
    """
    Create the default 3 roles for a session.
    This keeps the default role configuration on the backend.
    """
    ws = _get_ws(req.session_id)

    if req.overwrite:
        ws.roles = []
        ws.active_role_id = None

    # If not overwriting, only add defaults that don't already exist by name.
    existing_names = {r.name for r in ws.roles}

    new_roles: list[Role] = []
    for tmpl in _DEFAULT_ROLES:
        if not req.overwrite and tmpl["name"] in existing_names:
            continue
        role = Role(
            role_id=f"r_{uuid.uuid4().hex[:8]}",
            name=tmpl["name"],
            avatar_key=tmpl.get("avatar_key") or "default",
            persona=tmpl.get("persona") or "",
            attrs=RoleAttrs(**(tmpl.get("attrs") or {})),
        )
        _game.upsert_role(ws, RoleUpsertRequest(session_id=req.session_id, role=role))
        new_roles.append(role)

    for role in new_roles:
        cube_id = MemoryNamespace.role_cube_id(user_id=role.role_id, role_id=role.role_id)
        intro = f"角色名：{role.name}。人设：{role.persona or '暂无设定'}。"
        _memory_client.add_memory(
            user_id=role.role_id,
            cube_id=cube_id,
            session_id=req.session_id,
            messages=[
                {
                    "role": "user",
                    "content": intro,
                    "role_id": role.role_id,
                    "role_name": role.name,
                }
            ],
            async_mode="async",
            mode="fine",
            source="aotai_hike_role_init",
        )

    _sessions.save(ws)
    return RoleUpsertResponse(roles=ws.roles, active_role_id=ws.active_role_id)


@router.put("/session/active_role", response_model=WorldState)
def set_active_role(req: SetActiveRoleRequest):
    ws = _get_ws(req.session_id)
    ws = _game.set_active_role(ws, req)
    _sessions.save(ws)
    return ws


@router.post("/act", response_model=ActResponse)
def act(req: ActRequest):
    ws = _get_ws(req.session_id)
    resp = _game.act(ws, req)
    _sessions.save(ws)
    return resp
