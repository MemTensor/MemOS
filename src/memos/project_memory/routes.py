"""项目记忆新增的接口（PRD「接口」一章里关系为「新增」的 9 个）。

路径沿用 `/product` 的下划线写法，工程封装层（openmem v1）做 `create/space` → `/product/create_space` 的映射：

| PRD 接口 | 本服务 |
| --- | --- |
| create/space、update/space、get/space、delete/space | /product/create_space、update_space、get_space、delete_space |
| create/domains、update/domains、delete/domains、list/domains | /product/create_domains、update_domains、delete_domains、list_domains |
| get/message（会话原文，项目记忆存的那一份） | /product/get_message |
| （PRD 没有）会话结束，关掉还开着的段并整理 | /product/flush_project_memory |

`flush_project_memory` 不在 PRD 里：段由模型逐轮判关，会话最后一段没有「下一轮」来触发，
接入方在会话结束时调它；不调的话要等同 Space 下一次写入时按空闲超时关。是否进 PRD 待产品定。

错误：Space 不存在 → 404；参数 / 配置错误（领域未登记、未配置领域、改名冲突、仍被引用）→ 400。
"""

from __future__ import annotations

import os

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .errors import from_service


class DomainItem(BaseModel):
    name: str
    description: str = ""


class DomainUpdateItem(BaseModel):
    name: str = Field(..., description="现有名称")
    new_name: str | None = Field(None, description="改成的名称；不改名不传")
    description: str | None = None


class CreateSpaceRequest(BaseModel):
    space_name: str
    instructions: str = ""
    domains: list[DomainItem] | None = None


class UpdateSpaceRequest(BaseModel):
    space_id: str
    space_name: str | None = None
    instructions: str | None = None


class SpaceIdRequest(BaseModel):
    space_id: str


class CreateDomainsRequest(BaseModel):
    space_id: str
    domains: list[DomainItem]


class UpdateDomainsRequest(BaseModel):
    space_id: str
    domains: list[DomainUpdateItem]


class DeleteDomainsRequest(BaseModel):
    space_id: str
    domains: list[str]


class FlushRequest(BaseModel):
    space_id: str
    conversation_id: str | None = Field(None, description="只关这个会话的段；不传关整个 Space 的")
    task_id: str | None = Field(
        None,
        description="把这个会话最后一次 add 的任务号带上，"
        "整理出的主题会记到它上面，get/status 才看得到",
    )


class EpisodeFlushRequest(BaseModel):
    space_id: str
    conversation_id: str | None = Field(None, description="只关这个会话的段；不传关整个 Space 的")
    wait_seconds: float = Field(
        0.0, ge=0, le=300, description="等待在途 Episode 处理完的秒数；仍有在途时不整理，稍后再调"
    )


def _ok(data: Any, message: str = "ok") -> dict[str, Any]:
    return {"code": 200, "message": message, "data": data}


def create_router(plugin, *, legacy_flush: bool = False) -> APIRouter:
    router = APIRouter(prefix="/product", tags=["Project Memory"])

    def svc():
        return plugin.service

    def guarded(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except (LookupError, ValueError) as e:
            raise from_service(e) from e

    @router.post("/create_space", summary="Create a project space (memory view `project`)")
    def create_space(req: CreateSpaceRequest):
        sp = guarded(
            svc().create_space,
            req.space_name,
            req.instructions,
            [d.model_dump() for d in req.domains or []],
        )
        return _ok(sp.to_api(), "Space created")

    @router.post("/update_space", summary="Update space name / instructions")
    def update_space(req: UpdateSpaceRequest):
        return _ok(
            guarded(svc().update_space, req.space_id, req.space_name, req.instructions).to_api()
        )

    @router.post("/get_space", summary="Get a project space")
    def get_space(req: SpaceIdRequest):
        return _ok(guarded(svc().get_space, req.space_id).to_api())

    @router.post(
        "/delete_space", summary="Delete a space with all its topics, instructions and domains"
    )
    def delete_space(req: SpaceIdRequest):
        return _ok(guarded(svc().delete_space, req.space_id), "Space deleted")

    @router.post("/create_domains", summary="Register domains (whole batch validated)")
    def create_domains(req: CreateDomainsRequest):
        return _ok(
            {
                "domains": guarded(
                    svc().create_domains, req.space_id, [d.model_dump() for d in req.domains]
                )
            }
        )

    @router.post("/update_domains", summary="Rename / re-describe domains; renames sync to topics")
    def update_domains(req: UpdateDomainsRequest):
        return _ok(
            {
                "domains": guarded(
                    svc().update_domains, req.space_id, [d.model_dump() for d in req.domains]
                )
            }
        )

    @router.post("/delete_domains", summary="Delete domains not referenced by any topic")
    def delete_domains(req: DeleteDomainsRequest):
        return _ok({"domains": guarded(svc().delete_domains, req.space_id, req.domains)})

    @router.post("/list_domains", summary="Full domain list of a space")
    def list_domains(req: SpaceIdRequest):
        return _ok({"domains": guarded(svc().list_domains, req.space_id)})

    if legacy_flush:

        @router.post(
            "/flush_project_memory", summary="Session end: close open episodes and organize"
        )
        def flush(req: FlushRequest):
            out = guarded(svc().flush, req.space_id, req.conversation_id, req.task_id)
            return _ok(
                {
                    "space_id": req.space_id,
                    "memory_ids": out.topic_ids,
                    "failed_episodes": out.failed_episodes,
                    "decision_ops": out.decision_ops,
                    "experience_ops": out.experience_ops,
                    **(
                        {"trace": out.trace}
                        if os.getenv("PROJECT_MEMORY_DEBUG_TRACE", "false").lower() == "true"
                        else {}
                    ),
                }
            )

    elif os.getenv("PROJECT_MEMORY_ENABLE_FLUSH", "false").lower() == "true":
        # Development and evaluation only: closes every open Episode and forces LLM Formation.

        @router.post(
            "/flush_project_memory",
            summary="Dev/eval: close open Episodes, settle in-flight stages, force Formation",
        )
        def flush_episodes(req: EpisodeFlushRequest):
            return _ok(plugin.flush_episodes(req.space_id, req.conversation_id, req.wait_seconds))

    return router
