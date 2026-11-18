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
from .locks import InProcessLocks
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
        self._local_locks = InProcessLocks()
        # 混合视图请求：intercept 里算好的项目记忆结果，after 里按请求取回（并发请求互不干扰）
        self._pending: dict[tuple[str, int], Any] = {}
        # Core single-provider hooks (project-memory business logic)
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
        # Intercept / after hooks so the add and search handlers don't need edits.
        # intercept: when only `project` is requested, bypass the personal-memory pipeline.
        # after: when both are requested, append project results to the core result.
        self.register_hook("add.intercept", self._add_intercept)
        self.register_hook("add.after", self._add_after)
        self.register_hook("search.intercept", self._search_intercept)
        self.register_hook("search.after", self._search_after)
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
            core_embedder = shared.get("embedder")
            # Prefer the shared (test/core) embedder; only build our own when
            # the shared context doesn't provide one.
            embedder = core_embedder or pm_config.build_embedder()
            graph_db = (
                shared.get("project_graph_db")
                or shared.get("graph_db")
                or pm_config.build_graph_db(shared.get("graph_db"))
            )
            store = ProjectStore(
                graph_db, embedder=embedder.embed if embedder is not None else None
            )
            llm = shared.get("llm") or pm_config.build_llm()
            # An explicit judge model can be supplied by the host (tests, embedding
            # services); otherwise fall back to PROJECT_MEMORY_JUDGE_LLM_*.
            judge_llm = shared.get("project_judge_llm") or pm_config.build_llm(
                "PROJECT_MEMORY_JUDGE_LLM"
            )
            self._service = ProjectMemoryService(
                store,
                ModelHub(llm=llm, judge_llm=judge_llm, graph_db=graph_db),
                lock=self._lock,
            )
        # 调度器的 submit 句柄在核心启动后期才写进上下文：每次取用时补上
        if self._service.submit is None and shared.get("submit_scheduler_messages"):
            self._service.submit = self._submit
        return self._service

    def _add_intercept(self, request: Any) -> Any | None:
        """Called by hookable('add').intercept before handle_add_memories runs."""
        from fastapi import HTTPException

        from memos.api.handlers.project_view import has_project_view, only_project

        if not has_project_view(request):
            return None

        # Validate required fields for project memory
        raw_uid = request.user_id
        user_id = (raw_uid[0] if isinstance(raw_uid, list) and raw_uid else raw_uid) or ""
        space_ids_raw = getattr(request, "space_ids", None)
        if isinstance(space_ids_raw, str):
            space_ids_raw = [space_ids_raw] if space_ids_raw.strip() else None
        if not user_id or not space_ids_raw:
            raise HTTPException(
                status_code=422,
                detail="user_id and space_ids are required when using project memory",
            )

        try:
            result = self.service.accept(request)
        except LookupError as e:
            raise HTTPException(status_code=404, detail=str(e)) from e
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e

        if only_project(request):
            return {"code": 200, "message": "Project memory task accepted", "data": [result]}
        self._pending[("add", id(request))] = result
        return None

    def _add_after(self, request: Any, result: Any) -> Any:
        """Appends project-memory task info to a mixed-view add result."""
        pending = self._pending.pop(("add", id(request)), None)
        if pending is None:
            return result
        try:
            if hasattr(result, "data") and isinstance(result.data, list):
                result.data.append(pending)
            elif isinstance(result, dict) and isinstance(result.get("data"), list):
                result["data"].append(pending)
        except Exception:
            pass
        return result

    def _search_intercept(self, request: Any) -> Any | None:
        """Called by hookable('search').intercept before handle_search_memories runs."""
        from memos.api.handlers.project_view import (
            _fill_readable_cube_ids,
            has_project_view,
            only_project,
        )

        if not has_project_view(request):
            return None
        _fill_readable_cube_ids(request)
        try:
            topics = self.service.search(request)
        except (LookupError, ValueError) as e:
            from fastapi import HTTPException

            status = 404 if isinstance(e, LookupError) else 400
            raise HTTPException(status_code=status, detail=str(e)) from e
        if only_project(request):
            return {
                "code": 200,
                "message": "Search completed successfully",
                "data": {"topic_detail_list": topics},
            }
        self._pending[("search", id(request))] = topics
        return None

    def _search_after(self, request: Any, result: Any) -> Any:
        """Appends topic_detail_list to a mixed-view search result."""
        topics = self._pending.pop(("search", id(request)), None)
        if topics is None:
            return result
        try:
            if hasattr(result, "data") and isinstance(result.data, dict):
                result.data["topic_detail_list"] = topics
            elif isinstance(result, dict) and isinstance(result.get("data"), dict):
                result["data"]["topic_detail_list"] = topics
        except Exception:
            pass
        return result

    def _lock(self, key: str):
        """项目记忆的按键锁：工程注册了 `H.PROJECT_MEMORY_LOCK`（分布式锁）就用它，否则进程内锁。

        每次取锁时查一次钩子，企业版扩展插件晚于本插件加载也能生效。
        """
        from memos.plugins.hooks import _hooks, trigger_single_hook

        if _hooks.get(H.PROJECT_MEMORY_LOCK):
            return trigger_single_hook(H.PROJECT_MEMORY_LOCK, key=key)
        return self._local_locks(key)

    def _submit(self, items: list) -> None:
        self.context["shared"]["submit_scheduler_messages"](items)

    def on_shutdown(self) -> None:
        self._service = None
        logger.info("[ProjectMemory] plugin stopped")
