# 调度投递与插件边界

基线为 `a09c6ff9`，初次交付为 `729cfc30`。每节的 `@@ -旧起点,行数 +新起点,行数 @@` 对应这两个提交，省略行数表示一行。

可在仓库根目录执行以下命令核对任一文件，使用小节标题中的路径。

```bash
git diff --no-color --no-ext-diff --unified=0 a09c6ff9 729cfc30 -- "<路径>"
```

## `src/memos/mem_scheduler/schemas/task_schemas.py`

**原行为**　项目整理没有抽取、归类、合并准备和提交各自的调度标签，也没有由 Handler 指示暂缓完成与 ACK 的标志。

**交付行为**　增加四个标签、统一标签集合、600,000 毫秒的最小认领空闲时间，以及 `_scheduler_deferred` 和 `_scheduler_skip_ack` 两个本次投递标志。

**必要性**　让各阶段用常规调度独立投递和认领，并区分延迟业务完成与保留 Redis pending 消息。

````diff
diff --git a/src/memos/mem_scheduler/schemas/task_schemas.py b/src/memos/mem_scheduler/schemas/task_schemas.py
index 3b5e2f02..59f5f974 100644
--- a/src/memos/mem_scheduler/schemas/task_schemas.py
+++ b/src/memos/mem_scheduler/schemas/task_schemas.py
@@ -41,0 +42,17 @@ MEM_FEEDBACK_TASK_LABEL = "mem_feedback"
+PROJECT_ADD_PROCESS_TASK_LABEL = "project_add_process"
+PROJECT_ADD_SPACE_TASK_LABEL = "project_add_space"
+PROJECT_ADD_MERGE_TASK_LABEL = "project_add_merge"
+PROJECT_ADD_MERGE_RESULT_TASK_LABEL = "project_add_merge_result"
+PROJECT_ADD_TASK_LABELS = frozenset(
+    (
+        PROJECT_ADD_PROCESS_TASK_LABEL,
+        PROJECT_ADD_SPACE_TASK_LABEL,
+        PROJECT_ADD_MERGE_TASK_LABEL,
+        PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
+    )
+)
+PROJECT_ADD_PENDING_CLAIM_MIN_IDLE_MS = 600_000
+
+# Set by a handler after dispatch. These flags do not travel on a new delivery.
+SCHEDULER_DEFERRED_INFO_KEY = "_scheduler_deferred"
+SCHEDULER_SKIP_ACK_INFO_KEY = "_scheduler_skip_ack"
````

## `src/memos/mem_scheduler/task_schedule_modules/dispatcher.py`

**原行为**　批处理成功或抛出异常后，Dispatcher 对整批写入状态、尝试发送完成通知，并在最后确认 Redis 消息。

**交付行为**　每次投递前清除旧标志，仅对未标记 deferred 的 item 写状态和发完成通知，逐条跳过标记 skip ACK 的消息。项目阶段也从业务完成通知中排除。

**必要性**　接力失败的 item 可保留给 worker 认领，同批其他 item 仍能独立结束。阶段结束只表示投递处理结果。

