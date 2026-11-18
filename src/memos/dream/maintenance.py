"""Opt-in Dream lifecycle maintenance on the native atomic PostgreSQL backend.

Configure CommunityDreamPlugin through configs.dream_lifecycle, explicitly
register cube scopes, then call plugin.lifecycle.run_maintenance(cube_id).
A positive interval_seconds enables periodic maintenance of those same scopes;
zero keeps it manual. No new HTTP route or implicit tenant enumeration is added.

The public runner can also be used directly with DreamLifecycleService. Pass
stable event IDs and original timestamps to the service for SDK observation;
automatic final-result notifications cover the decorated API search path only.
"""

from memos.dream.lifecycle.runner import (
    DreamMaintenanceRunner,
    MaintenanceLimits,
    MaintenanceReport,
)
from memos.dream.lifecycle.runtime import DreamLifecycleRuntime, LifecycleRuntimeConfig
from memos.dream.lifecycle.service import DreamLifecycleService


__all__ = [
    "DreamLifecycleRuntime",
    "DreamLifecycleService",
    "DreamMaintenanceRunner",
    "LifecycleRuntimeConfig",
    "MaintenanceLimits",
    "MaintenanceReport",
]
