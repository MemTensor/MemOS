"""
Demo plugin main logic — complete demonstration of MemOS plugin's three extension capabilities.

Scope:
  1. Register routes   — self.register_router()
  2. Register middleware — self.register_middleware()
  3. Register hooks   — self.register_hook() / self.register_hooks()

Both community developers and enterprise self-hosted deployments can reference this plugin structure.
Package naming convention: memos-xx-plugin / memos_xx_plugin.
"""

import logging

from functools import partial

from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H
from memos_demo_plugin.hook_defs import DemoH


logger = logging.getLogger(__name__)


class DemoPlugin(MemOSPlugin):
    name = "demo"
    version = "0.1.0"
    description = "Demo plugin — showcases routes, middleware, and hooks"

    # ── Lifecycle ────────────────────────────────────────────────────

    def on_load(self) -> None:
        self.add_counter: dict[str, int] = {}
        self.request_log: list[dict] = []
        self.post_process_log: list[dict] = []
        self.hook_test_log: list[dict] = []
        logger.info("[Demo] plugin loaded")

    def init_app(self) -> None:
        from memos_demo_plugin.hooks import (
            count_add,
            enrich_report,
            log_operation,
            on_test_after,
            on_test_before,
            on_test_post_process,
            post_process_add,
        )
        from memos_demo_plugin.middleware import DemoAuditMiddleware
        from memos_demo_plugin.routes import create_router

        # 1) Routes
        self.register_router(create_router(self))

        # 2) Middleware
        self.register_middleware(DemoAuditMiddleware)

        # 3) Hooks — respond to CE @hookable extension points
        self.register_hook(H.ADD_AFTER, partial(count_add, self))
        self.register_hooks([H.ADD_BEFORE, H.SEARCH_BEFORE], partial(log_operation, self))
        self.register_hook(H.ADD_MEMORIES_POST_PROCESS, partial(post_process_add, self))

        # 4) Hooks — plugin-owned extension points (constants from DemoH)
        self.register_hook(DemoH.TEST_BEFORE, partial(on_test_before, self))
        self.register_hook(DemoH.TEST_AFTER, partial(on_test_after, self))
        self.register_hook(DemoH.TEST_POST_PROCESS, partial(on_test_post_process, self))
        self.register_hook(DemoH.REPORT_ENRICH, partial(enrich_report, self))

        logger.info("[Demo] plugin initialized")

    def on_shutdown(self) -> None:
        logger.info(
            "[Demo] plugin shutdown — users=%d, ops=%d, post_process=%d, hook_tests=%d",
            len(self.add_counter),
            len(self.request_log),
            len(self.post_process_log),
            len(self.hook_test_log),
        )
