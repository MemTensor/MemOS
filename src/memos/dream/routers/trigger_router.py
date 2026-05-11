from __future__ import annotations

from fastapi import APIRouter


def create_trigger_router(plugin) -> APIRouter:
    """Dream trigger router.

    The current plugin exposes only cube-level triggering. Session/topic
    triggers are useful community extension directions, but are not implemented
    in the current plugin.
    """

    router = APIRouter(prefix="/dream/trigger", tags=["dream-trigger"])

    @router.post("/cube")
    def trigger_cube(
        cube_id: str,
        user_id: str = "",
        user_name: str = "",
        session_id: str = "",
    ) -> dict[str, object]:
        snapshot = plugin.signal_store.snapshot(
            mem_cube_id=cube_id,
            user_id=user_id,
            user_name=user_name,
            session_id=session_id,
        )
        accepted = plugin.submit_dream_task(
            mem_cube_id=cube_id,
            user_id=user_id,
            user_name=user_name,
            signal_snapshot=snapshot,
        )
        return {
            "accepted": accepted,
            "plugin": plugin.name,
            "scope": "cube",
            "mem_cube_id": cube_id,
        }

    return router
