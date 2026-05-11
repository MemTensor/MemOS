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

    @staticmethod
    def _select_plugin_winners(
        candidates: list[tuple[str, MemOSPlugin]],
    ) -> dict[str, MemOSPlugin]:
        """Resolve duplicate logical plugin names by priority.

        Multiple installed distributions may expose the same plugin capability
        (for example CE and EE variants of the Dream plugin). In that case we
        keep only the highest-priority implementation and skip the rest.

        If the highest priority is shared by more than one plugin implementation,
        startup should fail loudly because plugin activation would be ambiguous.
        """

        grouped: dict[str, list[tuple[str, MemOSPlugin]]] = {}
        for entry_point_name, plugin in candidates:
            grouped.setdefault(plugin.name, []).append((entry_point_name, plugin))

        winners: dict[str, MemOSPlugin] = {}
        for plugin_name, group in grouped.items():
            group.sort(key=lambda item: item[1].priority, reverse=True)
            winner_ep_name, winner = group[0]
            tied = [item for item in group if item[1].priority == winner.priority]
            if len(tied) > 1:
                tied_names = ", ".join(
                    f"{entry_point_name}({plugin.__class__.__name__})"
                    for entry_point_name, plugin in tied
                )
                raise RuntimeError(
                    "Multiple plugins share the same logical name and highest priority: "
                    f"name='{plugin_name}', priority={winner.priority}, providers=[{tied_names}]"
                )

            for loser_ep_name, loser in group[1:]:
                logger.info(
                    "Plugin implementation skipped due to lower priority: name=%s, "
                    "winner=%s(%s, priority=%s), skipped=%s(%s, priority=%s)",
                    plugin_name,
                    winner_ep_name,
                    winner.__class__.__name__,
                    winner.priority,
                    loser_ep_name,
                    loser.__class__.__name__,
                    loser.priority,
                )

            winners[plugin_name] = winner
        return winners

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

        candidates: list[tuple[str, MemOSPlugin]] = []
        for ep in plugin_eps:
            try:
                plugin_cls = ep.load()
                plugin = plugin_cls()
                if not isinstance(plugin, MemOSPlugin):
                    logger.warning("Plugin %s does not extend MemOSPlugin, skipped", ep.name)
                    continue
                candidates.append((ep.name, plugin))
            except Exception:
                logger.exception("Failed to load plugin: %s", ep.name)

        winners = self._select_plugin_winners(candidates)
        for plugin_name, plugin in winners.items():
            plugin.on_load()
            self._plugins[plugin_name] = plugin
            logger.info(
                "Plugin discovered: %s v%s (priority=%s)",
                plugin.name,
                plugin.version,
                plugin.priority,
            )

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
