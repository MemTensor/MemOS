"""Project read adapter for the existing product endpoints."""

import asyncio
import os

from collections.abc import Callable, Iterator
from concurrent.futures import Future
from contextlib import ExitStack, contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING

from fastapi import FastAPI, HTTPException, Request

from memos.api.product_models import APISearchRequest, ProjectListRequest, ProjectMessagesRequest
from memos.log import get_logger
from memos.plugins.hook_defs import H
from memos.plugins.hooks import register_hook
from memos.project_memory.index import Vector
from memos.project_memory.messages import read_messages
from memos.project_memory.retrieval import PERSONAL_GROUPS, PROJECT_GROUPS, ProjectRetrieval
from memos.project_memory.store import (
    AmbiguousMemoryError,
    Hit,
    MissingSpaceError,
    RetrievalStore,
    Scope,
    UnknownDomainError,
)
from memos.project_memory.views import ITEM_TYPES, budget


logger = get_logger(__name__)


if TYPE_CHECKING:
    from memos.embedders.base import BaseEmbedder


class ProjectReadError(HTTPException):
    def __init__(self, status: int, reason: str, message: str):
        super().__init__(status, message)
        self.reason = reason


# The producer runs concurrently with personal recall. The core memory-results
# hook sees only the candidates attached to this specific HTTP request.
_project_candidates: ContextVar[Future | None] = ContextVar("project_candidates", default=None)


def _add_project_bucket(results: dict, **kwargs) -> dict:
    ready = _project_candidates.get()
    if ready is not None:
        hits = ready.result(timeout=budget(0.30))
        results["project_mem"] = [
            {
                "cube_id": "project",
                "memories": [
                    {
                        "id": h.data["id"],
                        "memory": h.data.get("content") or h.data.get("topic_summary", ""),
                        "metadata": {"relativity": h.data["relativity"]},
                        "project_key": h.key,
                    }
                    for h in hits
                ],
            }
        ]
    return results


register_hook(H.SEARCH_MEMORY_RESULTS, _add_project_bucket)


@dataclass(frozen=True)
class ProjectAccess:
    """May be set on request.state by trusted authentication/authorization middleware."""

    tenant_id: str
    readable_space_ids: frozenset[str]


def _scope(request: Request, spaces: list[str] | None, domains: list[str]) -> Scope:
    access = getattr(request.state, "project_access", None)
    if isinstance(access, ProjectAccess) and access.tenant_id:
        if spaces is None:
            spaces = sorted(access.readable_space_ids)
        if not set(spaces) <= access.readable_space_ids:
            raise ProjectReadError(404, "SPACE_NOT_FOUND", "Space not found")
        return Scope(access.tenant_id, tuple(spaces), tuple(domains))
    # The engineering gateway authenticates the caller before forwarding /product requests.
    tenant = os.getenv("MEMOS_PROJECT_MEMORY_TENANT_ID") or None
    return Scope(tenant, None if spaces is None else tuple(spaces), tuple(domains))


@contextmanager
def project_retrieval_lifespan(app: FastAPI, components: dict) -> Iterator[None]:
    if getattr(app.state, "project_retrieval", None) is not None:
        yield
        return

    project_db = components.get("project_db")
    with ExitStack() as cleanup:
        if project_db is not None:
            pool = project_db.pool
        elif dsn := os.getenv("MEMOS_PROJECT_MEMORY_DSN"):
            # Standalone read services may supply a DSN without initializing server components.
            try:
                from psycopg2.pool import ThreadedConnectionPool
            except ImportError as exc:
                raise ImportError("Project retrieval requires psycopg2-binary") from exc

            pool = ThreadedConnectionPool(1, 16, dsn, connect_timeout=3)
            cleanup.callback(pool.closeall)
        else:
            yield
            return

        embedder = components.get("project_embedder") or components.get("embedder")
        service = ProjectRetrieval(
            RetrievalStore(pool), _query_embedder(embedder), components.get("project_message_store")
        )
        cleanup.callback(service.close)
        app.state.project_retrieval = service
        try:
            yield
        finally:
            del app.state.project_retrieval


