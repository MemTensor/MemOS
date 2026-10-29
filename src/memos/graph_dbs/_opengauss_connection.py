"""Internal openGauss connection ownership and AGE session preparation."""

import threading

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from memos.configs.graph_db import OpenGaussGraphDBConfig
from memos.exceptions import ConfigurationError, GraphDBError
from memos.log import get_logger


try:
    import psycopg2

    from psycopg2.pool import ThreadedConnectionPool
except ImportError:
    psycopg2 = None
    ThreadedConnectionPool = None


logger = get_logger(__name__)


class OpenGaussConnectionPool:
    """Bounded transactions; close waits for borrowers before closing sockets.

    Failed writes are never replayed. A commit or return failure can occur after
    the server committed; callers must reconcile using their business IDs.
    """

    def __init__(self, config: OpenGaussGraphDBConfig) -> None:
        if ThreadedConnectionPool is None:
            raise ConfigurationError(
                "Install openGauss support with pip install 'MemoryOS[tree-mem]'"
            )
        self.config = config.model_copy(deep=True)
        self._semaphore = threading.BoundedSemaphore(config.maxconn)
        self._condition = threading.Condition()
        self._active = 0
        self._closed = False
        self._pool_closed = False
        try:
            self._pool = ThreadedConnectionPool(
                config.minconn,
                config.maxconn,
                host=config.host,
                port=config.port,
                dbname=config.db_name,
                user=config.user,
                password=config.password,
                connect_timeout=config.connect_timeout,
                application_name="memos-opengauss",
            )
        except psycopg2.Error as exc:
            raise GraphDBError("Could not open the openGauss connection pool") from exc

    def ensure_open(self) -> None:
        """Reject operations after close, including operations on empty inputs."""
        with self._condition:
            if self._closed:
                raise GraphDBError("The openGauss connection pool is closed")

    @contextmanager
    def transaction(self) -> Iterator[Any]:
        """Prepare one owned session, commit once, and always release admission."""
        self.ensure_open()
        if not self._semaphore.acquire(timeout=self.config.connection_wait_timeout):
            raise GraphDBError("openGauss connection wait timed out")
        with self._condition:
            if self._closed:
                self._semaphore.release()
                raise GraphDBError("The openGauss connection pool is closed")
            self._active += 1
        connection = None
        failed = discard = False
        try:
            connection = self._pool.getconn()
            if connection.closed:
                raise GraphDBError("The openGauss pool returned a closed connection")
            connection.rollback()
            connection.set_session(
                isolation_level="READ COMMITTED", readonly=False, autocommit=False
            )
            with connection.cursor() as cursor:
                cursor.execute("RESET ALL")
                # Public type input loads AGE hooks without privileged LOAD.
                cursor.execute("SELECT 'null'::ag_catalog.agtype")
                cursor.execute("SET search_path = ag_catalog, public")
            yield connection
            connection.commit()
        except BaseException as exc:
            failed = True
            discard = isinstance(exc, psycopg2.OperationalError | psycopg2.InterfaceError)
            if connection is not None:
                try:
                    connection.rollback()
                except psycopg2.Error:
                    discard = True
                    logger.warning("openGauss rollback failed; discarding the connection")
            if isinstance(exc, psycopg2.Error):
                raise GraphDBError(
                    "openGauss transaction failed; the write was not retried"
                ) from exc
            raise
        finally:
            try:
                if connection is not None:
                    self._return_connection(connection, discard, failed)
            finally:
                with self._condition:
                    self._active -= 1
                    if self._closed and not self._active:
                        try:
                            self._close_pool()
                        except GraphDBError:
                            logger.warning(
                                "openGauss pool shutdown failed during transaction cleanup"
                            )
                    self._condition.notify_all()
                self._semaphore.release()

    def _return_connection(self, connection: Any, discard: bool, failed: bool) -> None:
        try:
            self._pool.putconn(connection, close=discard or bool(connection.closed))
        except psycopg2.Error as exc:
            # A failed return may leave the driver's checkout bookkeeping dirty.
            # Stop admission and drain owners before closing the entire pool.
            with self._condition:
                self._closed = True
            try:
                connection.close()
            except psycopg2.Error:
                logger.warning("openGauss connection close failed during pool cleanup")
            if not failed:
                raise GraphDBError(
                    "Could not return the openGauss connection; the transaction may already be committed"
                ) from exc
            logger.warning("openGauss connection return failed during error cleanup")

    def close(self) -> None:
        """Reject new borrowers, wait for owners, then close; successful close is idempotent."""
        with self._condition:
            self._closed = True
            while self._active:
                self._condition.wait()
            self._close_pool()

    def _close_pool(self) -> None:
        if not self._pool_closed:
            try:
                self._pool.closeall()
            except psycopg2.Error as exc:
                raise GraphDBError("Could not close the openGauss connection pool") from exc
            self._pool_closed = True