````diff
diff --git a/src/memos/mem_scheduler/task_schedule_modules/dispatcher.py b/src/memos/mem_scheduler/task_schedule_modules/dispatcher.py
index 151a0f79..8bef43b3 100644
--- a/src/memos/mem_scheduler/task_schedule_modules/dispatcher.py
+++ b/src/memos/mem_scheduler/task_schedule_modules/dispatcher.py
@@ -23 +23,7 @@ from memos.mem_scheduler.schemas.message_schemas import ScheduleLogForWebItem, S
-from memos.mem_scheduler.schemas.task_schemas import RunningTaskItem, TaskPriorityLevel
+from memos.mem_scheduler.schemas.task_schemas import (
+    PROJECT_ADD_TASK_LABELS,
+    SCHEDULER_DEFERRED_INFO_KEY,
+    SCHEDULER_SKIP_ACK_INFO_KEY,
+    RunningTaskItem,
+    TaskPriorityLevel,
+)
@@ -121,0 +128,4 @@ class SchedulerDispatcher(BaseSchedulerModule):
+    @staticmethod
+    def _non_deferred_messages(messages: list[ScheduleMessageItem]) -> list[ScheduleMessageItem]:
+        return [msg for msg in messages if not (msg.info or {}).get(SCHEDULER_DEFERRED_INFO_KEY)]
+
@@ -136,0 +147,4 @@ class SchedulerDispatcher(BaseSchedulerModule):
+            for msg in messages:
+                if msg.info:
+                    msg.info.pop(SCHEDULER_DEFERRED_INFO_KEY, None)
+                    msg.info.pop(SCHEDULER_SKIP_ACK_INFO_KEY, None)
@@ -205 +219,2 @@ class SchedulerDispatcher(BaseSchedulerModule):
-                    for msg in messages:
+                    completed = self._non_deferred_messages(messages)
+                    for msg in completed:
@@ -207 +222 @@ class SchedulerDispatcher(BaseSchedulerModule):
-                    self._maybe_emit_task_completion(messages)
+                    self._maybe_emit_task_completion(completed)
@@ -241 +256,2 @@ class SchedulerDispatcher(BaseSchedulerModule):
-                    for msg in messages:
+                    failed = self._non_deferred_messages(messages)
+                    for msg in failed:
@@ -245 +261 @@ class SchedulerDispatcher(BaseSchedulerModule):
-                    self._maybe_emit_task_completion(messages, error=e)
+                    self._maybe_emit_task_completion(failed, error=e)
@@ -273 +289 @@ class SchedulerDispatcher(BaseSchedulerModule):
-                # Ensure Redis messages are acknowledged even if handler fails
+                # ACK delivered messages unless a handler left one pending for reclaim.
@@ -279,0 +296,2 @@ class SchedulerDispatcher(BaseSchedulerModule):
+                            if (msg.info or {}).get(SCHEDULER_SKIP_ACK_INFO_KEY):
+                                continue
@@ -304,0 +323,2 @@ class SchedulerDispatcher(BaseSchedulerModule):
+            if msg.label in PROJECT_ADD_TASK_LABELS:
+                continue
````

## `src/memos/mem_scheduler/task_schedule_modules/handlers/project_memory_handler.py`

**原行为**　仅有旧 `ProjectMemoryMessageHandler`，用于消费单阶段的项目整理消息。

**交付行为**　保留旧 Handler，同时增加 `ProjectAddStageHandler` 和标签到钩子的映射。新 Handler 校验类型，按 Space 委托批次，只记计数和标签。没有提供方或调用抛错时保留待认领消息。

**必要性**　让持久阶段重用现有 Dispatcher 的校验、路由与认领机制。模型输入和会话正文无需出现在投递日志中。

