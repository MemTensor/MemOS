from __future__ import annotations

import threading
import time
import uuid

from dataclasses import dataclass

from aotai_hike.schemas import WorldState


@dataclass
class SessionRecord:
    world_state: WorldState
    created_at_ms: int
    updated_at_ms: int


class InMemorySessionStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._sessions: dict[str, SessionRecord] = {}

    def new_session(
        self, *, user_id: str, lang: str | None = None, theme: str | None = None
    ) -> WorldState:
        now_ms = int(time.time() * 1000)
        session_id = f"ao-tai-{uuid.uuid4().hex[:10]}"
        ws_lang = "en" if lang == "en" else "zh"
        ws_theme = "kili" if theme == "kili" else "aotai"
        ws = WorldState(session_id=session_id, user_id=user_id, lang=ws_lang, theme=ws_theme)
        with self._lock:
            self._sessions[session_id] = SessionRecord(ws, now_ms, now_ms)
        return ws

    def get(self, session_id: str) -> WorldState | None:
        with self._lock:
            rec = self._sessions.get(session_id)
            return rec.world_state if rec else None

    def save(self, world_state: WorldState) -> None:
        now_ms = int(time.time() * 1000)
        with self._lock:
            rec = self._sessions.get(world_state.session_id)
            if rec is None:
                self._sessions[world_state.session_id] = SessionRecord(world_state, now_ms, now_ms)
            else:
                rec.world_state = world_state
                rec.updated_at_ms = now_ms
