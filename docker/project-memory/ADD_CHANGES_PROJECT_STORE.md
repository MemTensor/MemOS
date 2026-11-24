# 项目记忆装配与兼容路径

基线为 `a09c6ff9`，初次交付为 `729cfc30`。每节的 `@@ -旧起点,行数 +新起点,行数 @@` 对应这两个提交，省略行数表示一行。

可在仓库根目录执行以下命令核对任一文件，使用小节标题中的路径。

```bash
git diff --no-color --no-ext-diff --unified=0 a09c6ff9 729cfc30 -- "<路径>"
```

## `src/memos/project_memory/experience.py`

**原行为**　`ModelHub` 在运行时导入。

**交付行为**　移入 `TYPE_CHECKING`，保留类型引用。

**必要性**　该模块只在类型注解中使用 `ModelHub`，符合 Ruff 对类型导入的检查。

````diff
diff --git a/src/memos/project_memory/experience.py b/src/memos/project_memory/experience.py
index 2fc0701f..788c50ad 100644
--- a/src/memos/project_memory/experience.py
+++ b/src/memos/project_memory/experience.py
@@ -22 +21,0 @@ from memos.graph_dbs.base import ConcurrentUpdateError
-from .judge import ModelHub
@@ -42,0 +42 @@ if TYPE_CHECKING:
+    from .judge import ModelHub
````

## `src/memos/project_memory/plugin.py`

**原行为**　插件用一次性 Add intercept 和 after 回调，并通过请求对象地址缓存混合项目结果。延迟创建的服务统一使用旧项目图存储。

**交付行为**　导入并装配 Episode 运行时，注册受理、状态和四阶段回调，移除 Add 混合结果缓存。用初始化锁保护服务创建。装配时优先识别注入的关系存储。未注入项目图存储且未指定后端时，默认选择 PostgreSQL。关系模式校验 Redis 和四阶段装配后，加载可信项目 ID 对应的存储及可选历史归档，并启动运行时。显式配置旧后端时由项目服务继续读写项目图存储。关系受理保留请求错误原因，临时不可用映射为 503。启动时按存储模式决定是否注册 flush，退出时停止运行时并关闭它的存储。Search 回调签名注明可空参数。

**必要性**　在同一个项目插件中接入持久阶段、恢复和公开回执，让 AddHandler 自行管理混合结果。显式启动和关闭负责关系模式新增的资源，并保留旧存储提供方的兼容入口。

