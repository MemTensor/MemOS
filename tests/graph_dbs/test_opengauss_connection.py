"""Connection ownership, bounded admission and failure preservation."""

import builtins
import importlib
import runpy
import threading

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import ConfigurationError
from tests.graph_dbs.opengauss_test_support import PartialOpenGaussGraphDB


@pytest.fixture
def pool_case(monkeypatch):
    module = importlib.import_module("memos.graph_dbs.opengauss")
    config = OpenGaussGraphDBConfig(
        host="db",
        user="memos",
        password="synthetic-password",
        db_name="test",
        user_name="A",
        minconn=1,
        maxconn=2,
    )
    raw = MagicMock()
    conn = raw.getconn.return_value
    conn.closed = 0
    factory = MagicMock(return_value=raw)
    monkeypatch.setattr(module, "ThreadedConnectionPool", factory)
    monkeypatch.setattr(PartialOpenGaussGraphDB, "_init_schema", lambda self: None)
    pool = PartialOpenGaussGraphDB(config)
    return module, pool, raw, conn, factory


def test_pool_parameters_and_prepared_session(pool_case):
    _, pool, raw, conn, factory = pool_case
    args, kwargs = factory.call_args
    assert args == (1, 2)
    assert kwargs["connect_timeout"] == 10
    assert kwargs["dbname"] == "test"
    assert kwargs["application_name"] == "memos-opengauss"
    with pool._get_connection() as borrowed:
        assert borrowed is conn
        cur = conn.cursor.return_value.__enter__.return_value
        cur.execute.assert_any_call("RESET ALL")
        cur.execute.assert_any_call("SELECT 'null'::ag_catalog.agtype")
        cur.execute.assert_any_call("SET search_path = ag_catalog, public")
    conn.rollback.assert_called_once()
    conn.set_session.assert_called_once_with(
        isolation_level="READ COMMITTED", readonly=False, autocommit=False
    )
    conn.commit.assert_called_once()
    raw.putconn.assert_called_once_with(conn, close=False)


@pytest.mark.parametrize(
    "stage", ["getconn", "rollback", "session", "prepare", "body", "fetch", "commit"]
)
def test_failures_are_not_replayed_and_do_not_leak_slots(pool_case, stage):
    module, pool, raw, conn, _ = pool_case
    error = module.psycopg2.OperationalError("synthetic-sensitive-detail")
    cursor = conn.cursor.return_value.__enter__.return_value
    if stage == "getconn":
        raw.getconn.side_effect = error
    elif stage == "rollback":
        conn.rollback.side_effect = [error, None]
    elif stage == "prepare":
        cursor.execute.side_effect = error
    elif stage == "session":
        conn.set_session.side_effect = error
    elif stage == "fetch":
        cursor.fetchone.side_effect = error
    elif stage == "commit":
        conn.commit.side_effect = error
    with pytest.raises(module.GraphDBError) as caught, pool._get_connection():
        if stage == "body":
            raise error
        if stage == "fetch":
            cursor.fetchone()
    assert caught.value.__cause__ is error
    assert "synthetic-sensitive-detail" not in str(caught.value)
    assert raw.getconn.call_count == 1
    assert pool._active == 0
    assert pool._semaphore.acquire(blocking=False)
    pool._semaphore.release()


@pytest.mark.parametrize("error", [ValueError("bad input"), KeyboardInterrupt(), SystemExit(3)])
def test_non_driver_exceptions_and_cancellation_preserve_identity(pool_case, error):
    _, pool, raw, conn, _ = pool_case
    with pytest.raises(type(error)) as caught, pool._get_connection():
        raise error
    assert caught.value is error
    assert conn.rollback.call_count == 2
    conn.commit.assert_not_called()
    raw.putconn.assert_called_once_with(conn, close=False)


@pytest.mark.parametrize("put_fails", [False, True])
@pytest.mark.parametrize("close_fails", [False, True])
def test_cleanup_failures_keep_original_error(pool_case, put_fails, close_fails):
    module, pool, raw, conn, _ = pool_case
    original = ValueError("original")
    conn.rollback.side_effect = [None, module.psycopg2.OperationalError("rollback")]
    if put_fails:
        raw.putconn.side_effect = module.psycopg2.pool.PoolError("return")
    if close_fails:
        conn.close.side_effect = module.psycopg2.Error("close")
    with pytest.raises(ValueError) as caught, pool._get_connection():
        raise original
    assert caught.value is original
    raw.putconn.assert_called_once_with(conn, close=True)
    assert pool._active == 0


