"""Ensure @hookable-generated hooks are declared for core framework tests.

In production, @hookable("add") runs at import time of add_handler.py,
declaring add.before / add.after. Core framework tests don't import handler
modules (to avoid heavy dependencies), so we trigger declarations here.

Plugin-specific hooks are declared in each plugin's own tests/conftest.py.
"""

from memos.plugins.hooks import hookable


hookable("add")
hookable("search")
hookable("chat")
hookable("feedback")
hookable("memory.get")
