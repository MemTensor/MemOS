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
from memos.plugins.result_kinds import register_result_kind

from . import config as pm_config
from .errors import from_service, http_error, reason_of
from .judge import ModelHub
from .locks import InProcessLocks
from .service import ProjectMemoryService
from .store import ProjectStore


logger = logging.getLogger(__name__)

PROJECT_RESULT_KIND = "project_mem"  # 项目记忆在核心检索结果里的类别名


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
        self.register_hook(H.PROJECT_MEMORY_ACCEPT, _tagged(self._accept))
        self.register_hook(
            H.PROJECT_MEMORY_EXECUTE,
            lambda space_id, batch, **kw: self.service.execute(space_id, batch),
        )
        self.register_hook(
            H.PROJECT_MEMORY_SEARCH, _tagged(lambda request, **kw: self.service.search(request))
        )
        self.register_hook(
            H.PROJECT_MEMORY_GET, _tagged(lambda request, **kw: self.service.list_topics(request))
        )
        self.register_hook(
            H.PROJECT_MEMORY_GET_BY_ID, lambda memory_id, **kw: self.service.get_by_id(memory_id)
        )
        self.register_hook(
            H.PROJECT_MEMORY_DELETE, _tagged(lambda request, **kw: self.service.delete(request))
        )
        self.register_hook(
            H.PROJECT_MEMORY_TASK_STATUS,
            lambda task_id, user_id, **kw: self.service.task_status(task_id, user_id),
        )
        self.register_hook("search.intercept", self._search_intercept)
        # 混合检索走核心链路：作为一类结果加进去、过同一道门槛，最后组成对外的列表
        register_result_kind(PROJECT_RESULT_KIND)
        self.register_hook(H.SEARCH_MEMORY_RESULTS, self._search_add_bucket)
        self.register_hook(H.SEARCH_RESULTS_AFTER_RERANK, self._search_finish)
        logger.info("[ProjectMemory] plugin loaded")

    def init_components(self, context: dict) -> None:
        # 保留同一个 dict 引用：调度器的 submit 句柄在核心启动后期才写进来（Dream 同样做法）
        self.context = context
        self._service = None

    def init_app(self) -> None:
        from fastapi.responses import JSONResponse

        from memos.api.handlers.project_view import ProjectHTTPError

        from .routes import create_router

        async def _project_error(_request, exc: ProjectHTTPError):
            body = {"code": exc.status_code, "message": str(exc.detail), "data": None}
            if exc.reason:
                body["reason"] = exc.reason
            return JSONResponse(status_code=exc.status_code, content=body)

        # 只接管项目记忆自己的报错类，核心的异常处理不动
        self._app.add_exception_handler(ProjectHTTPError, _project_error)
        self.register_router(create_router(self))
        logger.info("[ProjectMemory] routes registered")

    @property
    def service(self) -> ProjectMemoryService:
        shared = self.context.get("shared") or {}
        if self._service is None:
            # 优先级：宿主显式注入的 project_*（测试、嵌入式使用）> PROJECT_MEMORY_* 配置
            # > 核心的同名组件。存储不退回核心的 graph_db，除非 PROJECT_MEMORY_GRAPH_DB=shared。
            embedder = (
                shared.get("project_embedder")
                or pm_config.build_embedder()
                or shared.get("embedder")
            )
            graph_db = shared.get("project_graph_db") or pm_config.build_graph_db(
                shared.get("graph_db")
            )
            store = ProjectStore(
                graph_db, embedder=embedder.embed if embedder is not None else None
            )
            llm = shared.get("project_llm") or pm_config.build_llm() or shared.get("llm")
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

    def _accept(self, request: Any) -> dict[str, Any]:
        _require_scope(request)
        return self.service.accept(request)

    def _search_intercept(self, request: Any) -> Any | None:
        """Called by hookable('search').intercept before handle_search_memories runs.

        只要项目记忆：插件直接回答（同样按请求的 `relativity` 过门槛）。同时要个人记忆：这里只做
        校验（报错要在这里抛，钩子里的异常会被吞掉），检索交给核心链路：`search.memory_results`
        把项目记忆的候选作为 `project_mem` 一类加进结果，核心照常过门槛，`after_rerank` 再组成
        `topic_detail_list` / `project_item_list`。
        """
        from memos.api.handlers.project_view import (
            _fill_readable_cube_ids,
            has_project_view,
            only_project,
        )

        if not has_project_view(request):
            return None
        _require_scope(request)
        _fill_readable_cube_ids(request)
        try:
            if not only_project(request):
                self.service.check_search(request)
                return None
            found = self.service.search_result(request)
        except (LookupError, ValueError) as e:
            raise from_service(e) from e
        rel = float(getattr(request, "relativity", 0) or 0)
        found = {k: [x for x in v if x.get("relativity", 1.0) >= rel] for k, v in found.items()}
        return {"code": 200, "message": "Search completed successfully", "data": found}

    def _search_add_bucket(
        self, handler: Any | None = None, search_req: Any | None = None, results=None, **kw
    ):
        """search.memory_results：混合检索时把项目记忆的候选加进核心的结果（`project_mem`）。"""
        from memos.api.handlers.project_view import has_project_view, only_project

        if not isinstance(results, dict) or not has_project_view(search_req):
            return results
        if only_project(search_req):
            return results
        found = self.service.search_result(search_req)
        key, rows = next(iter(found.items()))
        results[PROJECT_RESULT_KIND] = [
            {
                "cube_id": "project",
                "list_key": key,
                "memories": [
                    {
                        "id": r["id"],
                        "memory": r.get("topic_summary") or r.get("content", ""),
                        "metadata": {"relativity": r.get("relativity", 1.0)},
                        "payload": r,
                    }
                    for r in rows
                ],
            }
        ]
        return results

    def _search_finish(
        self, handler: Any | None = None, search_req: Any | None = None, results=None, **kw
    ):
        """search.results.after_rerank：把过完门槛的 `project_mem` 组成对外的列表。"""
        if not isinstance(results, dict):
            return results
        buckets = results.pop(PROJECT_RESULT_KIND, None)
        if not buckets:
            return results
        key = buckets[0].get("list_key") or "topic_detail_list"
        results[key] = [
            m["payload"] for b in buckets for m in b.get("memories") or [] if m.get("payload")
        ]
        return results

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


