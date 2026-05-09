from __future__ import annotations

from copy import deepcopy

from memos.dream.types import DreamSignalSnapshot


class DreamSignalStore:
    """In-memory Dream signal accumulator.

    We accumulates new memory ids. Can add more
    signal channels, ranking policy, persistence, or decay windows around this
    minimal store.
    """

    def __init__(self, trigger_threshold: int = 100) -> None:
        self.trigger_threshold = trigger_threshold
        self._snapshots: dict[str, DreamSignalSnapshot] = {}

    def record_add(
        self,
        *,
        mem_cube_id: str,
        user_id: str = "",
        user_name: str = "",
        session_id: str = "",
        memory_ids: list[str] | None = None,
    ) -> DreamSignalSnapshot:
        snapshot = self._ensure_snapshot(
            mem_cube_id=mem_cube_id,
            user_id=user_id,
            user_name=user_name,
            session_id=session_id,
        )
        if memory_ids:
            snapshot.pending_memory_ids.extend(memory_ids)
        return deepcopy(snapshot)

    def snapshot(
        self,
        *,
        mem_cube_id: str,
        user_id: str = "",
        user_name: str = "",
        session_id: str = "",
    ) -> DreamSignalSnapshot:
        snapshot = self._ensure_snapshot(
            mem_cube_id=mem_cube_id,
            user_id=user_id,
            user_name=user_name,
            session_id=session_id,
        )
        return deepcopy(snapshot)

    def reset(self, *, mem_cube_id: str) -> None:
        self._snapshots.pop(mem_cube_id, None)

    def should_trigger(self, *, mem_cube_id: str) -> bool:
        snapshot = self._snapshots.get(mem_cube_id)
        if snapshot is None:
            return False
        return len(snapshot.pending_memory_ids) >= self.trigger_threshold

    def _ensure_snapshot(
        self,
        *,
        mem_cube_id: str,
        user_id: str = "",
        user_name: str = "",
        session_id: str = "",
    ) -> DreamSignalSnapshot:
        snapshot = self._snapshots.get(mem_cube_id)
        if snapshot is None:
            snapshot = DreamSignalSnapshot(
                mem_cube_id=mem_cube_id,
                user_id=user_id,
                user_name=user_name,
                session_id=session_id,
            )
            self._snapshots[mem_cube_id] = snapshot
        else:
            snapshot.user_id = user_id or snapshot.user_id
            snapshot.user_name = user_name or snapshot.user_name
            snapshot.session_id = session_id or snapshot.session_id
        return snapshot
