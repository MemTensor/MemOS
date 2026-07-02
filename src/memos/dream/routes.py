"""Backward-compatible Dream route exports.

New code should import from `memos.dream.routers.*`. This module remains only so
in-progress branches that import `create_router` do not break during refactors.
"""

from memos.dream.routers.diary_router import create_diary_router
from memos.dream.routers.trigger_router import create_trigger_router


def create_router(plugin):
    """Deprecated helper retained for compatibility.

    It returns the trigger router because older callers expected a single router.
    Updated plugins should register trigger and diary routers separately.
    """

    return create_trigger_router(plugin)


__all__ = ["create_diary_router", "create_router", "create_trigger_router"]
