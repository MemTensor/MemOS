# -*- coding: utf-8 -*-
"""MemOS Cloud memory plugin for CoPaw.

Registers MemOSMemoryManager as a pluggable memory backend so that
CoPaw agents can use MemOS Cloud for long-term memory.

Installation:
    copaw plugin install <path-to-this-directory>

Then set ``memory_manager_backend: "memos"`` in agent config and
provide MEMOS_API_KEY (env var or config).
"""
import importlib.util
import logging
import os

logger = logging.getLogger(__name__)

# Load sibling module without mutating sys.path
_plugin_dir = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "memos_memory_manager",
    os.path.join(_plugin_dir, "memos_memory_manager.py"),
)
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
MemOSMemoryManager = _mod.MemOSMemoryManager


class _MemOSPlugin:
    """Plugin definition following CoPaw's plugin contract."""

    def register(self, api):
        """Register the MemOS memory manager backend with CoPaw."""
        logger.info("MemOS Cloud plugin registering...")

        api.register_memory_manager(
            backend_id="memos",
            manager_class=MemOSMemoryManager,
        )
        logger.info("Registered MemOS memory manager backend 'memos'")

        api.register_startup_hook(
            hook_name="memos_cloud_init",
            callback=lambda: logger.info(
                "MemOS Cloud plugin ready. "
                "Set memory_manager_backend='memos' to activate."
            ),
            priority=90,
        )


plugin = _MemOSPlugin()
