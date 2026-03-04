"""Demo plugin routes — demonstrates full usage of plugin-registered routes + both hook trigger styles."""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter
from pydantic import BaseModel

from memos.plugins.hooks import hookable, trigger_hook
from memos_demo_plugin.hook_defs import DemoH


if TYPE_CHECKING:
    from memos_demo_plugin.plugin import DemoPlugin


# ── Request models ────────────────────────────────────────────────────────


class TestHookRequest(BaseModel):
    user_id: str = "anonymous"
    message: str = "hello"


# ── Router factory ────────────────────────────────────────────────────────


def create_router(plugin: DemoPlugin) -> APIRouter:
    router = APIRouter(prefix="/demo", tags=["demo"])

    # ── Basic routes ──

    @router.get("/health")
    async def health():
        return {"status": "ok", "plugin": plugin.name, "version": plugin.version}

    @router.get("/stats")
    async def stats():
        return {
            "add_counter": plugin.add_counter,
            "total_adds": sum(plugin.add_counter.values()),
            "recent_requests": plugin.request_log[-20:],
        }

    # ── Hook demo routes ──

    class _HookDemoHandler:
        """Demonstrates @hookable decorator: auto-triggers demo.test.before / demo.test.after."""

        @hookable("demo.test")
        def handle(self, request: TestHookRequest):
            result = {
                "user_id": request.user_id,
                "echo": request.message,
                "processed": True,
            }
            rv = trigger_hook(DemoH.TEST_POST_PROCESS, request=request, result=result)
            return rv if rv is not None else result

    handler = _HookDemoHandler()

    @router.post("/test-hook")
    async def test_hook(req: TestHookRequest):
        """Full hook demo endpoint.

        Call chain:
        1. demo.test.before       — @hookable auto, pipe-style, can modify request
        2. handler business logic
        3. demo.test.post_process — trigger_hook manual, pipe-style, can modify result
        4. demo.test.after        — @hookable auto, pipe-style, can modify result
        5. demo.report.enrich     — trigger_hook manual, pipe-style, can modify report
        """
        result = handler.handle(req)

        report = {
            "user_id": req.user_id,
            "add_count": plugin.add_counter.get(req.user_id, 0),
            "operation_count": sum(
                1 for r in plugin.request_log if r.get("user_id") == req.user_id
            ),
        }
        rv = trigger_hook(DemoH.REPORT_ENRICH, user_id=req.user_id, report=report)
        report = rv if rv is not None else report

        return {
            "hook_test": result,
            "user_report": report,
            "plugin_state": {"hook_test_log": plugin.hook_test_log[-10:]},
        }

    return router
