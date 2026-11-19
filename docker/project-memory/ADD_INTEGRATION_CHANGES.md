# Add 对接改动记录

以 `promem_dev-rjf` 为底座，沿用现有 API Handler、调度器和项目记忆模块分工。

## 调度器的延迟与确认

| 入口 | 原行为 | 改动与必要性 |
| --- | --- | --- |
| `mem_scheduler/schemas/task_schemas.py`、`task_schedule_modules/dispatcher.py` | Handler 返回或抛错后，整批消息同步标记结果并在 Redis 中确认。 | 新增与 Enterprise 一致的逐消息延迟和跳过 ACK 标志。持久化接力暂时失败时，指定消息仍可被其他 worker 接管。普通消息继续沿用原有的完成、失败与 ACK 行为。 |

`tests/mem_scheduler/test_deferred_delivery.py` 检查同一批成功、重投和待认领消息的状态，以及 handler 抛错时的确认行为。

## 格式检查的基线修复

`project_view.py` 的三处说明、`experience.py` 和 `service.py` 的仅类型导入，以及旧接口测试的类属性类型，均为通过当前分支的全仓 Ruff 检查所需。项目记忆旧接口回归和调度器回归共 37 项通过。

## 四个 Add 调度阶段

`task_schemas.py`、`registry.py` 和 `project_memory_handler.py` 原来只登记单阶段整理。新增抽取、归类、合并准备和提交四个调度入口，由 `hook_defs.py` 声明与项目记忆实现的交接。每个阶段可独立接管，未装配回调时保留待确认消息。已有单阶段入口供迁移前的旧队列处理。

`tests/mem_scheduler/test_project_add_registry.py` 检查四个阶段的路由、优先级、接管间隔和回调缺失行为。

## AddHandler 分流

`api/handlers/add_handler.py` 和 `project_memory/plugin.py` 原用拦截钩子及按请求对象编号暂存混合结果。现由 AddHandler 直接调用项目受理并组装响应，个人分支沿用原有 Cube 和反馈处理。混合写入共享受理返回的 Task ID，完整重放复用已有任务。既有的完整请求日志改为记录调用模式，避免将原文写进日志。

`tests/api/test_add_project_routing.py` 检查项目单写、混合写入和重放，旧项目记忆接口由 `tests/project_memory/` 回归。

通用 \`plugins/hooks.py\` 拦截器现在只执行注册的回调。项目视图是否可用由 Add 和 Search 入口校验，避免通用拦截器在 AddHandler 分流之前拒绝有效请求。插件、项目 HTTP 和核心路由回归共 115 项通过。

## 状态查询与投递诊断

状态路由、Scheduler 状态读取和 TaskStatusTracker 增加项目阶段过滤。Redis 的阶段投递结果仍可用于调度诊断，公开项目状态以 Episode 为准，避免中间阶段覆盖混合任务或触发业务完成通知。API 回归覆盖项目阶段失败、个人写入完成以及运行中优先级。
