"""Opt-in driver doubles for unit tests; real database fixtures never use them."""

import sys

from types import ModuleType
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def psycopg2_stub(monkeypatch):
    """Replace only the driver boundary, retaining the production pool lifecycle."""
    driver = ModuleType("psycopg2")
    driver.__path__ = []
    driver.Error = type("Error", (Exception,), {})
    driver.DatabaseError = type("DatabaseError", (driver.Error,), {})
    driver.OperationalError = type("OperationalError", (driver.DatabaseError,), {})
    driver.ProgrammingError = type("ProgrammingError", (driver.DatabaseError,), {})
    driver.InterfaceError = type("InterfaceError", (driver.Error,), {})

    pool = ModuleType("psycopg2.pool")
    pool.PoolError = type("PoolError", (driver.Error,), {})
    pool.ThreadedConnectionPool = MagicMock()
    driver.pool = pool

    errors = ModuleType("psycopg2.errors")
    errors.QueryCanceled = type("QueryCanceled", (driver.OperationalError,), {})
    errors.DeadlockDetected = type("DeadlockDetected", (driver.OperationalError,), {})
    errors.InsufficientPrivilege = type("InsufficientPrivilege", (driver.ProgrammingError,), {})
    driver.errors = errors

    for name, module in (
        ("psycopg2", driver),
        ("psycopg2.pool", pool),
        ("psycopg2.errors", errors),
    ):
        monkeypatch.setitem(sys.modules, name, module)
    return driver
