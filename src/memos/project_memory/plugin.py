"""项目记忆插件（照 Dream 的形状）。

- `enabled_by_default=False`，用 `MEMOS_ENABLED_PLUGINS=project_memory` 打开；
- `on_load` 注册核心声明的 7 个单实现钩子（`H.PROJECT_MEMORY_*`），核心经这些钩子把
  add / search / get_memory / delete_memory / scheduler/status 里 `project` 的部分交给本插件；
- 调度：受理时经插件上下文的 `submit_scheduler_messages` 投 `project_memory` 标签的消息，
  核心的 `ProjectMemoryMessageHandler` 按 Space 加锁后回调 `H.PROJECT_MEMORY_EXECUTE`；
- `init_app` 注册新增接口：Space 4 个、领域 4 个、get_message（见 routes.py）。

配置（见 config.py，全部可用环境变量覆盖，没配的退回核心的配置）：
- 模型：`PROJECT_MEMORY_LLM_*`（抽取/更新/合并/归主题）、`PROJECT_MEMORY_JUDGE_LLM_*`（判别题）；
  都没配时用插件上下文里的核心 `llm`。
- 向量模型：`PROJECT_MEMORY_EMBEDDER_*`；没配时用核心的 `embedder`。
- 存储：默认用项目记忆自己的 SQLite 库（`PROJECT_MEMORY_SQLITE_PATH`）；
  `PROJECT_MEMORY_GRAPH_DB=postgres` 用自己的 Postgres，`shared` 用核心的 graph_db。
"""

from __future__ import annotations

import logging

from typing import Any

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H

from . import config as pm_config
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
            own_embedder = pm_config.build_embedder()
            core_embedder = shared.get("embedder")
            embedder = own_embedder or core_embedder
            graph_db = shared.get("project_graph_db") or pm_config.build_graph_db(
                shared.get("graph_db")
            )
            store = ProjectStore(
                graph_db, embedder=embedder.embed if embedder is not None else None
            )
            llm = pm_config.build_llm() or shared.get("llm")
            judge_llm = pm_config.build_llm("PROJECT_MEMORY_JUDGE_LLM")
            self._service = ProjectMemoryService(
                store, ModelHub(llm=llm, judge_llm=judge_llm, graph_db=graph_db)
            )
        # 调度器的 submit 句柄在核心启动后期才写进上下文：每次取用时补上
        if self._service.submit is None and shared.get("submit_scheduler_messages"):
            self._service.submit = self._submit
        return self._service

    def _submit(self, items: list) -> None:
        self.context["shared"]["submit_scheduler_messages"](items)

    def on_shutdown(self) -> None:
        self._service = None
        logger.info("[ProjectMemory] plugin stopped")
