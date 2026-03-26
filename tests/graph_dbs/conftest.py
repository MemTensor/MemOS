"""
conftest.py for tests/graph_dbs/

Patches the memos logging subsystem early so that importing
memos.graph_dbs.polardb does not fail when log file paths or
optional dependencies (transformers, etc.) are not available.
"""

import logging
import sys
import types

from unittest.mock import MagicMock


# ── Patch memos.log before anything else imports it ──────────────────────

_mock_log = types.ModuleType("memos.log")
_mock_log.get_logger = lambda name: logging.getLogger(name)
_mock_log.ContextFilter = MagicMock()
sys.modules.setdefault("memos.log", _mock_log)

# ── Patch heavy optional deps that are not needed for unit tests ─────────

for mod_name in (
    "transformers",
    "nebula3",
    "nebula3.gclient",
    "nebula3.gclient.net",
    "nebula3.gclient.net.ConnectionPool",
    "neo4j",
    "ollama",
):
    sys.modules.setdefault(mod_name, MagicMock())
