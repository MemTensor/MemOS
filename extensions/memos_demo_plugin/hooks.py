"""Demo plugin hook callbacks.

Two groups:
  1. CE hook responders — plugin listens to CE-exposed extension points (add/search etc.)
  2. Plugin-owned hooks — extension points the plugin declares and triggers (demo.test / demo.report)

All callbacks are bound to the plugin instance via functools.partial(callback, plugin_instance).
"""

from __future__ import annotations

import logging

from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from memos_demo_plugin.plugin import DemoPlugin

logger = logging.getLogger(__name__)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  1. CE hook responders — listen to CE-exposed @hookable / trigger_hook extension points
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def log_operation(plugin: DemoPlugin, *, request, **kw) -> None:
    """[add.before / search.before] Log operation (notification-style)."""
    uid = getattr(request, "user_id", "unknown")
    plugin.request_log.append({"user_id": uid})
    logger.info("[Demo] operation logged user=%s", uid)


def count_add(plugin: DemoPlugin, *, request, result, **kw) -> None:
    """[add.after] Count add calls per user (notification-style)."""
    uid = getattr(request, "user_id", "unknown")
    plugin.add_counter[uid] = plugin.add_counter.get(uid, 0) + 1
    logger.info("[Demo] add count user=%s total=%d", uid, plugin.add_counter[uid])


def post_process_add(plugin: DemoPlugin, *, request, result, **kw):
    """[add.memories.post_process] Post-process add_memories result (pipe-style, returns result)."""
    uid = getattr(request, "user_id", "unknown")
    plugin.post_process_log.append({"user_id": uid, "result_count": len(result)})
    logger.info("[Demo] post_process_add user=%s count=%d", uid, len(result))
    return result


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  2. Plugin-owned hooks — declared by plugin and triggered in routes.py
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


def on_test_before(plugin: DemoPlugin, *, request, **kw):
    """[demo.test.before] @hookable auto-triggered, can modify request (pipe-style)."""
    uid = getattr(request, "user_id", "anonymous")
    plugin.hook_test_log.append({"phase": "before", "user_id": uid})
    logger.info("[Demo] test.before user=%s", uid)
    return request


def on_test_after(plugin: DemoPlugin, *, request, result, **kw):
    """[demo.test.after] @hookable auto-triggered, can modify result (pipe-style)."""
    uid = getattr(request, "user_id", "anonymous")
    plugin.hook_test_log.append({"phase": "after", "user_id": uid})
    result["hook_after_injected"] = True
    logger.info("[Demo] test.after user=%s", uid)
    return result


def on_test_post_process(plugin: DemoPlugin, *, request, result, **kw):
    """[demo.test.post_process] trigger_hook manual trigger, can modify result (pipe-style)."""
    uid = getattr(request, "user_id", "anonymous")
    plugin.hook_test_log.append({"phase": "post_process", "user_id": uid})
    result["hook_post_process_injected"] = True
    logger.info("[Demo] test.post_process user=%s", uid)
    return result


def enrich_report(plugin: DemoPlugin, *, user_id, report, **kw):
    """[demo.report.enrich] trigger_hook manual trigger, extend user activity report (pipe-style)."""
    report["total_users_tracked"] = len(plugin.add_counter)
    report["is_active_user"] = plugin.add_counter.get(user_id, 0) > 0
    report["enriched_by"] = plugin.name
    logger.info("[Demo] enrich_report user=%s", user_id)
    return report