````diff
diff --git a/src/memos/mem_scheduler/task_schedule_modules/handlers/project_memory_handler.py b/src/memos/mem_scheduler/task_schedule_modules/handlers/project_memory_handler.py
index 999e6aed..fa9c1294 100644
--- a/src/memos/mem_scheduler/task_schedule_modules/handlers/project_memory_handler.py
+++ b/src/memos/mem_scheduler/task_schedule_modules/handlers/project_memory_handler.py
@@ -5,0 +6,8 @@ from memos.log import get_logger
+from memos.mem_scheduler.schemas.task_schemas import (
+    PROJECT_ADD_MERGE_RESULT_TASK_LABEL,
+    PROJECT_ADD_MERGE_TASK_LABEL,
+    PROJECT_ADD_PROCESS_TASK_LABEL,
+    PROJECT_ADD_SPACE_TASK_LABEL,
+    SCHEDULER_DEFERRED_INFO_KEY,
+    SCHEDULER_SKIP_ACK_INFO_KEY,
+)
@@ -12,0 +21 @@ if TYPE_CHECKING:
+    from memos.mem_scheduler.task_schedule_modules.context import SchedulerHandlerContext
@@ -52,0 +62,52 @@ class ProjectMemoryMessageHandler(BaseSchedulerHandler):
+
+
+PROJECT_ADD_STAGE_HOOKS = {
+    PROJECT_ADD_PROCESS_TASK_LABEL: H.PROJECT_MEMORY_PROCESS,
+    PROJECT_ADD_SPACE_TASK_LABEL: H.PROJECT_MEMORY_SPACE,
+    PROJECT_ADD_MERGE_TASK_LABEL: H.PROJECT_MEMORY_MERGE,
+    PROJECT_ADD_MERGE_RESULT_TASK_LABEL: H.PROJECT_MEMORY_MERGE_RESULT,
+}
+
+
+class ProjectAddStageHandler(BaseSchedulerHandler):
+    """Delegate one durable Add stage without logging the payload."""
+
+    def __init__(self, scheduler_context: SchedulerHandlerContext, label: str) -> None:
+        super().__init__(scheduler_context)
+        self.label = label
+        self.hook = PROJECT_ADD_STAGE_HOOKS[label]
+
+    @property
+    def expected_task_label(self) -> str:
+        return self.label
+
+    def validate_and_log_messages(self, messages: list[ScheduleMessageItem], label: str) -> None:
+        logger.debug("Dispatching %d project Add messages to %s", len(messages), label)
+        self.scheduler_context.services.validate_messages(messages=messages, label=label)
+
+    def batch_handler(
+        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
+    ) -> None:
+        if not _hooks.get(self.hook):
+            logger.warning("No provider ready for project Add stage %s", self.label)
+            self._retain(batch)
+            return
+        try:
+            trigger_single_hook(
+                self.hook,
+                space_id=mem_cube_id,
+                batch=batch,
+                scheduler_context=self.scheduler_context,
+            )
+        except Exception:
+            self._retain(batch)
+            raise
+
+    @staticmethod
+    def _retain(batch: list[ScheduleMessageItem]) -> None:
+        for message in batch:
+            message.info = {
+                **(message.info or {}),
+                SCHEDULER_DEFERRED_INFO_KEY: True,
+                SCHEDULER_SKIP_ACK_INFO_KEY: True,
+            }
````

## `src/memos/mem_scheduler/task_schedule_modules/registry.py`

**原行为**　注册表只为项目记忆登记旧的单阶段 Handler。

**交付行为**　为四个阶段分别创建 Handler，保留旧登记，并按 `LEVEL_2` 和 600,000 毫秒的 pending 认领间隔登记新标签。

**必要性**　让调度器按标签运行或恢复各阶段。旧队列中的任务可继续使用原入口。

