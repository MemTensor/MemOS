"""Dream plugin-owned hooks.

These hooks are plugin-scoped and allow extensions to observe or modify Dream
persistence behavior without changing the core pipeline.
"""

from memos.plugins.hook_defs import define_hook


class DreamH:
    DREAM_BEFORE_PERSIST = "dream.before_persist"
    DREAM_AFTER_PERSIST = "dream.after_persist"


define_hook(
    DreamH.DREAM_BEFORE_PERSIST,
    description="Allow plugins to inspect/modify Dream results before persistence",
    params=["mem_cube_id", "results"],
)

define_hook(
    DreamH.DREAM_AFTER_PERSIST,
    description="Allow plugins to react after Dream persistence completes",
    params=["mem_cube_id", "results"],
)
