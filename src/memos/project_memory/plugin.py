"""项目记忆插件（照 Dream 的形状）。

- `enabled_by_default=False`，用 `MEMOS_ENABLED_PLUGINS=project_memory` 打开；
- `on_load` 注册核心声明的 7 个单实现钩子（`H.PROJECT_MEMORY_*`），核心经这些钩子把
  add / search / get_memory / delete_memory / scheduler/status 里 `project` 的部分交给本插件；
- 调度：受理时经插件上下文的 `submit_scheduler_messages` 投 `project_memory` 标签的消息，
  核心的 `ProjectMemoryMessageHandler` 按 Space 加锁后回调 `H.PROJECT_MEMORY_EXECUTE`；
- `init_app` 注册新增接口：Space 4 个、领域 4 个、get_message（见 routes.py）。

存储用插件上下文里的 `graph_db`（与核心同一个库）。要单独用一个库时，设
`MEMOS_PROJECT_MEMORY_GRAPH_DB=own` 并在 `init_components` 前把 `context["shared"]["project_graph_db"]` 准备好。
"""

from __future__ import annotations

import logging

from typing import Any

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H

from .judge import ModelHub
from .service import ProjectMemoryService
from .store import ProjectStore


logger = logging.getLogger(__name__)


class CommunityProjectMemoryPlugin(MemOSPlugin):
    name = "project_memory"
    version = "0.2.0"
    description = (
        "Project memory view: spaces, topics, decisions and experiences over MemOS Memory nodes"
    )
    enabled_by_default = False

    def on_load(self) -> None:
        self.context: dict[str, Any] = {"shared": {}, "configs": {}}
        self._service: ProjectMemoryService | None = None
        self.register_hook(
            H.PROJECT_MEMORY_ACCEPT, lambda request, **kw: self.service.accept(request)
        )
        self.register_hook(
            H.PROJECT_MEMORY_EXECUTE,
            lambda space_id, batch, **kw: self.service.execute(space_id, batch),
        )
        self.register_hook(
            H.PROJECT_MEMORY_SEARCH, lambda request, **kw: self.service.search(request)
        )
        self.register_hook(
            H.PROJECT_MEMORY_GET, lambda request, **kw: self.service.list_topics(request)
        )
        self.register_hook(
            H.PROJECT_MEMORY_GET_BY_ID, lambda memory_id, **kw: self.service.get_topic(memory_id)
        )
        self.register_hook(
            H.PROJECT_MEMORY_DELETE, lambda request, **kw: self.service.delete(request)
        )
        self.register_hook(
            H.PROJECT_MEMORY_TASK_STATUS,
            lambda task_id, user_id, **kw: self.service.task_status(task_id, user_id),
        )
        logger.info("[ProjectMemory] plugin loaded")

    def init_components(self, context: dict) -> None:
        # 保留同一个 dict 引用：调度器的 submit 句柄在核心启动后期才写进来（Dream 同样做法）
        self.context = context
        self._service = None

    def init_app(self) -> None:
        from .routes import create_router

        self.register_router(create_router(self))
        logger.info("[ProjectMemory] routes registered")

    @property
    def service(self) -> ProjectMemoryService:
        shared = self.context.get("shared") or {}
        if self._service is None:
            graph_db = shared.get("project_graph_db") or shared.get("graph_db")
            if graph_db is None:
                raise RuntimeError("项目记忆需要 graph_db：插件上下文里没有")
            embedder = shared.get("embedder")
            store = ProjectStore(
                graph_db, embedder=embedder.embed if embedder is not None else None
            )
            self._service = ProjectMemoryService(store, ModelHub(llm=shared.get("llm")))
        # 调度器的 submit 句柄在核心启动后期才写进上下文：每次取用时补上
        if self._service.submit is None and shared.get("submit_scheduler_messages"):
            self._service.submit = self._submit
        return self._service

    def _submit(self, items: list) -> None:
        self.context["shared"]["submit_scheduler_messages"](items)

    def on_shutdown(self) -> None:
        self._service = None
        logger.info("[ProjectMemory] plugin stopped")