````diff
diff --git a/src/memos/mem_scheduler/task_schedule_modules/registry.py b/src/memos/mem_scheduler/task_schedule_modules/registry.py
index 634df762..008d714b 100644
--- a/src/memos/mem_scheduler/task_schedule_modules/registry.py
+++ b/src/memos/mem_scheduler/task_schedule_modules/registry.py
@@ -19,0 +20,2 @@ from memos.mem_scheduler.schemas.task_schemas import (
+    PROJECT_ADD_PENDING_CLAIM_MIN_IDLE_MS,
+    PROJECT_ADD_TASK_LABELS,
@@ -32 +34,5 @@ from .handlers.pref_add_handler import PrefAddMessageHandler
-from .handlers.project_memory_handler import PROJECT_MEMORY_TASK_LABEL, ProjectMemoryMessageHandler
+from .handlers.project_memory_handler import (
+    PROJECT_MEMORY_TASK_LABEL,
+    ProjectAddStageHandler,
+    ProjectMemoryMessageHandler,
+)
@@ -47,0 +54,4 @@ class SchedulerHandlerRegistry:
+        self.project_add_stages = {
+            label: ProjectAddStageHandler(scheduler_context, label)
+            for label in PROJECT_ADD_TASK_LABELS
+        }
@@ -61,0 +72,6 @@ class SchedulerHandlerRegistry:
+        predefined_handlers.update(
+            {
+                label: (handler, TaskPriorityLevel.LEVEL_2, PROJECT_ADD_PENDING_CLAIM_MIN_IDLE_MS)
+                for label, handler in self.project_add_stages.items()
+            }
+        )
````

## `src/memos/mem_scheduler/utils/status_tracker.py`

**原行为**　按业务 Task ID 聚合时读取所有 item，并用检索到的 ID 数计算 `item_count`。

**交付行为**　增加默认空集合的 `exclude_task_types`，匹配类型的 item 不进入聚合，以实际参与聚合的状态数计算 `item_count`。

**必要性**　业务状态查询可只聚合个人 item。调用方不传过滤参数时仍使用所有可读 item。

````diff
diff --git a/src/memos/mem_scheduler/utils/status_tracker.py b/src/memos/mem_scheduler/utils/status_tracker.py
index 4977cfc3..11a985ef 100644
--- a/src/memos/mem_scheduler/utils/status_tracker.py
+++ b/src/memos/mem_scheduler/utils/status_tracker.py
@@ -10,0 +11,2 @@ if TYPE_CHECKING:
+    from collections.abc import Collection
+
@@ -141 +143,3 @@ class TaskStatusTracker:
-    def get_task_status_by_business_id(self, business_task_id: str, user_id: str) -> dict | None:
+    def get_task_status_by_business_id(
+        self, business_task_id: str, user_id: str, *, exclude_task_types: "Collection[str]" = ()
+    ) -> dict | None:
@@ -173,0 +178,2 @@ class TaskStatusTracker:
+                if item_data.get("task_type") in exclude_task_types:
+                    continue
@@ -195 +201 @@ class TaskStatusTracker:
-            "item_count": len(item_ids),
+            "item_count": len(item_statuses),
````

## `src/memos/plugins/hook_defs.py`

**原行为**　已声明单阶段项目执行钩子，没有四阶段调用签名。

**交付行为**　增加 process、space、merge 和 merge_result 四个钩子，统一声明 `space_id`、`batch` 和 `scheduler_context` 参数。

**必要性**　保持现有插件提供方边界，由调度 Handler 委托各阶段。

````diff
diff --git a/src/memos/plugins/hook_defs.py b/src/memos/plugins/hook_defs.py
index c9253d06..e1dffef0 100644
--- a/src/memos/plugins/hook_defs.py
+++ b/src/memos/plugins/hook_defs.py
@@ -99,0 +100,4 @@ class H:
+    PROJECT_MEMORY_PROCESS = "project_memory.process"
+    PROJECT_MEMORY_SPACE = "project_memory.space"
+    PROJECT_MEMORY_MERGE = "project_memory.merge"
+    PROJECT_MEMORY_MERGE_RESULT = "project_memory.merge_result"
@@ -213,0 +218,8 @@ define_hook(
+for hook, purpose in (
+    (H.PROJECT_MEMORY_PROCESS, "Extract one closed Episode"),
+    (H.PROJECT_MEMORY_SPACE, "Recall and organize an Episode in its Space"),
+    (H.PROJECT_MEMORY_MERGE, "Prepare entry changes for an Episode"),
+    (H.PROJECT_MEMORY_MERGE_RESULT, "Finalize and commit the prepared changes"),
+):
+    define_hook(hook, description=purpose, params=["space_id", "batch", "scheduler_context"])
+
````

## `src/memos/plugins/hooks.py`

**原行为**　通用 `hookable` 在没有 intercept 回调时，依据项目视图标志返回 HTTP 400。

**交付行为**　删除该业务分支。项目视图校验由 Add 受理和 Search Handler 执行。

**必要性**　AddHandler 需要按所请求的视图正常分流。通用钩子层只负责调用回调。

````diff
diff --git a/src/memos/plugins/hooks.py b/src/memos/plugins/hooks.py
index 085b09c6..468eb004 100644
--- a/src/memos/plugins/hooks.py
+++ b/src/memos/plugins/hooks.py
@@ -137,13 +136,0 @@ def hookable(name: str):
-            # No intercept hook registered.  If the request asks for a view that
-            # is only served by a plugin (e.g. project memory), and the plugin is
-            # not loaded, raise 400 instead of falling through to the core pipeline.
-            if getattr(request, "project_view_only_flag", False):
-                from fastapi import HTTPException
-
-                raise HTTPException(
-                    status_code=400,
-                    detail=(
-                        "memory view `project` is not enabled on this server; "
-                        "set MEMOS_ENABLED_PLUGINS=project_memory"
-                    ),
-                )
````