def _query_embedder(embedder: "BaseEmbedder | None") -> Callable[[str], Vector] | None:
    model = getattr(getattr(embedder, "config", None), "model_name_or_path", None)

    # The stock provider can silently switch models. Only compare vectors whose
    # model identity is known, including when the backup endpoint is used.
    if (
        getattr(embedder, "use_backup_client", False)
        and getattr(embedder.config, "backup_model_name_or_path", None) != model
    ):
        model = None

    def embed(text: str) -> Vector:
        return Vector(model=model, values=embedder.embed([text])[0])

    return embed if model else None


def _service(request: Request) -> ProjectRetrieval:
    service = getattr(request.app.state, "project_retrieval", None)
    if service is None:
        raise HTTPException(503, "Project retrieval is not configured")
    return service


def _names(value: str | list[str] | None, name: str) -> list[str]:
    values = [value] if isinstance(value, str) else value
    if not values or any(not v.strip() for v in values):
        raise ProjectReadError(
            422,
            "SCOPE_REQUIRED" if name == "space_ids" else "INVALID_PARAM",
            f"{name} must contain non-empty strings",
        )
    if name == "space_ids" and len(values) > 20:
        raise ProjectReadError(422, "TOO_MANY_SPACES", "At most 20 spaces can be searched")
    return list(dict.fromkeys(values))


def _personal_search(
    handler: Callable, req: APISearchRequest, views: list[str], limit: int, ready: Future | None
) -> tuple[list[Hit], list[str], set | None]:
    req = req.model_copy(
        update={
            "top_k": 2 * limit,
            "session_id": req.conversation_id or req.session_id,
            "include_preference": "preference" in views,
            "include_skill_memory": "skill" in views,
            "search_tool_memory": "tool_memory" in views,
            "pref_top_k": 2 * limit,
            "skill_mem_top_k": 2 * limit,
            "tool_mem_top_k": 2 * limit,
        }
    )
    token = _project_candidates.set(ready)
    try:
        result = handler(req).data or {}
    finally:
        _project_candidates.reset(token)
    hits, missing = [], []
    for view in views:
        bucket, group = PERSONAL_GROUPS[view]
        if bucket not in result and group not in result:
            missing.append(view)
            continue
        items = result.get(group, [])
        if group not in result:
            items = [row for cube in result[bucket] for row in cube.get("memories", [])]
        for rank, item in enumerate(items, 1):
            if item.get("id"):
                hits.append(Hit(group, dict(item), 1 / (60 + rank)))
    hits.sort(key=lambda h: (-h.score, h.key))
    accepted = (
        {tuple(m["project_key"]) for b in result["project_mem"] for m in b["memories"]}
        if "project_mem" in result
        else None
    )
    return hits, missing, accepted


async def search_project(
    request: Request, req: APISearchRequest, personal_handler: Callable
) -> dict:
    views = list(dict.fromkeys(req.include_memory_view or []))
    if set(views) - PROJECT_GROUPS.keys() - PERSONAL_GROUPS.keys():
        raise ProjectReadError(400, "INVALID_PARAM", "Unsupported memory view")
    if not req.query.strip() or not req.user_id.strip():
        raise ProjectReadError(422, "SCOPE_REQUIRED", "query and user_id must be non-empty")
    spaces = _names(req.space_ids, "space_ids")
    domains = _names(req.domains, "domains") if "domains" in req.model_fields_set else []
    limit = min(25, max(1, req.memory_limit_number or 9))
    types = tuple(dict.fromkeys(req.project_item_types or ITEM_TYPES))
    if set(types) - set(ITEM_TYPES) or req.project_result_format not in {"topic", "item"}:
        raise ProjectReadError(
            400, "INVALID_PARAM", "Invalid project component type or result format"
        )
    if req.conversation_id and req.session_id and req.conversation_id != req.session_id:
        raise HTTPException(422, "Conflicting session identifiers")
    scope = _scope(request, spaces, domains)
    service = _service(request)
    personal_views = [v for v in views if v in PERSONAL_GROUPS]
    try:
        data = await service.search(
            scope,
            req.query.strip(),
            req.conversation_id or req.session_id,
            views,
            limit,
            partial(_personal_search, personal_handler, req, personal_views, limit),
            item_types=types,
            result_format=req.project_result_format,
            threshold=req.relativity,
        )
    except MissingSpaceError as exc:
        raise ProjectReadError(404, "SPACE_NOT_FOUND", "Space not found") from exc
    except UnknownDomainError as exc:
        raise ProjectReadError(400, "DOMAIN_NOT_REGISTERED", "Unregistered domain") from exc
    except Exception as exc:
        logger.warning("Project retrieval failed (%s)", type(exc).__name__)
        raise HTTPException(500, "Project retrieval unavailable") from exc
    return {"code": 200, "message": "ok", "data": data}


