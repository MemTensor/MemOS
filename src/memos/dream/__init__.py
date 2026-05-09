"""Built-in Dream plugin package.

The default Dream implementation lives inside the core repository so it can be
discovered like any other MemOS plugin. Enterprise builds can swap the entry
point to an external plugin without changing the scheduler contract.
"""

from memos.dream.plugin import CommunityDreamPlugin


__all__ = ["CommunityDreamPlugin"]
