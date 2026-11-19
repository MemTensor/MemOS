# API 入口与服务生命周期

基线为 `a09c6ff9`，初次交付为 `729cfc30`。每节的 `@@ -旧起点,行数 +新起点,行数 @@` 对应这两个提交，省略行数表示一行。

可在仓库根目录执行以下命令核对任一文件，使用小节标题中的路径。

```bash
git diff --no-color --no-ext-diff --unified=0 a09c6ff9 729cfc30 -- "<路径>"
```

## `src/memos/api/handlers/add_handler.py`

**原行为**　AddHandler 只执行原有个人记忆流程，入口会记录完整请求。项目视图由插件通过 Add 的 intercept 和 after 钩子接入。

**交付行为**　入口先调用 `project_view.accept_add`。仅项目请求直接返回接受回执，混合请求将回执中的 Task ID 交给 `_add_personal_memories`，再把项目回执追加到响应。个人分支的日志只写调用模式。

**必要性**　让同一个业务 Task ID 贯穿两个视图。重发项目请求时，仍可用原 ID 补跑上次失败的个人写入。日志也不再重复记录会话原文。

````diff
diff --git a/src/memos/api/handlers/add_handler.py b/src/memos/api/handlers/add_handler.py
index 4240545f..9b5acffb 100644
--- a/src/memos/api/handlers/add_handler.py
+++ b/src/memos/api/handlers/add_handler.py
@@ -9,0 +10 @@ from pydantic import validate_call
+from memos.api.handlers import project_view
@@ -43,15 +44,16 @@ class AddHandler(BaseHandler):
-        """
-        Main handler for add memories endpoint.
-
-        Orchestrates the addition of text memories,
-        supporting concurrent processing.
-
-        Args:
-            add_req: Add memory request (deprecated fields are converted in model validator)
-
-        Returns:
-            MemoryResponse with added memory information
-        """
-        self.logger.info(
-            f"[DIAGNOSTIC] server_router -> add_handler.handle_add_memories called (Modified at 2025-11-29 18:46). Full request: {add_req.model_dump_json(indent=2)}"
-        )
+        """Dispatch requested memory views under the same business task."""
+        project = None
+        if project_view.has_project_view(add_req):
+            project = dict(project_view.accept_add(add_req))
+            project.pop("_duplicate", None)
+            if project_view.only_project(add_req):
+                return MemoryResponse(message="Project memory task accepted", data=[project])
+            add_req.task_id = project["task_id"]
+
+        response = self._add_personal_memories(add_req)
+        if project is not None:
+            response.data = [*(response.data or []), project]
+        return response
+
+    def _add_personal_memories(self, add_req: APIADDRequest) -> MemoryResponse:
+        self.logger.debug("Adding personal memories with mode %s", add_req.async_mode)
````

## `src/memos/api/handlers/component_init.py`

**原行为**　插件共享上下文没有服务已初始化的 Redis 客户端。

**交付行为**　`init_server` 将已有的 `redis_client` 放入 `plugin_context['shared']`。

**必要性**　关系 Add 运行时和调度器需要共享 Redis，以便多个实例使用相同的锁和投递环境。

````diff
diff --git a/src/memos/api/handlers/component_init.py b/src/memos/api/handlers/component_init.py
index 7e382c59..9d988ab5 100644
--- a/src/memos/api/handlers/component_init.py
+++ b/src/memos/api/handlers/component_init.py
@@ -306,0 +307 @@ def init_server() -> dict[str, Any]:
+    plugin_context["shared"]["redis_client"] = redis_client
````

## `src/memos/api/handlers/project_view.py`

**原行为**　模块说明将 Add 和 Search 的项目视图统一描述为 intercept 与 after。三个公用对象的文档字符串较长。

**交付行为**　模块说明改为 AddHandler 负责写入分流、业务 Task ID 和阶段委托。同步简化 `ProjectHTTPError`、`get_by_id` 和 `merge_task_status` 的文档字符串。

**必要性**　让说明匹配新的分工并通过代码格式检查。此文件的改动限于文档字符串。

````diff
diff --git a/src/memos/api/handlers/project_view.py b/src/memos/api/handlers/project_view.py
index 62ed148b..a56373c8 100644
--- a/src/memos/api/handlers/project_view.py
+++ b/src/memos/api/handlers/project_view.py
@@ -4,10 +4,3 @@ Routing for the `project` memory view (project memory).
-The core does three things for project memory:
-1. Routes requests that ask for the `project` view to single-provider hooks.
-2. The add / search handlers each gain an `intercept` hook so the plugin can
-   short-circuit the whole personal-memory pipeline when only `project` is
-   needed.  When both kinds are needed, the plugin's `add.after` / `search.after`
-   hook appends project results to the core result.
-3. Runs the scheduler entry (`PROJECT_MEMORY_TASK_LABEL`).
-
-All business logic lives in the project-memory plugin (`memos.project_memory`).
-The core never imports the plugin.
+AddHandler chooses the requested write views and shares the business task ID.
+Project view callbacks implement the storage and algorithms. Scheduler handlers
+delegate each durable Add stage to the active provider.
@@ -45,2 +38 @@ class ProjectHTTPError(HTTPException):
-    """项目记忆的报错：多一个稳定的原因标识 `reason`（插件注册了它的处理函数，报错体带
-    `reason`；插件没加载时按核心的 HTTPException 处理，只有 message）。"""
+    """A project error with a stable reason used by the plugin response handler."""
@@ -155,2 +147 @@ def get_by_id(memory_id: str) -> dict[str, Any] | None:
-    """按 ID 读项目记忆：主题 ID 返回 `{"topic_detail_list": [主题]}`，决策、经验、进展条目的
-    ID 返回 `{"project_item_list": [组件]}`；不是项目记忆的 ID 返回 None，走核心原有逻辑。"""
+    """Return a project topic or item by ID, or None for the core lookup."""
@@ -173,2 +164 @@ def merge_task_status(project_task: dict[str, Any], core: Any) -> dict[str, Any]
-    """一个 add 同时写个人记忆与项目记忆时，同一个 task_id 的两类状态合并：任一进行中为
-    `in_progress`，否则任一失败为 `failed`，否则 `completed`；`memory_views` 两边合在一起。"""
+    """Combine both memory views, giving running work priority over a failure."""
````

