"""Plugin manager — discover, load, and manage MemOS plugins."""

from __future__ import annotations

import importlib.metadata
import logging

from typing import TYPE_CHECKING

from memos.plugins.base import MemOSPlugin


if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger(__name__)

ENTRY_POINT_GROUP = "memos.plugins"


class PluginManager:
    """Discover, load, and manage MemOS plugins."""

    def __init__(self):
        self._plugins: dict[str, MemOSPlugin] = {}
        self._discovered = False

    @property
    def plugins(self) -> dict[str, MemOSPlugin]:
        return dict(self._plugins)

    def discover(self) -> None:
        """Discover and load all installed plugins via entry_points."""
        if self._discovered:
            return

        try:
            eps = importlib.metadata.entry_points()
            if hasattr(eps, "select"):
                plugin_eps = eps.select(group=ENTRY_POINT_GROUP)
            else:
                plugin_eps = eps.get(ENTRY_POINT_GROUP, [])
        except Exception:
            logger.exception("Failed to query entry_points")
            return

        for ep in plugin_eps:
            try:
                plugin_cls = ep.load()
                plugin = plugin_cls()
                if not isinstance(plugin, MemOSPlugin):
                    logger.warning("Plugin %s does not extend MemOSPlugin, skipped", ep.name)
                    continue
                plugin.on_load()
                self._plugins[plugin.name] = plugin
                logger.info("Plugin discovered: %s v%s", plugin.name, plugin.version)
            except Exception:
                logger.exception("Failed to load plugin: %s", ep.name)

        self._discovered = True

    def init_components(self, context: dict) -> None:
        """Initialize runtime components contributed by loaded plugins."""
        for plugin in self._plugins.values():
            try:
                plugin.init_components(context)
                logger.info("Plugin components initialized: %s", plugin.name)
            except Exception:
                logger.exception("Failed to init plugin components: %s", plugin.name)

    def init_app(self, app: FastAPI) -> None:
        """Bind app and initialize all loaded plugins."""
        for plugin in self._plugins.values():
            try:
                plugin._bind_app(app)
                plugin.init_app()
                logger.info("Plugin initialized: %s", plugin.name)
            except Exception:
                logger.exception("Failed to init plugin: %s", plugin.name)

    def shutdown(self) -> None:
        """Shut down all plugins and release resources."""
        for plugin in self._plugins.values():
            try:
                plugin.on_shutdown()
            except Exception:
                logger.exception("Failed to shutdown plugin: %s", plugin.name)


plugin_manager = PluginManager()
