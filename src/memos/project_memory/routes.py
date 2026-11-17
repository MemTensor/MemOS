"""项目记忆新增的接口（PRD「接口」一章里关系为「新增」的 9 个）。

路径沿用 `/product` 的下划线写法，工程封装层（openmem v1）做 `create/space` → `/product/create_space` 的映射：

| PRD 接口 | 本服务 |
| --- | --- |
| create/space、update/space、get/space、delete/space | /product/create_space、update_space、get_space、delete_space |
| create/domains、update/domains、delete/domains、list/domains | /product/create_domains、update_domains、delete_domains、list_domains |
| get/message（会话原文，项目记忆存的那一份） | /product/get_message |

错误：Space 不存在 → 404；参数 / 配置错误（领域未登记、未配置领域、改名冲突、仍被引用）→ 400。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field


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


class GetMessageRequest(BaseModel):
    user_id: str | None = None
    conversation_id: str
    space_id: str | None = None
    message_limit_number: int | None = None


def _ok(data: Any, message: str = "ok") -> dict[str, Any]:
    return {"code": 200, "message": message, "data": data}


def create_router(plugin) -> APIRouter:
    router = APIRouter(prefix="/product", tags=["Project Memory"])

    def svc():
        return plugin.service

    def guarded(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except LookupError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

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

    @router.post("/get_message", summary="Conversation messages stored for project memory")
    def get_message(req: GetMessageRequest):
        msgs = guarded(
            svc().get_message, req.conversation_id, req.space_id, req.message_limit_number
        )
        return _ok({"message_detail_list": msgs})

    return router
