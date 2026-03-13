"""Admin routes for the Prompt Strategy plugin."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter


if TYPE_CHECKING:
    from memos_prompt_strategy_plugin.plugin import PromptStrategyPlugin


def create_router(plugin: PromptStrategyPlugin) -> APIRouter:
    router = APIRouter(prefix="/prompt_strategy", tags=["prompt_strategy"])

    @router.get("/health")
    async def health():
        return {"status": "ok", "plugin": plugin.name, "version": plugin.version}

    @router.get("/strategies")
    async def list_strategies():
        """Return all registered prompt strategies."""
        return {
            name: {"description": s.description}
            for name, s in plugin.registry.all_strategies().items()
        }

    @router.get("/stats")
    async def classification_stats():
        """Return per-category classification hit counts."""
        return {"stats": dict(plugin.stats)}

    return router