async def get_project(
    request: Request, memory_id: str, space_id: str | None, view: str | None
) -> dict | None:
    scope = _scope(request, _names(space_id, "space_ids") if space_id is not None else None, [])
    service = _service(request)
    try:
        data = await asyncio.wait_for(
            asyncio.to_thread(service.store.get, scope, memory_id, view == "metadata"), budget(0.45)
        )
    except AmbiguousMemoryError as exc:
        raise HTTPException(
            409, "Memory ID exists in multiple readable spaces; supply space_id"
        ) from exc
    except Exception as exc:
        logger.warning("Project lookup failed (%s)", type(exc).__name__)
        raise HTTPException(500, "Project retrieval unavailable") from exc
    if data is None:
        if space_id is None and view is None:
            return None
        raise HTTPException(404, "Memory not found")
    if view is None and data["kind"] != "trajectory":
        key = "topic_detail_list" if data["kind"] == "topic" else "project_item_list"
        item = {k: v for k, v in data.items() if k not in {"kind", "cache_policy"}}
        if data["kind"] == "topic":
            item.pop("topic_id", None)
        data = {key: [item]}
    return {"code": 200, "message": "Memory retrieved successfully", "data": data}


async def list_project(request: Request, req: ProjectListRequest) -> dict:
    if req.mem_cube_id is not None or (
        req.size is not None and req.page_size is not None and req.size != req.page_size
    ):
        raise ProjectReadError(400, "INVALID_PARAM", "Conflicting query parameters")
    scope = _scope(request, _names(req.space_id, "space_ids"), [])
    try:
        data = await asyncio.to_thread(
            _service(request).store.list_topics,
            scope,
            req.page,
            req.page_size or req.size,
            req.filter or {},
        )
    except MissingSpaceError as exc:
        raise ProjectReadError(404, "SPACE_NOT_FOUND", "Space not found") from exc
    except ValueError as exc:
        raise ProjectReadError(400, "INVALID_FILTER", str(exc)) from exc
    return {"code": 200, "message": "Memories retrieved successfully", "data": data}


async def project_messages(request: Request, req: ProjectMessagesRequest) -> dict:
    scope = _scope(
        request, _names(req.space_id, "space_ids") if req.space_id is not None else None, []
    )
    service = _service(request)
    by_tenant = await asyncio.to_thread(service.store.spaces_by_tenant, scope)
    if req.space_id is not None and not by_tenant:
        raise ProjectReadError(404, "SPACE_NOT_FOUND", "Space not found")
    if service.message_store is None:
        raise HTTPException(500, "Project message store is not configured")
    msgs = []
    for spaces in by_tenant.values():
        batch = await asyncio.to_thread(
            read_messages,
            service.message_store,
            spaces,
            req.conversation_id,
            req.message_limit_number,
        )
        if batch:
            if msgs:
                raise HTTPException(
                    409, "Conversation ID exists in multiple tenants; supply space_id"
                )
            msgs = batch
    return {"code": 200, "message": "ok", "data": {"message_detail_list": msgs}}
