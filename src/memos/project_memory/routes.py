# -*- coding: utf-8 -*-
"""项目记忆的最小 HTTP 面：给插件演示与联调用。

真正对外的接口是 `/product/*`（PRD 的 add/message、search/memory、get/memory…），
那几个要在核心路由与 `product_models.py` 里加字段（缺口清单里的 A1–A4）。
这里的路由只用一套独立的路径，避免主干还没改核心时碰现有接口。
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .mock_data import CONV, SPACE, decision_final_turns, decision_turns, experience_segment
from .pipeline import ProjectMemoryPipeline
from .types import Msg


class DemoIngestRequest(BaseModel):
    space_id: str = SPACE
    conversation_id: str = CONV
    scenario: str = Field("decision", description="decision | decision_final | experience | all")


class SearchRequestBody(BaseModel):
    space_id: str = SPACE
    query: str
    limit: int = 9


def create_router(plugin) -> APIRouter:
    router = APIRouter(prefix="/project_memory", tags=["Project Memory (demo)"])

    @router.post("/demo_ingest", summary="用构造的样例跑一遍主干（mock add）")
    def demo_ingest(body: DemoIngestRequest) -> dict:
        from .mock_script import build_script

        store = plugin.build_store()
        pipe = ProjectMemoryPipeline(store, script=build_script())
        out: dict = {"scenario": body.scenario, "runs": []}

        if body.scenario in ("decision", "all"):
            out["runs"].append(_run(pipe, body.space_id, body.conversation_id, decision_turns(), "决策六轮+第七轮"))
        if body.scenario in ("decision_final", "all"):
            out["runs"].append(_run(pipe, body.space_id, body.conversation_id, decision_final_turns(), "拍板两轮"))
        if body.scenario in ("experience", "all"):
            out["runs"].append(_run(pipe, body.space_id, body.conversation_id, experience_segment(), "经验一段"))
        return out

    @router.post("/search", summary="按空间检索主题（PRD 的 search/memory 的 project 部分）")
    def search(body: SearchRequestBody) -> dict:
        from .mock_script import build_script

        pipe = ProjectMemoryPipeline(plugin.build_store(), script=build_script())
        return pipe.search(body.space_id, body.query, body.limit)

    return router


def _run(pipe: ProjectMemoryPipeline, space_id: str, conv: str, msgs: list[Msg], label: str) -> dict:
    res = pipe.ingest(space_id, conv, msgs)
    return {
        "label": label,
        "task_id": res.task_id,
        "topics": res.topic_ids,
        "decision_ops": res.decision_ops,
        "experience_ops": res.experience_ops,
        "dropped": res.dropped,
        "trace": res.trace,
    }
