from __future__ import annotations

from fastapi import APIRouter, HTTPException

from aotai_hike.adapters.background import StaticBackgroundProvider
from aotai_hike.adapters.companion import MockCompanionBrain
from aotai_hike.adapters.memory import InMemoryMemoryAdapter
from aotai_hike.schemas import (
    ActRequest,
    ActResponse,
    MapResponse,
    RoleUpsertRequest,
    RoleUpsertResponse,
    SessionNewRequest,
    SessionNewResponse,
    SetActiveRoleRequest,
    WorldState,
)
from aotai_hike.services.game_service import GameService
from aotai_hike.stores.session_store import InMemorySessionStore
from aotai_hike.world.map_data import AO_TAI_NODES


router = APIRouter(prefix="/api/demo/ao-tai", tags=["AoTai Demo"])

_sessions = InMemorySessionStore()
_game = GameService(
    memory=InMemoryMemoryAdapter(),
    companion=MockCompanionBrain(),
    background=StaticBackgroundProvider(),
)


def _get_ws(session_id: str) -> WorldState:
    ws = _sessions.get(session_id)
    if ws is None:
        raise HTTPException(status_code=404, detail=f"Unknown session_id: {session_id}")
    return ws


@router.get("/map", response_model=MapResponse)
def get_map():
    return MapResponse(nodes=AO_TAI_NODES)


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
    resp = _game.upsert_role(ws, req)
    _sessions.save(ws)
    return resp


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
