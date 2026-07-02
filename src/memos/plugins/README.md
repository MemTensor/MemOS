# MemOS Plugin System

This document explains how to use and extend the open-source MemOS plugin system.

MemOS keeps the plugin framework in `src/memos/plugins`. A plugin can contribute
FastAPI routes, middleware, runtime components, and Hook callbacks without
modifying the core request handlers directly. The built-in open-source Dream
feature is implemented this way and is registered as the `dream` plugin.

## Quick Navigation

1. [Architecture](#architecture)
2. [Plugin Lifecycle](#plugin-lifecycle)
3. [Creating a Plugin](#creating-a-plugin)
4. [Registering a Plugin](#registering-a-plugin)
5. [Using Hooks](#using-hooks)
6. [Testing](#testing)
7. [Runtime Verification](#runtime-verification)
8. [Development Checklist](#development-checklist)

## Architecture

The core framework lives in:

```text
src/memos/plugins/
├── base.py                # MemOSPlugin base class
├── manager.py             # Plugin discovery, loading, and initialization
├── hooks.py               # Hook registration and trigger runtime
├── hook_defs.py           # Core Hook declarations and constants
└── component_bootstrap.py # Runtime component context bootstrap helpers
```

Plugins are discovered through the Python entry point group:

```toml
[project.entry-points."memos.plugins"]
dream = "memos.dream:CommunityDreamPlugin"
```

At startup, `PluginManager` loads installed entry points, instantiates plugins,
keeps the highest-priority implementation when multiple providers expose the
same logical plugin name, and initializes enabled plugins.

## Plugin Lifecycle

All plugins inherit from `memos.plugins.base.MemOSPlugin`.

```python
class MemOSPlugin:
    name: str = "unnamed"
    version: str = "0.0.0"
    description: str = ""
    priority: int = 0

    def on_load(self) -> None:
        ...

    def init_components(self, context: dict) -> None:
        ...

    def init_app(self) -> None:
        ...

    def on_shutdown(self) -> None:
        ...
```

Lifecycle methods are called in this order:

1. `on_load()`: called after discovery. Use it for lightweight state setup and
   Hook registration that does not require a FastAPI app.
2. `init_components(context)`: called during server bootstrap. Use it when the
   plugin needs access to shared runtime components such as scheduler handles or
   memory backends.
3. `init_app()`: called after the FastAPI app is bound. Register routers,
   middleware, and app-bound integrations here.
4. `on_shutdown()`: called when the service shuts down. Release resources here.

Plugins can register capabilities with:

```python
self.register_router(router)
self.register_middleware(MiddlewareClass)
self.register_hook("hook.name", callback)
self.register_hooks(["hook.a", "hook.b"], callback)
```

## Creating a Plugin

The simplest plugin is a Python package that exposes a `MemOSPlugin` subclass.
The example below uses `memos_foo_plugin` as the package name.

```text
memos_foo_plugin/
├── __init__.py
├── plugin.py
├── routes.py
├── hooks.py
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_lifecycle.py
    ├── test_hooks.py
    └── test_routes.py
```

### Package Entry

`memos_foo_plugin/__init__.py`

```python
from memos_foo_plugin.plugin import FooPlugin

__all__ = ["FooPlugin"]
```

### Plugin Class

`memos_foo_plugin/plugin.py`

```python
import logging
from functools import partial

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H

logger = logging.getLogger(__name__)


class FooPlugin(MemOSPlugin):
    name = "foo"
    version = "0.1.0"
    description = "Foo plugin"

    def on_load(self) -> None:
        self.counter: dict[str, int] = {}
        logger.info("[Foo] plugin loaded")

    def init_app(self) -> None:
        from memos_foo_plugin.hooks import on_add_after
        from memos_foo_plugin.routes import create_router

        self.register_router(create_router(self))
        self.register_hook(H.ADD_AFTER, partial(on_add_after, self))

        logger.info("[Foo] plugin initialized")

    def on_shutdown(self) -> None:
        logger.info("[Foo] plugin shutdown")
```

### Routes

`memos_foo_plugin/routes.py`

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

### Hook Callback

`memos_foo_plugin/hooks.py`

```python
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from memos_foo_plugin.plugin import FooPlugin


def on_add_after(plugin: FooPlugin, *, request, result, **kwargs) -> None:
    user_id = getattr(request, "user_id", "unknown")
    plugin.counter[user_id] = plugin.counter.get(user_id, 0) + 1
```

### Middleware

Middleware is optional. If a plugin needs one, register it in `init_app()`.

```python
from starlette.middleware.base import BaseHTTPMiddleware


class FooMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers["X-MemOS-Plugin"] = "foo"
        return response
```

```python
self.register_middleware(FooMiddleware)
```

## Registering a Plugin

Plugins are registered with the `memos.plugins` entry point group.

For a plugin shipped inside this repository, add an entry point in
`pyproject.toml`:

```toml
[project.entry-points."memos.plugins"]
foo = "memos_foo_plugin:FooPlugin"
```

For a plugin distributed as a separate Python package, declare the same entry
point in that package's project metadata. After installing the package into the
same environment as MemOS, the plugin manager can discover it automatically.

Reinstall the package after adding or changing entry points:

```bash
pip install -e .
```

If you only changed the implementation of an already installed editable plugin,
restarting the service is usually enough.

### Disabling Plugins

Set `MEMOS_DISABLED_PLUGINS` to a comma-separated list of logical plugin names:

```bash
MEMOS_DISABLED_PLUGINS=dream,foo uvicorn memos.api.server_api:app --port 8001
```

### Plugin Priority

`priority` resolves duplicate logical plugin names. If two installed packages
provide `name = "dream"`, MemOS keeps the implementation with the higher
priority. If the highest priority is tied, startup fails so the ambiguity is
visible.

## Using Hooks

Core Hook names are defined in `memos.plugins.hook_defs.H`.

Common extension points include:

```python
H.ADD_BEFORE
H.ADD_AFTER
H.SEARCH_BEFORE
H.SEARCH_AFTER
H.SEARCH_MEMORY_RESULTS
H.MEM_READER_PRE_EXTRACT
H.MEMORY_ITEMS_AFTER_FINE_EXTRACT
H.DREAM_EXECUTE
```

Hook callbacks receive keyword arguments. Some Hooks define a `pipe_key`; when a
callback returns a non-`None` value, that value replaces the named argument for
later callbacks and for the caller.

For example, `add.after` can replace `result`:

```python
def on_add_after(*, request, result, **kwargs):
    result.metadata["handled_by"] = "foo"
    return result
```

### Defining Plugin-Owned Hooks

Plugins may define their own Hook names when they need internal extension
points. Keep those declarations inside the plugin package rather than adding
plugin-specific names to `memos.plugins.hook_defs`.

`memos_foo_plugin/hook_defs.py`

```python
from memos.plugins.hook_defs import define_hook


class FooH:
    RESULT_ENRICH = "foo.result.enrich"


define_hook(
    FooH.RESULT_ENRICH,
    description="Enrich Foo result data",
    params=["user_id", "result"],
    pipe_key="result",
)
```

Trigger it from plugin code:

```python
from memos.plugins.hooks import trigger_hook
from memos_foo_plugin.hook_defs import FooH

updated = trigger_hook(FooH.RESULT_ENRICH, user_id="alice", result=data)
data = updated if updated is not None else data
```

## Built-In Dream Plugin

The open-source Dream implementation is a built-in plugin:

```text
src/memos/dream/
├── __init__.py
├── plugin.py
├── hooks.py
├── hook_defs.py
├── pipeline/
└── routers/
```

It is registered in `pyproject.toml`:

```toml
[project.entry-points."memos.plugins"]
dream = "memos.dream:CommunityDreamPlugin"
```

`CommunityDreamPlugin` demonstrates the recommended pattern:

- initialize state in `on_load()`
- register scheduler-facing Hooks such as `H.DREAM_EXECUTE`
- bind shared runtime context in `init_components()`
- register HTTP routes in `init_app()`
- keep pipeline stages replaceable behind clear module boundaries

Use it as the primary in-repository reference when extending the plugin system.

## Testing

Framework tests live under `tests/plugins/`. Plugin-specific tests should live
next to the plugin package or under an appropriate `tests/<plugin_name>/`
directory.

### Test Hook Declarations

Tests that trigger `@hookable`-generated Hooks should declare those Hooks before
registration. A small `conftest.py` is usually enough:

```python
from memos.plugins.hooks import hookable

hookable("add")
hookable("search")

# Import plugin-owned hook definitions when needed:
# import memos_foo_plugin.hook_defs  # noqa: F401
```

### Lifecycle Test

```python
from fastapi import FastAPI


def test_foo_plugin_lifecycle():
    from memos_foo_plugin.plugin import FooPlugin

    app = FastAPI()
    plugin = FooPlugin()
    plugin.on_load()
    plugin._bind_app(app)
    plugin.init_app()

    paths = [route.path for route in app.routes]
    assert "/foo/health" in paths
```

### Running Tests

Run the plugin framework tests:

```bash
python -m pytest tests/plugins/ -v
```

Run Dream plugin tests:

```bash
python -m pytest tests/dream/ -v
```

Run a plugin's own tests:

```bash
python -m pytest path/to/plugin/tests/ -v
```

## Runtime Verification

Start the API server:

```bash
uvicorn memos.api.server_api:app --port 8001
```

Startup logs should show discovered and initialized plugins:

```text
INFO: Plugin discovered: dream v0.1.0 (priority=10)
INFO: Plugin initialized: dream
```

If your plugin registers a health route, verify it with:

```bash
curl http://127.0.0.1:8001/foo/health
```

## Development Checklist

- [ ] Plugin class inherits from `MemOSPlugin`
- [ ] `name`, `version`, and `description` are set
- [ ] `priority` is set when duplicate providers may exist
- [ ] State setup belongs in `on_load()`
- [ ] Shared runtime component wiring belongs in `init_components()`
- [ ] Routes and middleware are registered in `init_app()`
- [ ] Hook callbacks are registered with `self.register_hook(...)`
- [ ] Plugin-owned Hooks are declared inside the plugin package
- [ ] Entry point is declared under `memos.plugins`
- [ ] Package is reinstalled after entry point changes
- [ ] Tests cover lifecycle, Hook callbacks, and routes where applicable
- [ ] Service startup logs show the plugin was discovered and initialized