## `src/memos/api/handlers/scheduler_handler.py`

**原行为**　`handle_scheduler_status` 将业务任务、单 item 回退及用户列表中的所有调度类型用于公开查询。

**交付行为**　三个入口都排除四种项目 Add 阶段。指定 `prefer_running` 时，若其余 item 存在等待或运行状态，业务状态优先表现为 `in_progress`。

**必要性**　关系库提供项目的业务状态。单次 Redis 投递的结束状态无法代表整个 Episode，也不应覆盖还在运行的个人任务。

````diff
diff --git a/src/memos/api/handlers/scheduler_handler.py b/src/memos/api/handlers/scheduler_handler.py
index 61d0d0b9..99efd18b 100644
--- a/src/memos/api/handlers/scheduler_handler.py
+++ b/src/memos/api/handlers/scheduler_handler.py
@@ -31,0 +32 @@ from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
+from memos.mem_scheduler.schemas.task_schemas import PROJECT_ADD_TASK_LABELS
@@ -223 +224,5 @@ def handle_scheduler_status(
-    user_id: str, status_tracker: TaskStatusTracker, task_id: str | None = None
+    user_id: str,
+    status_tracker: TaskStatusTracker,
+    task_id: str | None = None,
+    *,
+    prefer_running: bool = False,
@@ -248 +253,3 @@ def handle_scheduler_status(
-            business_task_data = status_tracker.get_task_status_by_business_id(task_id, user_id)
+            business_task_data = status_tracker.get_task_status_by_business_id(
+                task_id, user_id, exclude_task_types=PROJECT_ADD_TASK_LABELS
+            )
@@ -250,3 +257,6 @@ def handle_scheduler_status(
-                response_data.append(
-                    StatusResponseItem(task_id=task_id, status=business_task_data["status"])
-                )
+                status = business_task_data["status"]
+                if prefer_running and {"waiting", "in_progress"}.intersection(
+                    business_task_data.get("item_statuses", ())
+                ):
+                    status = "in_progress"
+                response_data.append(StatusResponseItem(task_id=task_id, status=status))
@@ -256 +266 @@ def handle_scheduler_status(
-                if not item_task_data:
+                if not item_task_data or item_task_data.get("task_type") in PROJECT_ADD_TASK_LABELS:
@@ -269,0 +280 @@ def handle_scheduler_status(
+                if t_data.get("task_type") not in PROJECT_ADD_TASK_LABELS
````

## `src/memos/api/handlers/search_handler.py`

**原行为**　Search 入口依赖通用 hook 包装器在项目视图缺少插件时拦截请求。

**交付行为**　`handle_search_memories` 先调用 `project_view.require_plugin_or_400`。

**必要性**　把视图可用性校验放在对应业务入口，通用 hook 包装器可以只处理钩子。

````diff
diff --git a/src/memos/api/handlers/search_handler.py b/src/memos/api/handlers/search_handler.py
index 61dc6fef..f10e725f 100644
--- a/src/memos/api/handlers/search_handler.py
+++ b/src/memos/api/handlers/search_handler.py
@@ -14,0 +15 @@ from typing import Any
+from memos.api.handlers import project_view
@@ -81,0 +83 @@ class SearchHandler(BaseHandler):
+        project_view.require_plugin_or_400(search_req)
````

## `src/memos/api/routers/server_router.py`

**原行为**　项目 Task 与核心 Task 合并前，以核心 Handler 的默认聚合规则查个人调度状态。

**交付行为**　查到项目 Task 后，调用核心 Handler 时显式传入 `prefer_running=True`，再沿原路径合并。

**必要性**　混合请求需要在仍有个人 item 等待或运行时维持进行中状态。

````diff
diff --git a/src/memos/api/routers/server_router.py b/src/memos/api/routers/server_router.py
index 883310aa..6ad6dbe3 100644
--- a/src/memos/api/routers/server_router.py
+++ b/src/memos/api/routers/server_router.py
@@ -223 +223,4 @@ def scheduler_status(
-                    user_id=user_id, task_id=task_id, status_tracker=status_tracker
+                    user_id=user_id,
+                    task_id=task_id,
+                    status_tracker=status_tracker,
+                    prefer_running=True,
````

## `src/memos/api/server_api.py`

**原行为**　ASGI lifespan 在 `yield` 后仅调用核心组件的关闭流程。

**交付行为**　用 `finally` 在 lifespan 结束时调用核心组件清理，随后调用 `plugin_manager.shutdown()`。

**必要性**　项目插件现在持有定时线程和关系库连接，随应用退出关闭这些资源。

````diff
diff --git a/src/memos/api/server_api.py b/src/memos/api/server_api.py
index 1c6d93b9..2674b2f2 100644
--- a/src/memos/api/server_api.py
+++ b/src/memos/api/server_api.py
@@ -35,2 +35,5 @@ async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
-    yield
-    shutdown_components(server_router_module.components)
+    try:
+        yield
+    finally:
+        shutdown_components(server_router_module.components)
+        plugin_manager.shutdown()
````