def test_return_failure_after_commit_is_observable(pool_case):
    module, pool, raw, conn, _ = pool_case
    raw.putconn.side_effect = module.psycopg2.pool.PoolError("return")
    with pytest.raises(module.GraphDBError, match="return"), pool._get_connection():
        pass
    conn.commit.assert_called_once()
    conn.close.assert_called_once()
    assert pool._active == 0


def test_return_failure_stops_admission_and_drains_existing_owner(pool_case):
    module, pool, raw, conn, _ = pool_case
    other = MagicMock()
    other.closed = 0
    raw.getconn.side_effect = [conn, other]
    raw.putconn.side_effect = [module.psycopg2.pool.PoolError("return"), None]
    with pool._get_connection(), pytest.raises(module.GraphDBError, match="closed"):
        with pytest.raises(module.GraphDBError, match="return"), pool._get_connection():
            pass
        raw.closeall.assert_not_called()
        pool._ensure_open()
    raw.closeall.assert_called_once()
    pool.close()
    raw.closeall.assert_called_once()


def test_shutdown_failure_during_return_cleanup_preserves_return_error(pool_case):
    module, pool, raw, _, _ = pool_case
    raw.putconn.side_effect = module.psycopg2.pool.PoolError("return")
    raw.closeall.side_effect = module.psycopg2.Error("shutdown")
    with pytest.raises(module.GraphDBError, match="return"), pool._get_connection():
        pass
    raw.closeall.assert_called_once()
    with pytest.raises(module.GraphDBError, match="close"):
        pool.close()


def test_closed_connection_is_discarded(pool_case):
    module, pool, raw, conn, _ = pool_case
    conn.closed = 1
    with pytest.raises(module.GraphDBError, match="closed connection"), pool._get_connection():
        pytest.fail("must not yield a closed connection")
    raw.putconn.assert_called_once_with(conn, close=True)


def test_wait_timeout_does_not_borrow(pool_case):
    module, pool, raw, _, _ = pool_case
    pool._semaphore = MagicMock()
    pool._semaphore.acquire.return_value = False
    with pytest.raises(module.GraphDBError, match="wait timed out"), pool._get_connection():
        pytest.fail("must not yield")
    raw.getconn.assert_not_called()


def test_close_during_admission_releases_slot(pool_case):
    module, pool, raw, _, _ = pool_case
    gate = MagicMock()

    def close_before_admission(**kwargs):
        pool._closed = True
        return True

    gate.acquire.side_effect = close_before_admission
    pool._semaphore = gate
    with pytest.raises(module.GraphDBError, match="closed"), pool._get_connection():
        pytest.fail("must not yield")
    gate.release.assert_called_once()
    raw.getconn.assert_not_called()


def test_close_is_idempotent_and_blocks_new_borrows(pool_case):
    module, pool, raw, _, _ = pool_case
    pool.close()
    pool.close()
    raw.closeall.assert_called_once()
    with pytest.raises(module.GraphDBError, match="closed"), pool._get_connection():
        pytest.fail("must not yield")


def test_close_waits_for_owned_transaction(pool_case, monkeypatch):
    _, pool, raw, _, _ = pool_case
    waiting = threading.Event()
    original_wait = pool._condition.wait

    def wait():
        waiting.set()
        return original_wait()

    monkeypatch.setattr(pool._condition, "wait", wait)
    with ThreadPoolExecutor(1) as executor:
        with pool._get_connection():
            closing = executor.submit(pool.close)
            assert waiting.wait(5)
            raw.closeall.assert_not_called()
        closing.result(timeout=5)
    raw.closeall.assert_called_once()


def test_close_failure_can_be_observed_and_retried(pool_case):
    module, pool, raw, _, _ = pool_case
    raw.closeall.side_effect = [module.psycopg2.Error("close"), None]
    with pytest.raises(module.GraphDBError, match="close"):
        pool.close()
    pool.close()
    assert raw.closeall.call_count == 2


def test_constructor_driver_failure_is_sanitized(pool_case, monkeypatch):
    module, pool, _, _, factory = pool_case
    error = module.psycopg2.OperationalError("synthetic-sensitive-detail")
    factory.side_effect = error
    with pytest.raises(module.GraphDBError) as caught:
        PartialOpenGaussGraphDB(pool.config)
    assert caught.value.__cause__ is error
    assert "synthetic-sensitive-detail" not in str(caught.value)


def test_optional_driver_import_has_install_guidance(pool_case, monkeypatch):
    module, pool, _, _, _ = pool_case
    original = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name.startswith("psycopg2"):
            raise ImportError("driver deliberately unavailable")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    namespace = runpy.run_path(module.__file__)
    with pytest.raises(ConfigurationError, match=r"MemoryOS\[tree-mem\]"):
        namespace["OpenGaussGraphDB"].__init__(object(), pool.config)
