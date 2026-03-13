"""memos_demo_plugin tests — ensure hooks used by the plugin are declared.

CE @hookable declarations are triggered by manually calling hookable().
Plugin-owned hook declarations are triggered by importing the hook_defs module (module-level define_hook calls).
"""

from memos.plugins.hooks import hookable


hookable("add")
hookable("search")
hookable("demo.test")

import memos_demo_plugin.hook_defs  # noqa: E402, F401 — triggers plugin-owned hook declarations
