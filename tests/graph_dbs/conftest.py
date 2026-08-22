"""Shared fixtures for graph_dbs tests.

Provides a session-scoped autouse fixture that stubs out the ``psycopg2``
module so tests targeting ``memos.graph_dbs.postgres`` can run without the
real driver installed. Doing this in a fixture (rather than at import time in
an individual test module) keeps the mutation scoped: we only install the
stub if no real driver is present, and we clean up ``sys.modules`` at the end
of the session so subsequent test suites in the same process cannot silently
inherit the stub.
"""

from __future__ import annotations

import sys
import types

from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True, scope="session")
def _stub_psycopg2():
    """Install a minimal ``psycopg2`` stub if the real driver is missing.

    The scope is ``session`` + ``autouse`` because the target module
    (``memos.graph_dbs.postgres``) does ``import psycopg2`` at import time; a
    per-test fixture would be too late.  We only touch ``sys.modules`` if the
    real driver is not present, and we roll back what we installed on
    teardown so we do not pollute unrelated test suites.
    """

    installed_keys: list[str] = []

    if "psycopg2" not in sys.modules:
        fake_psycopg2 = types.ModuleType("psycopg2")
        fake_pool = types.ModuleType("psycopg2.pool")
        fake_pool.ThreadedConnectionPool = MagicMock()
        fake_psycopg2.pool = fake_pool
        sys.modules["psycopg2"] = fake_psycopg2
        sys.modules["psycopg2.pool"] = fake_pool
        installed_keys.extend(["psycopg2", "psycopg2.pool"])

    try:
        yield
    finally:
        for key in installed_keys:
            sys.modules.pop(key, None)
