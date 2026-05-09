from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel


class DiaryFilter(BaseModel):
    task_id: str | None = None
    created_after: str | None = None
    created_before: str | None = None
    limit: int = 20


class DiaryQueryRequest(BaseModel):
    cube_id: str
    filter: DiaryFilter | None = None


def create_diary_router(plugin) -> APIRouter:
    """Dream diary router.

    Single query endpoint with a structured filter:
      POST /dream/diary  {"cube_id": "xxx"}
      POST /dream/diary  {"cube_id": "xxx", "filter": {"limit": 5}}
      POST /dream/diary  {"cube_id": "xxx", "filter": {"task_id": "dream_diary_xxx"}}
      POST /dream/diary  {"cube_id": "xxx", "filter": {"created_after": "2026-05-06", "created_before": "2026-05-07"}}
    """

    router = APIRouter(prefix="/dream/diary", tags=["dream-diary"])

    def _get_graph_db():
        return getattr(plugin, "context", {}).get("shared", {}).get("graph_db")

    @router.get("/health")
    def health() -> dict[str, object]:
        shared = getattr(plugin, "context", {}).get("shared", {})
        return {
            "plugin": plugin.name,
            "version": plugin.version,
            "scheduler_connected": shared.get("submit_scheduler_messages") is not None,
            "trigger_threshold": plugin.signal_store.trigger_threshold,
        }

    @router.post("")
    def query_diaries(req: DiaryQueryRequest) -> dict[str, object]:
        graph_db = _get_graph_db()
        if graph_db is None:
            return {"code": 503, "message": "graph_db is unavailable.", "data": []}

        f = req.filter or DiaryFilter()

        if f.task_id:
            node = graph_db.get_node(f.task_id, user_name=req.cube_id)
            items = [_format_item(node)] if node else []
            return {"code": 200, "message": "Dream diary retrieved successfully", "data": items}

        filters = [{"field": "memory_type", "op": "=", "value": "DreamDiary"}]
        ids = graph_db.get_by_metadata(filters, user_name=req.cube_id, status="activated")
        if not ids:
            return {"code": 200, "message": "Dream diary retrieved successfully", "data": []}

        nodes = graph_db.get_nodes(ids, user_name=req.cube_id)

        if f.created_after:
            nodes = [n for n in nodes if _created_at(n) >= f.created_after]
        if f.created_before:
            nodes = [n for n in nodes if _created_at(n) < f.created_before]

        nodes.sort(key=_created_at, reverse=True)
        items = [_format_item(n) for n in nodes[: f.limit]]
        return {"code": 200, "message": "Dream diary retrieved successfully", "data": items}

    return router


def _created_at(node: dict) -> str:
    return (node.get("metadata") or {}).get("created_at", "")


def _format_item(node: dict) -> dict:
    """Transform a graph_db node into the PRD response shape."""
    meta = node.get("metadata") or {}
    return {
        "task_id": node.get("id", ""),
        "status": meta.get("status", "completed"),
        "created_at": meta.get("created_at", ""),
        "title": meta.get("title", ""),
        "summary": meta.get("summary", ""),
        "dream_entry": meta.get("dream_entry", ""),
        "motive": meta.get("motive"),
        "themes": meta.get("themes", []),
    }
