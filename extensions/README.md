# MemOS 插件开发 README

这是一份面向新人的标准操作流程。按顺序执行即可完成以下全流程：

`环境搭建 -> 插件开发 -> 测试 -> 提交 -> 部署`

如需了解设计原理，请参考《MemOS 插件系统设计与开发指南》。

## 快速导航

1. [环境搭建](#环境搭建)
2. [创建插件](#创建插件)
3. [注册插件](#注册插件)
4. [编写测试](#编写测试)
5. [代码提交](#代码提交)
6. [部署与验证](#部署与验证)
7. [开发 Checklist](#开发-checklist)
8. [常用命令速查](#常用命令速查)
9. [文件模板清单](#文件模板清单)

## 环境搭建

这是一次性操作，首次接入时完成即可。

### 1. 克隆企业仓库

```bash
git clone git@github.com:MemTensor/MemOS-Enterprise.git
cd MemOS-Enterprise
```

### 2. 添加公开仓库 remote

```bash
git remote add public git@github.com:MemTensor/MemOS.git
```

### 3. 安装依赖与 Git Hooks

`make install` 会同时完成依赖安装，以及以下 Git Hooks 配置：

- `pre-commit`：代码检查
- `pre-push`：私有代码拦截

```bash
make install
```

### 4. 配置同步 alias（可选，推荐）

```bash
git config alias.sync-public '!bash scripts/sync-public.sh'
```

### 5. 环境验证

#### 插件框架测试

```bash
PYTHONPATH="src:extensions" python -m pytest tests/plugins/ -v
```

#### Demo 插件测试

```bash
PYTHONPATH="src:extensions" python -m pytest extensions/memos_demo_plugin/tests/ -v
```

#### 启动服务并验证插件加载

```bash
uvicorn memos.api.server_api:app --port 8001
curl http://127.0.0.1:8001/demo/health
```

预期返回：

```json
{"status":"ok","plugin":"demo","version":"0.1.0"}
```

## 创建插件

以下以开发 `memos_foo_plugin` 为例，实际使用时将 `foo` 替换为你的插件名。

### 1. 创建目录

```bash
mkdir -p extensions/memos_foo_plugin/tests
touch extensions/memos_foo_plugin/__init__.py
touch extensions/memos_foo_plugin/tests/__init__.py
```

### 2. 包入口

文件：`extensions/memos_foo_plugin/__init__.py`

```python
from memos_foo_plugin.plugin import FooPlugin

__all__ = ["FooPlugin"]
```

### 3. 编写 Plugin 主类

文件：`extensions/memos_foo_plugin/plugin.py`

```python
import logging
from functools import partial

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H

logger = logging.getLogger(__name__)


class FooPlugin(MemOSPlugin):
    name = "foo"
    version = "0.1.0"
    description = "Foo plugin - brief description"

    def on_load(self) -> None:
        self.counter: dict[str, int] = {}
        logger.info("[Foo] plugin loaded")

    def init_app(self) -> None:
        from memos_foo_plugin.hooks import on_add_after
        from memos_foo_plugin.routes import create_router

        self.register_router(create_router(self))
        self.register_hook(H.ADD_AFTER, partial(on_add_after, self))

        # from memos_foo_plugin.middleware import FooMiddleware
        # self.register_middleware(FooMiddleware)

        logger.info("[Foo] plugin initialized")

    def on_shutdown(self) -> None:
        logger.info("[Foo] plugin shutdown")
```

### 4. 编写路由

文件：`extensions/memos_foo_plugin/routes.py`

```python
from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter

if TYPE_CHECKING:
    from memos_foo_plugin.plugin import FooPlugin


def create_router(plugin: FooPlugin) -> APIRouter:
    router = APIRouter(prefix="/foo", tags=["foo"])

    @router.get("/health")
    async def health():
        return {"status": "ok", "plugin": plugin.name}

    @router.get("/stats")
    async def stats():
        return {"counter": plugin.counter}

    return router
```

### 5. 编写 Hook 回调

文件：`extensions/memos_foo_plugin/hooks.py`

```python
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from memos_foo_plugin.plugin import FooPlugin

logger = logging.getLogger(__name__)


def on_add_after(plugin: FooPlugin, *, request, result, **kw) -> None:
    """[add.after] Count add operations per user."""
    uid = getattr(request, "user_id", "unknown")
    plugin.counter[uid] = plugin.counter.get(uid, 0) + 1
    logger.info("[Foo] add counted user=%s total=%d", uid, plugin.counter[uid])
```

### 6. 编写中间件（可选）

文件：`extensions/memos_foo_plugin/middleware.py`

```python
import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

logger = logging.getLogger(__name__)


class FooMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.time()
        response = await call_next(request)
        elapsed_ms = (time.time() - start) * 1000
        logger.info(
            "[Foo] %s %s -> %s (%.1fms)",
            request.method,
            request.url.path,
            response.status_code,
            elapsed_ms,
        )
        return response
```

### 7. 自定义 Hook（可选）

如果插件需要自己定义并触发 Hook，而不只是监听 CE 提供的 Hook，可以新增 `hook_defs.py`。

文件：`extensions/memos_foo_plugin/hook_defs.py`

```python
from memos.plugins.hook_defs import define_hook


class FooH:
    """Foo plugin hook name constants."""

    RESULT_ENRICH = "foo.result.enrich"


define_hook(
    FooH.RESULT_ENRICH,
    description="Enrich result data after processing",
    params=["user_id", "result"],
    pipe_key="result",
)
```

在路由或业务逻辑中触发：

```python
from memos.plugins.hooks import trigger_hook
from memos_foo_plugin.hook_defs import FooH

rv = trigger_hook(FooH.RESULT_ENRICH, user_id="alice", result=data)
data = rv if rv is not None else data
```

在 `plugin.py` 中注册回调：

```python
from memos_foo_plugin.hook_defs import FooH

self.register_hook(FooH.RESULT_ENRICH, partial(enrich_result, self))
```

## 注册插件

需要在 `pyproject.toml` 中添加两处配置。

### 1. 声明包路径

```toml
[tool.poetry]
packages = [
    {include = "memos", from = "src"},
    {include = "memos_foo_plugin", from = "extensions"},
]
```

### 2. 注册 entry point

```toml
[project.entry-points."memos.plugins"]
demo = "memos_demo_plugin:DemoPlugin"
foo = "memos_foo_plugin:FooPlugin"
```

### 3. 重新安装使 entry point 生效

```bash
pip install -e .
```

> 注意：
> 仅修改已安装插件的代码时，在 editable 模式下通常重启服务即可。
> 如果是新增插件，或修改了 `pyproject.toml`，则必须重新安装。

## 编写测试

### 1. `conftest.py`

文件：`extensions/memos_foo_plugin/tests/conftest.py`

```python
"""Ensure hooks used by FooPlugin are declared for testing."""

from memos.plugins.hooks import hookable

# Declare CE hooks (normally declared at import time of handler modules)
hookable("add")
hookable("search")

# If plugin has custom hook_defs, import to trigger declarations:
# import memos_foo_plugin.hook_defs  # noqa: F401
```

### 2. 生命周期测试

文件：`extensions/memos_foo_plugin/tests/test_lifecycle.py`

```python
from fastapi import FastAPI


def _init_plugin(plugin, app):
    plugin._bind_app(app)
    plugin.init_app()


class TestFooPluginLifecycle:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_metadata(self):
        from memos_foo_plugin.plugin import FooPlugin

        plugin = FooPlugin()
        assert plugin.name == "foo"
        assert plugin.version == "0.1.0"

    def test_on_load_state(self):
        from memos_foo_plugin.plugin import FooPlugin

        plugin = FooPlugin()
        plugin.on_load()
        assert plugin.counter == {}

    def test_full_lifecycle(self):
        from memos_foo_plugin.plugin import FooPlugin

        app = FastAPI()
        plugin = FooPlugin()
        plugin.on_load()
        _init_plugin(plugin, app)

        paths = [r.path for r in app.routes]
        assert "/foo/health" in paths
        assert "/foo/stats" in paths

        plugin.on_shutdown()
```

### 3. Hook 回调测试

文件：`extensions/memos_foo_plugin/tests/test_hooks.py`

```python
from fastapi import FastAPI


def _make_plugin():
    from memos_foo_plugin.plugin import FooPlugin

    app = FastAPI()
    plugin = FooPlugin()
    plugin.on_load()
    plugin._bind_app(app)
    plugin.init_app()
    return plugin


class TestHookCallbacks:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_add_after_counts(self):
        from memos.plugins.hooks import trigger_hook

        plugin = _make_plugin()

        class Req:
            user_id = "alice"

        trigger_hook("add.after", request=Req(), result={})
        trigger_hook("add.after", request=Req(), result={})
        assert plugin.counter["alice"] == 2
```

### 4. 路由测试

文件：`extensions/memos_foo_plugin/tests/test_routes.py`

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_app():
    from memos_foo_plugin.plugin import FooPlugin

    app = FastAPI()
    plugin = FooPlugin()
    plugin.on_load()
    plugin._bind_app(app)
    plugin.init_app()
    return app, plugin


class TestRoutes:
    def setup_method(self):
        from memos.plugins.hooks import _hooks

        _hooks.clear()

    def test_health(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/foo/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"

    def test_stats_empty(self):
        app, _ = _make_app()
        client = TestClient(app)
        resp = client.get("/foo/stats")
        assert resp.json()["counter"] == {}
```

### 5. 运行测试

```bash
PYTHONPATH="src:extensions" python -m pytest extensions/memos_foo_plugin/tests/ -v
```

## 代码提交

### 1. 提交到企业仓库

```bash
git add -A
git commit -m "feat: add foo plugin"
git push origin feature/foo
```

这是标准 Git 流程，完整代码推送到企业仓库。

### 2. 同步 CE 代码到公开仓库

如果本次改动包含 CE 代码，例如 `src/memos/`、`tests/plugins/` 等，需要执行同步。

同步最近一次 commit 的 CE 改动：

```bash
git sync-public "feat: add plugin framework enhancement"
```

同步指定 commit：

```bash
git sync-public "fix: hook trigger" abc1234
```

或使用 `make`：

```bash
make sync-public msg="feat: add plugin framework enhancement"
```

推送后，在 GitHub 创建 PR 合入 `public/main`。

### 3. 判断是否需要 `sync-public`

| 改动内容 | 需要 `sync-public` |
| --- | --- |
| `extensions/` 下的插件代码 | ❌ |
| `pyproject.toml` / `poetry.lock` | ❌ |
| `scripts/` / `Makefile` / `.private-paths` | ❌ |
| `src/memos/plugins/` 框架代码 | ✅ |
| `src/memos/api/` 中新增 `@hookable` | ✅ |
| `tests/plugins/` 框架测试 | ✅ |

### 4. 新增私有路径

如果新增了不应同步到公开仓库的文件或目录，请编辑 `.private-paths`，每行添加一个路径。

```text
extensions/
pyproject.toml
poetry.lock
.private-paths
scripts/sync-public.sh
scripts/check-public-push.sh
Makefile
docs/internal/
```

## 部署与验证

### 1. 启动服务

```bash
uvicorn memos.api.server_api:app --port 8001
```

启动日志中应看到：

```text
INFO: Plugin discovered: foo v0.1.0
INFO: Plugin initialized: foo
```

### 2. 验证接口

插件健康检查：

```bash
curl http://127.0.0.1:8001/foo/health
```

插件业务接口：

```bash
curl http://127.0.0.1:8001/foo/stats
```

### 3. 验证 Hook 生效

通过调用 CE 接口触发 Hook，再检查插件状态。

触发 `add` 接口，使插件的 `add.after` hook 被调用：

```bash
curl -X POST http://127.0.0.1:8001/product/add \
  -H "Content-Type: application/json" \
  -d '{"user_id": "test_user", ...}'
```

查看插件统计：

```bash
curl http://127.0.0.1:8001/foo/stats
```

预期返回：

```json
{"counter": {"test_user": 1}}
```

## 开发 Checklist

开发完成后，逐项确认：

- [ ] `Plugin` 类继承 `MemOSPlugin`
- [ ] 已实现 `name`、`version`、`description`
- [ ] 已在 `init_app()` 中注册路由
- [ ] Hook 回调使用 `self.register_hook(...)` 正确注册
- [ ] 如有中间件，已使用 `self.register_middleware(...)` 注册
- [ ] 已在 `pyproject.toml` 中声明包路径
- [ ] 已在 entry points 中注册插件
- [ ] 测试通过：插件测试可完整运行
- [ ] 服务启动日志出现插件发现与初始化信息
- [ ] 插件接口返回预期结果
- [ ] 代码已推送到企业仓库
- [ ] 如涉及 CE 代码，已完成 `sync-public`

## 常用命令速查

| 操作 | 命令 |
| --- | --- |
| 安装依赖 + hooks | `make install` |
| 运行全部测试 | `PYTHONPATH="src:extensions" python -m pytest tests/plugins/ extensions/ -v` |
| 运行单个插件测试 | `PYTHONPATH="src:extensions" python -m pytest extensions/memos_foo_plugin/tests/ -v` |
| 启动服务 | `uvicorn memos.api.server_api:app --port 8001` |
| 代码格式化 | `make format` |
| 代码检查 | `make pre_commit` |
| 提交到企业仓库 | `git commit + git push origin <branch>` |
| 同步 CE 到公开仓库 | `git sync-public "message"` |
| 同步指定 commit | `git sync-public "message" <commit-hash>` |

## 文件模板清单

新建插件时，通常需要创建如下文件：

```text
extensions/memos_foo_plugin/
├── __init__.py           # 必须：包入口，re-export Plugin 类
├── plugin.py             # 必须：继承 MemOSPlugin，注册能力
├── routes.py             # 按需：FastAPI 路由
├── hooks.py              # 按需：Hook 回调函数
├── middleware.py         # 按需：Starlette 中间件
├── hook_defs.py          # 按需：插件自有 Hook 声明（有自定义 Hook 时需要）
└── tests/
    ├── __init__.py       # 必须
    ├── conftest.py       # 必须：声明测试中用到的 Hook
    ├── test_lifecycle.py # 推荐：生命周期测试
    ├── test_hooks.py     # 推荐：Hook 回调测试
    └── test_routes.py    # 推荐：路由端点测试
```

也可以直接复制 `extensions/memos_demo_plugin/` 作为模板，然后全局替换 `demo -> foo`、`Demo -> Foo`。
