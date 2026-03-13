"""Ensure hooks used by PromptStrategyPlugin are declared for testing."""

from memos.plugins.hooks import hookable


hookable("add")
hookable("search")

import memos.plugins.hook_defs  # noqa: E402, F401 — triggers CE hook declarations