````diff
diff --git a/src/memos/project_memory/plugin.py b/src/memos/project_memory/plugin.py
index 9c47fb72..1be79a04 100644
--- a/src/memos/project_memory/plugin.py
+++ b/src/memos/project_memory/plugin.py
@@ -1,16 +1 @@
-"""项目记忆插件（照 Dream 的形状）。
-
-- `enabled_by_default=False`，用 `MEMOS_ENABLED_PLUGINS=project_memory` 打开；
-- `on_load` 注册核心声明的 7 个单实现钩子（`H.PROJECT_MEMORY_*`），核心经这些钩子把
-  add / search / get_memory / delete_memory / scheduler/status 里 `project` 的部分交给本插件；
-- 调度：受理时经插件上下文的 `submit_scheduler_messages` 投 `project_memory` 标签的消息，
-  核心的 `ProjectMemoryMessageHandler` 按 Space 加锁后回调 `H.PROJECT_MEMORY_EXECUTE`；
-- `init_app` 注册新增接口：Space 4 个、领域 4 个、get_message（见 routes.py）。
-
-配置（见 config.py，全部可用环境变量覆盖，没配的退回核心的配置）：
-- 模型：`PROJECT_MEMORY_LLM_*`（抽取/更新/合并/归主题）、`PROJECT_MEMORY_JUDGE_LLM_*`（判别题）；
-  都没配时用插件上下文里的核心 `llm`。
-- 向量模型：`PROJECT_MEMORY_EMBEDDER_*`；没配时用核心的 `embedder`。
-- 存储：默认用项目记忆自己的 SQLite 库（`PROJECT_MEMORY_SQLITE_PATH`）；
-  `PROJECT_MEMORY_GRAPH_DB=postgres` 用自己的 Postgres，`shared` 用核心的 graph_db。
-"""
+"""Assemble the project-memory service, storage and scheduler stage providers."""
@@ -20 +5,2 @@ from __future__ import annotations
-import logging
+import os
+import threading
@@ -21,0 +8 @@ import logging
+from pathlib import Path
@@ -23,0 +11,5 @@ from typing import Any
+from memos.log import get_logger
+from memos.mem_scheduler.schemas.task_schemas import PROJECT_ADD_TASK_LABELS
+from memos.mem_scheduler.task_schedule_modules.handlers.project_memory_handler import (
+    PROJECT_ADD_STAGE_HOOKS,
+)
@@ -28,0 +21,3 @@ from . import config as pm_config
+from .add_acceptance import AddRequestError
+from .add_runtime import EpisodeAddRuntime
+from .add_store import PostgresAddStore
@@ -36 +31 @@ from .store import ProjectStore
-logger = logging.getLogger(__name__)
+logger = get_logger(__name__)
@@ -51,0 +47,2 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
+        self._runtime: EpisodeAddRuntime | None = None
+        self._init_lock = threading.RLock()
@@ -53,6 +50 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        # 混合视图请求：intercept 里算好的项目记忆结果，after 里按请求取回（并发请求互不干扰）
-        self._pending: dict[tuple[str, int], Any] = {}
-        # Core single-provider hooks (project-memory business logic)
-        self.register_hook(
-            H.PROJECT_MEMORY_ACCEPT, _tagged(lambda request, **kw: self.service.accept(request))
-        )
+        self.register_hook(H.PROJECT_MEMORY_ACCEPT, _tagged(self._accept))
@@ -77 +69 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-            lambda task_id, user_id, **kw: self.service.task_status(task_id, user_id),
+            self._task_status,
@@ -79,5 +71,2 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        # Intercept / after hooks so the add and search handlers don't need edits.
-        # intercept: when only `project` is requested, bypass the personal-memory pipeline.
-        # after: when both are requested, append project results to the core result.
-        self.register_hook("add.intercept", self._add_intercept)
-        self.register_hook("add.after", self._add_after)
+        for hook in PROJECT_ADD_STAGE_HOOKS.values():
+            self.register_hook(hook, self._run_stage)
@@ -111 +100,3 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        self.register_router(create_router(self))
+        self.register_router(create_router(self, legacy_flush=not self._uses_episode_store()))
+        if self._uses_episode_store():
+            _ = self.service
@@ -113,0 +105,7 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
+    def _uses_episode_store(self) -> bool:
+        shared = self.context.get("shared") or {}
+        return bool(shared.get("project_add_store")) or (
+            not shared.get("project_graph_db")
+            and os.getenv("PROJECT_MEMORY_GRAPH_DB", "postgres") == "postgres"
+        )
+
@@ -117,8 +115,17 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        if self._service is None:
-            # 优先级：宿主显式注入的 project_*（测试、嵌入式使用）> PROJECT_MEMORY_* 配置
-            # > 核心的同名组件。存储不退回核心的 graph_db，除非 PROJECT_MEMORY_GRAPH_DB=shared。
-            embedder = (
-                shared.get("project_embedder")
-                or pm_config.build_embedder()
-                or shared.get("embedder")
-            )
+        with self._init_lock:
+            if self._service is None:
+                self._service = self._build_service(shared)
+            if self._service.submit is None and shared.get("submit_scheduler_messages"):
+                self._service.submit = self._submit
+            return self._service
+
+    def _build_service(self, shared: dict[str, Any]) -> ProjectMemoryService:
+        embedder = (
+            shared.get("project_embedder") or pm_config.build_embedder() or shared.get("embedder")
+        )
+        project_embed = embedder.embed if embedder is not None else None
+        llm = shared.get("project_llm") or pm_config.build_llm() or shared.get("llm")
+        judge_llm = shared.get("project_judge_llm") or pm_config.build_llm(
+            "PROJECT_MEMORY_JUDGE_LLM"
+        )
+        if not self._uses_episode_store():
@@ -128,9 +135,2 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-            store = ProjectStore(
-                graph_db, embedder=embedder.embed if embedder is not None else None
-            )
-            llm = shared.get("project_llm") or pm_config.build_llm() or shared.get("llm")
-            judge_llm = shared.get("project_judge_llm") or pm_config.build_llm(
-                "PROJECT_MEMORY_JUDGE_LLM"
-            )
-            self._service = ProjectMemoryService(
-                store,
+            return ProjectMemoryService(
+                ProjectStore(graph_db, embedder=project_embed),
@@ -140,9 +140,37 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        # 调度器的 submit 句柄在核心启动后期才写进上下文：每次取用时补上
-        if self._service.submit is None and shared.get("submit_scheduler_messages"):
-            self._service.submit = self._submit
-        return self._service
-
-    def _add_intercept(self, request: Any) -> Any | None:
-        """Called by hookable('add').intercept before handle_add_memories runs."""
-
-        from memos.api.handlers.project_view import has_project_view, only_project
+        from .add_view import RelationalProjectView
+
+        redis = shared.get("redis_client")
+        scheduler = shared.get("mem_scheduler")
+        disabled = set(getattr(scheduler, "disabled_handlers", None) or ())
+        if redis is None or not getattr(scheduler, "use_redis_queue", False):
+            raise RuntimeError("Project memory Add requires MEMSCHEDULER_USE_REDIS_QUEUE=true")
+        if disabled & PROJECT_ADD_TASK_LABELS or not shared.get("submit_scheduler_messages"):
+            raise RuntimeError("Project memory Add requires all four configured scheduler stages")
+        postgres = shared.get("project_add_store")
+        if postgres is None:
+            project_id = os.getenv("PROJECT_MEMORY_PROJECT_ID", "")
+            config = pm_config.postgres_config()
+            postgres = PostgresAddStore(config, project_id=project_id)
+        try:
+            archive = None
+            if archive_path := os.getenv("PROJECT_MEMORY_LEGACY_ARCHIVE"):
+                from .add_legacy import LegacyArchive
+
+                archive = LegacyArchive.read(Path(archive_path), postgres.project_id)
+            view = RelationalProjectView(postgres, embedder=project_embed, legacy=archive)
+            hub = ModelHub(llm=llm, judge_llm=judge_llm, graph_db=None)
+            self._runtime = EpisodeAddRuntime(
+                postgres,
+                hub,
+                self._submit,
+                redis,
+                embedder=project_embed,
+                embedding_model_id=os.getenv("PROJECT_MEMORY_EMBEDDER_MODEL")
+                or os.getenv("MOS_EMBEDDER_MODEL"),
+                legacy_status=view.legacy_task_status if archive else None,
+            )
+            self._runtime.start()
+            return ProjectMemoryService(view, hub, lock=self._lock)
+        except Exception:
+            postgres.close()
+            raise
@@ -150,2 +178,2 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        if not has_project_view(request):
-            return None
+    def _accept(self, request: Any) -> dict[str, Any]:
+        from memos.api.handlers.project_view import ProjectHTTPError
@@ -153,0 +182,15 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
+        if not self._uses_episode_store():
+            return self.service.accept(request)
+        runtime = self._require_runtime()
+        try:
+            return runtime.accept(request)
+        except AddRequestError as exc:
+            raise ProjectHTTPError(exc.status_code, str(exc), exc.reason) from exc
+        except Exception as exc:
+            logger.warning("Project Add acceptance failed (%s)", type(exc).__name__)
+            raise ProjectHTTPError(
+                503, "Project memory temporarily unavailable", "STORE_UNAVAILABLE"
+            ) from exc
+
+    def _require_runtime(self) -> EpisodeAddRuntime:
+        from memos.api.handlers.project_view import ProjectHTTPError
@@ -156,3 +199,6 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-            result = self.service.accept(request)
-        except (LookupError, ValueError) as e:
-            raise from_service(e) from e
+            _ = self.service
+        except Exception as exc:
+            logger.warning("Project memory runtime is not ready (%s)", type(exc).__name__)
+            raise ProjectHTTPError(
+                503, "Project memory temporarily unavailable", "STORE_UNAVAILABLE"
+            ) from exc
@@ -160,4 +206,3 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-        if only_project(request):
-            return {"code": 200, "message": "Project memory task accepted", "data": [result]}
-        self._pending[("add", id(request))] = result
-        return None
+        if self._runtime is None:
+            raise ProjectHTTPError(503, "Project memory Add is not enabled", "STORE_UNAVAILABLE")
+        return self._runtime
@@ -165,13 +210,7 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-    def _add_after(self, request: Any, result: Any) -> Any:
-        """Appends project-memory task info to a mixed-view add result."""
-        pending = self._pending.pop(("add", id(request)), None)
-        if pending is None:
-            return result
-        try:
-            if hasattr(result, "data") and isinstance(result.data, list):
-                result.data.append(pending)
-            elif isinstance(result, dict) and isinstance(result.get("data"), list):
-                result["data"].append(pending)
-        except Exception:
-            pass
-        return result
+    def _task_status(self, task_id: str, user_id: str) -> dict[str, Any] | None:
+        if self._uses_episode_store():
+            return self._require_runtime().status(task_id, user_id)
+        return self.service.task_status(task_id, user_id)
+
+    def _run_stage(self, space_id: str, batch: list, **kwargs: Any) -> None:
+        self._require_runtime().handle(batch)
@@ -208 +247,3 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-    def _search_add_bucket(self, handler: Any = None, search_req: Any = None, results=None, **kw):
+    def _search_add_bucket(
+        self, handler: Any | None = None, search_req: Any | None = None, results=None, **kw
+    ):
@@ -235 +276,3 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
-    def _search_finish(self, handler: Any = None, search_req: Any = None, results=None, **kw):
+    def _search_finish(
+        self, handler: Any | None = None, search_req: Any | None = None, results=None, **kw
+    ):
@@ -262,0 +306,4 @@ class CommunityProjectMemoryPlugin(MemOSPlugin):
+        if self._runtime is not None:
+            self._runtime.stop()
+            self._runtime.store.close()
+            self._runtime = None
````

## `src/memos/project_memory/routes.py`

**原行为**　路由工厂始终注册 `/flush_project_memory`。

**交付行为**　增加关键字参数 `legacy_flush`，仅在启用时注册原实现和响应。

**必要性**　关系模式通过受理边界和定时线程关段。旧存储模式仍有相同的手动关段入口。

````diff
diff --git a/src/memos/project_memory/routes.py b/src/memos/project_memory/routes.py
index d29ceed7..6c301e3f 100644
--- a/src/memos/project_memory/routes.py
+++ b/src/memos/project_memory/routes.py
@@ -93 +93 @@ def _ok(data: Any, message: str = "ok") -> dict[str, Any]:
-def create_router(plugin) -> APIRouter:
+def create_router(plugin, *, legacy_flush: bool = False) -> APIRouter:
@@ -166,16 +166,4 @@ def create_router(plugin) -> APIRouter:
-    @router.post("/flush_project_memory", summary="Session end: close open episodes and organize")
-    def flush(req: FlushRequest):
-        out = guarded(svc().flush, req.space_id, req.conversation_id, req.task_id)
-        return _ok(
-            {
-                "space_id": req.space_id,
-                "memory_ids": out.topic_ids,
-                "failed_episodes": out.failed_episodes,
-                "decision_ops": out.decision_ops,
-                "experience_ops": out.experience_ops,
-                **(
-                    {"trace": out.trace}
-                    if os.getenv("PROJECT_MEMORY_DEBUG_TRACE", "false").lower() == "true"
-                    else {}
-                ),
-            }
+    if legacy_flush:
+
+        @router.post(
+            "/flush_project_memory", summary="Session end: close open episodes and organize"
@@ -182,0 +171,16 @@ def create_router(plugin) -> APIRouter:
+        def flush(req: FlushRequest):
+            out = guarded(svc().flush, req.space_id, req.conversation_id, req.task_id)
+            return _ok(
+                {
+                    "space_id": req.space_id,
+                    "memory_ids": out.topic_ids,
+                    "failed_episodes": out.failed_episodes,
+                    "decision_ops": out.decision_ops,
+                    "experience_ops": out.experience_ops,
+                    **(
+                        {"trace": out.trace}
+                        if os.getenv("PROJECT_MEMORY_DEBUG_TRACE", "false").lower() == "true"
+                        else {}
+                    ),
+                }
+            )
````

## `src/memos/project_memory/service.py`

**原行为**　服务类型只允许 `ProjectStore`。删除主题由通用服务逐项执行，跨 Space 读取原文以角色、时间、文本和工具参数构成去重键。

**交付行为**　构造类型接受 `RelationalProjectView`。关系模式调用存储的 `delete_topics`，读取原文按消息 ID 去重。旧图存储沿用原删除及去重方式。`ModelHub` 移入 `TYPE_CHECKING`。

**必要性**　关系存储可在自己的事务内删除并应用清空约束。消息 ID 可以跨 Space 识别同一原文，也能区分文本相同的两条独立消息。

````diff
diff --git a/src/memos/project_memory/service.py b/src/memos/project_memory/service.py
index 2895cdd8..dff30ce1 100644
--- a/src/memos/project_memory/service.py
+++ b/src/memos/project_memory/service.py
@@ -29 +29 @@ from datetime import datetime, timedelta, timezone
-from typing import Any
+from typing import TYPE_CHECKING, Any
@@ -36 +36 @@ from . import topic as topic_mod
-from .judge import ModelHub
+from .add_view import RelationalProjectView
@@ -59,0 +60,4 @@ from .types import (
+if TYPE_CHECKING:
+    from .judge import ModelHub
+
+
@@ -103 +107 @@ class ProjectMemoryService:
-        store: ProjectStore,
+        store: ProjectStore | RelationalProjectView,
@@ -1128 +1131,0 @@ class ProjectMemoryService:
-        space = self.get_space(req.space_id)
@@ -1129,0 +1133,6 @@ class ProjectMemoryService:
+        if isinstance(self.store, RelationalProjectView):
+            return {
+                "space_id": req.space_id,
+                "deleted_topic_ids": self.store.delete_topics(req.space_id, ids),
+            }
+        space = self.get_space(req.space_id)
@@ -1169 +1178 @@ class ProjectMemoryService:
-        seen: set[tuple] = set()
+        seen: set[str | tuple] = set()
@@ -1173 +1182,5 @@ class ProjectMemoryService:
-                key = (m.role, m.chat_time, m.text, m.tool_args)
+                key = (
+                    m.id
+                    if isinstance(self.store, RelationalProjectView)
+                    else (m.role, m.chat_time, m.text, m.tool_args)
+                )
````

## `src/memos/graph_dbs/sqlite.py`

**原行为**　旧图存储多处直接在同一连接执行查询并取结果，查询操作可能与同连接上的事务写入交错。

**交付行为**　用 `_fetchone`、`_fetchall` 复用已有连接锁，从执行到取得结果保持加锁。覆盖单节点和批量读取、向量与全文召回、存在性、邻接和图导出。

**必要性**　修复旧 SQLite 路径的并发读写冲突。各调用点的查询、参数和返回形态沿用原实现。

````diff
diff --git a/src/memos/graph_dbs/sqlite.py b/src/memos/graph_dbs/sqlite.py
index 04e3b507..1c200fee 100644
--- a/src/memos/graph_dbs/sqlite.py
+++ b/src/memos/graph_dbs/sqlite.py
@@ -284 +284 @@ class SQLiteGraphDB(BaseGraphDB):
-            row = self.conn.execute(
+            row = self._fetchone(
@@ -288 +288 @@ class SQLiteGraphDB(BaseGraphDB):
-            ).fetchone()
+            )
@@ -294,0 +295,8 @@ class SQLiteGraphDB(BaseGraphDB):
+    def _fetchall(self, statement: str, parameters: list | tuple = ()) -> list[tuple]:
+        with self._lock:
+            return self.conn.execute(statement, parameters).fetchall()
+
+    def _fetchone(self, statement: str, parameters: list | tuple = ()) -> tuple | None:
+        with self._lock:
+            return self.conn.execute(statement, parameters).fetchone()
+
@@ -302 +310 @@ class SQLiteGraphDB(BaseGraphDB):
-        row = self.conn.execute(sql, params).fetchone()
+        row = self._fetchone(sql, params)
@@ -317 +325 @@ class SQLiteGraphDB(BaseGraphDB):
-        rows = {r[0]: r for r in self.conn.execute(sql, params).fetchall()}
+        rows = {r[0]: r for r in self._fetchall(sql, params)}
@@ -358 +366 @@ class SQLiteGraphDB(BaseGraphDB):
-        return [r[0] for r in self.conn.execute(sql, params).fetchall()]
+        return [r[0] for r in self._fetchall(sql, params)]
@@ -369,3 +377 @@ class SQLiteGraphDB(BaseGraphDB):
-        return [
-            self._row_out(r, include_embedding) for r in self.conn.execute(sql, params).fetchall()
-        ]
+        return [self._row_out(r, include_embedding) for r in self._fetchall(sql, params)]
@@ -375 +381 @@ class SQLiteGraphDB(BaseGraphDB):
-        return self.conn.execute(
+        return self._fetchone(
@@ -378 +384 @@ class SQLiteGraphDB(BaseGraphDB):
-        ).fetchone()[0]
+        )[0]
@@ -384 +390 @@ class SQLiteGraphDB(BaseGraphDB):
-        rows = self.conn.execute(
+        rows = self._fetchall(
@@ -388 +394 @@ class SQLiteGraphDB(BaseGraphDB):
-        ).fetchall()
+        )
@@ -422 +428 @@ class SQLiteGraphDB(BaseGraphDB):
-            for node_id, dist in self.conn.execute(sql, vec_params + params).fetchall():
+            for node_id, dist in self._fetchall(sql, vec_params + params):
@@ -428 +434 @@ class SQLiteGraphDB(BaseGraphDB):
-            for node_id, blob in self.conn.execute(sql, params).fetchall():
+            for node_id, blob in self._fetchall(sql, params):
@@ -458 +464 @@ class SQLiteGraphDB(BaseGraphDB):
-        rows = self.conn.execute(sql, [match, *params, top_k]).fetchall()
+        rows = self._fetchall(sql, [match, *params, top_k])
@@ -493 +499 @@ class SQLiteGraphDB(BaseGraphDB):
-        return self.conn.execute(sql, params).fetchone() is not None
+        return self._fetchone(sql, params) is not None
@@ -581,3 +587 @@ class SQLiteGraphDB(BaseGraphDB):
-        return [
-            self._row_out(r, include_embedding) for r in self.conn.execute(sql, params).fetchall()
-        ]
+        return [self._row_out(r, include_embedding) for r in self._fetchall(sql, params)]
@@ -587 +591 @@ class SQLiteGraphDB(BaseGraphDB):
-        rows = self.conn.execute(
+        rows = self._fetchall(
@@ -591 +595 @@ class SQLiteGraphDB(BaseGraphDB):
-        ).fetchall()
+        )
@@ -603 +607 @@ class SQLiteGraphDB(BaseGraphDB):
-            for r in self.conn.execute(
+            for r in self._fetchall(
@@ -623 +627 @@ class SQLiteGraphDB(BaseGraphDB):
-            for r in self.conn.execute(
+            for r in self._fetchall(
@@ -633 +637 @@ class SQLiteGraphDB(BaseGraphDB):
-        rows = self.conn.execute(
+        rows = self._fetchall(
@@ -636 +640 @@ class SQLiteGraphDB(BaseGraphDB):
-        ).fetchall()
+        )
@@ -641 +645 @@ class SQLiteGraphDB(BaseGraphDB):
-            for s, t, ty in self.conn.execute("SELECT source_id, target_id, type FROM edges")
+            for s, t, ty in self._fetchall("SELECT source_id, target_id, type FROM edges")
````

## `tests/project_memory/test_api_changes_1118.py`

**原行为**　混合 Search 用的替身请求将两个列表和一个集合写为普通类属性。

**交付行为**　将 `include_memory_view`、`space_ids` 和 `model_fields_set` 标为 `ClassVar`，并明确其中的字符串类型。

**必要性**　通过 Ruff 的可变类属性检查，保留替身数据和原有断言。

````diff
diff --git a/tests/project_memory/test_api_changes_1118.py b/tests/project_memory/test_api_changes_1118.py
index 7726041e..8ddf9341 100644
--- a/tests/project_memory/test_api_changes_1118.py
+++ b/tests/project_memory/test_api_changes_1118.py
@@ -5,0 +6,2 @@ from __future__ import annotations
+from typing import ClassVar
+
@@ -173 +175 @@ def test_mixed_search_goes_through_core_buckets(app):
-        include_memory_view = ["text_mem", "project"]
+        include_memory_view: ClassVar[list[str]] = ["text_mem", "project"]
@@ -177 +179 @@ def test_mixed_search_goes_through_core_buckets(app):
-        space_ids = [sid]
+        space_ids: ClassVar[list[str]] = [sid]
@@ -183 +185 @@ def test_mixed_search_goes_through_core_buckets(app):
-        model_fields_set: set = set()
+        model_fields_set: ClassVar[set[str]] = set()
````
