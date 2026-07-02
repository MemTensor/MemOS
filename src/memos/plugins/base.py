"""MemOS plugin base class — all plugins must inherit from this class."""

from __future__ import annotations

from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi import FastAPI
    from starlette.middleware.base import BaseHTTPMiddleware


class MemOSPlugin:
    """MemOS plugin base class.

    Provides three unified registration methods. Plugin developers need only
    inherit from this class and register capabilities via self.register_*
    in init_app.

    `priority` is used only when multiple installed distributions expose the
    same logical plugin name. In that case the PluginManager keeps the highest
    priority implementation and skips the rest.
    """

    name: str = "unnamed"
    version: str = "0.0.0"
    description: str = ""
    priority: int = 0

    _app: FastAPI | None = None

    # ------------------------------------------------------------------ #
    #  Registration methods — called by plugins in init_app
    # ------------------------------------------------------------------ #

    def register_router(self, router, **kwargs) -> None:
        """Register a router."""
        self._app.include_router(router, **kwargs)

    def register_middleware(self, middleware_cls: type[BaseHTTPMiddleware], **kwargs) -> None:
        """Register middleware."""
        self._app.add_middleware(middleware_cls, **kwargs)

    def register_hook(self, name: str, callback: Callable) -> None:
        """Register a single Hook callback."""
        from memos.plugins.hooks import register_hook

        register_hook(name, callback)

    def register_hooks(self, names: list[str], callback: Callable) -> None:
        """Batch-register the same callback to multiple Hook points."""
        from memos.plugins.hooks import register_hooks

        register_hooks(names, callback)

    # ------------------------------------------------------------------ #
    #  Internal methods — called by PluginManager, plugin developers need not care
    # ------------------------------------------------------------------ #

    def _bind_app(self, app: FastAPI) -> None:
        """Bind FastAPI instance so that register_* methods are available."""
        self._app = app

    # ------------------------------------------------------------------ #
    #  Lifecycle methods — override in subclasses
    # ------------------------------------------------------------------ #

    def on_load(self) -> None:
        """Called after the plugin is discovered. Used for initialization logic, e.g. checking dependencies, reading config."""

    def init_app(self) -> None:
        """Called after FastAPI app is bound. Register routes, middleware, and Hooks via self.register_* here."""

    def init_components(self, context: dict) -> None:
        """Called during server bootstrap to contribute runtime components."""

    def on_shutdown(self) -> None:
        """Called when the service shuts down. Used for resource cleanup."""
