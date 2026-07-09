from memos.plugins.base import MemOSPlugin
from memos.plugins.hook_defs import H, HookSpec, all_hook_specs, define_hook, get_hook_spec
from memos.plugins.hooks import hookable, register_hook, register_hooks, trigger_hook
from memos.plugins.manager import PluginManager, plugin_manager


__all__ = [
    "H",
    "HookSpec",
    "MemOSPlugin",
    "PluginManager",
    "all_hook_specs",
    "define_hook",
    "get_hook_spec",
    "hookable",
    "plugin_manager",
    "register_hook",
    "register_hooks",
    "trigger_hook",
]