def _tagged(fn):
    """单实现钩子的回调：服务层的 LookupError / ValueError 带上 reason 再抛，核心的
    project_view 转成 HTTP 报错时一并带出（报错体的 `reason` 字段）。"""

    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (LookupError, ValueError) as e:
            e.reason = reason_of(e)  # type: ignore[attr-defined]
            raise

    return wrapper


def _require_scope(request: Any) -> None:
    """带 project 的写入与检索：user_id、space_ids 必填，space_ids 最多 20 个（PRD 规则）。

    在插件里校验而不是放进共享的请求模型：企业版的请求模型自己有一套校验，两边叠加会互相干扰。
    """

    from memos.api.project_fields import PROJECT_MAX_SPACES, normalize_str_list

    raw_uid = request.user_id
    user_id = (raw_uid[0] if isinstance(raw_uid, list) and raw_uid else raw_uid) or ""
    try:
        spaces = normalize_str_list(getattr(request, "space_ids", None), "space_ids")
        normalize_str_list(getattr(request, "domains", None), "domains")
    except ValueError as e:
        raise http_error(422, e) from e
    if not user_id or not spaces:
        raise http_error(422, "user_id and space_ids are required when using project memory")
    if len(spaces) > PROJECT_MAX_SPACES:
        raise http_error(422, f"space_ids accepts at most {PROJECT_MAX_SPACES} spaces")
