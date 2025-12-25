import asyncio
import os
import subprocess
import time

from collections.abc import Callable
from typing import Any

from memos.context.context import ContextThread
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule


logger = get_logger(__name__)


class RedisSchedulerModule(BaseSchedulerModule):
    @require_python_package(
        import_name="redis",
        install_command="pip install redis",
        install_link="https://redis.readthedocs.io/en/stable/",
    )
    def __init__(self):
        """
        intent_detector: Object used for intent recognition (such as the above IntentDetector)
        scheduler: The actual scheduling module/interface object
        trigger_intents: The types of intents that need to be triggered (list)
        """
        super().__init__()

        # settings for redis
        self.redis_host: str | None = None
        self.redis_port: int | None = None
        self.redis_db: int | None = None
        self.redis_password: str | None = None
        self.socket_timeout: float | None = None
        self.socket_connect_timeout: float | None = None
        self._redis_conn = None
        self._local_redis_process = None
        self.query_list_capacity = 1000

        self._redis_listener_running = False
        self._redis_listener_thread: ContextThread | None = None
        self._redis_listener_loop: asyncio.AbstractEventLoop | None = None

    @property
    def redis(self) -> Any:
        if self._redis_conn is None:
            self.auto_initialize_redis()
        return self._redis_conn

    @redis.setter
    def redis(self, value: Any) -> None:
        self._redis_conn = value

    def initialize_redis(
        self,
        redis_host: str = "localhost",
        redis_port: int = 6379,
        redis_db: int = 0,
        redis_password: str | None = None,
        socket_timeout: float | None = None,
        socket_connect_timeout: float | None = None,
    ):
        import redis

        self.redis_host = redis_host
        self.redis_port = redis_port
        self.redis_db = redis_db
        self.redis_password = redis_password
        self.socket_timeout = socket_timeout
        self.socket_connect_timeout = socket_connect_timeout

        try:
            logger.debug(f"Connecting to Redis at {redis_host}:{redis_port}/{redis_db}")
            redis_kwargs = {
                "host": self.redis_host,
                "port": self.redis_port,
                "db": self.redis_db,
                "password": redis_password,
                "decode_responses": True,
            }

            # Add timeout parameters if provided
            if socket_timeout is not None:
                redis_kwargs["socket_timeout"] = socket_timeout
            if socket_connect_timeout is not None:
                redis_kwargs["socket_connect_timeout"] = socket_connect_timeout

            self._redis_conn = redis.Redis(**redis_kwargs)
            # test conn
            if not self._redis_conn.ping():
                logger.error("Redis connection failed")
        except redis.ConnectionError as e:
            self._redis_conn = None
            logger.error(f"Redis connection error: {e}")
        self._redis_conn.xtrim("user:queries:stream", self.query_list_capacity)
        return self._redis_conn

    @require_python_package(
        import_name="redis",
        install_command="pip install redis",
        install_link="https://redis.readthedocs.io/en/stable/",
    )
    def auto_initialize_redis(self) -> bool:
        """
        Auto-initialize Redis with fallback strategies:
        1. Try to initialize from config
        2. Try to initialize from environment variables
        3. Try to start local Redis server as fallback

        Returns:
            bool: True if Redis connection is successfully established, False otherwise
        """
        # Skip remote initialization in CI/pytest unless explicitly enabled
        enable_env = os.getenv("MEMOS_ENABLE_REDIS", "").lower() == "true"
        in_ci = os.getenv("CI", "").lower() == "true"
        in_pytest = os.getenv("PYTEST_CURRENT_TEST") is not None
        if (in_ci or in_pytest) and not enable_env:
            logger.info(
                "Skipping Redis auto-initialization in CI/test environment. Set MEMOS_ENABLE_REDIS=true to enable."
            )
            return False

        import redis

        # Strategy 1: Try to initialize from config
        if hasattr(self, "config") and hasattr(self.config, "redis_config"):
            try:
                redis_config = self.config.redis_config
                logger.info("Attempting to initialize Redis from config")

                self._redis_conn = redis.Redis(
                    host=redis_config.get("host", "localhost"),
                    port=redis_config.get("port", 6379),
                    db=redis_config.get("db", 0),
                    password=redis_config.get("password", None),
                    decode_responses=True,
                )

                # Test connection
                if self._redis_conn.ping():
                    logger.info("Redis initialized successfully from config")
                    self.redis_host = redis_config.get("host", "localhost")
                    self.redis_port = redis_config.get("port", 6379)
                    self.redis_db = redis_config.get("db", 0)
                    self.redis_password = redis_config.get("password", None)
                    self.socket_timeout = redis_config.get("socket_timeout", None)
                    self.socket_connect_timeout = redis_config.get("socket_connect_timeout", None)
                    return True
                else:
                    logger.warning("Redis config connection test failed")
                    self._redis_conn = None
            except Exception as e:
                logger.warning(f"Failed to initialize Redis from config: {e}")
                self._redis_conn = None

        # Strategy 2: Try to initialize from environment variables
        try:
            redis_host = os.getenv("MEMSCHEDULER_REDIS_HOST", "localhost")
            redis_port = int(os.getenv("MEMSCHEDULER_REDIS_PORT", "6379"))
            redis_db = int(os.getenv("MEMSCHEDULER_REDIS_DB", "0"))
            redis_password = os.getenv("MEMSCHEDULER_REDIS_PASSWORD", None)
            socket_timeout = os.getenv("MEMSCHEDULER_REDIS_TIMEOUT", None)
            socket_connect_timeout = os.getenv("MEMSCHEDULER_REDIS_CONNECT_TIMEOUT", None)

            logger.info(
                f"Attempting to initialize Redis from environment variables: {redis_host}:{redis_port}"
            )

            redis_kwargs = {
                "host": redis_host,
                "port": redis_port,
                "db": redis_db,
                "password": redis_password,
                "decode_responses": True,
            }

            # Add timeout parameters if provided
            if socket_timeout is not None:
                try:
                    redis_kwargs["socket_timeout"] = float(socket_timeout)
                except ValueError:
                    logger.warning(
                        f"Invalid MEMSCHEDULER_REDIS_TIMEOUT value: {socket_timeout}, ignoring"
                    )

            if socket_connect_timeout is not None:
                try:
                    redis_kwargs["socket_connect_timeout"] = float(socket_connect_timeout)
                except ValueError:
                    logger.warning(
                        f"Invalid MEMSCHEDULER_REDIS_CONNECT_TIMEOUT value: {socket_connect_timeout}, ignoring"
                    )

            self._redis_conn = redis.Redis(**redis_kwargs)

            # Test connection
            if self._redis_conn.ping():
                logger.info("Redis initialized successfully from environment variables")
                self.redis_host = redis_host
                self.redis_port = redis_port
                self.redis_db = redis_db
                self.redis_password = redis_password
                self.socket_timeout = float(socket_timeout) if socket_timeout is not None else None
                self.socket_connect_timeout = (
                    float(socket_connect_timeout) if socket_connect_timeout is not None else None
                )
                return True
            else:
                logger.warning("Redis environment connection test failed")
                self._redis_conn = None
        except Exception as e:
            logger.warning(f"Failed to initialize Redis from environment variables: {e}")
            self._redis_conn = None

        # Strategy 3: Try to start local Redis server as fallback
        try:
            logger.warning(
                "Attempting to start local Redis server as fallback (not recommended for production)"
            )

            # Try to start Redis server locally
            self._local_redis_process = subprocess.Popen(
                ["redis-server", "--port", "6379", "--daemonize", "no"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=os.setsid if hasattr(os, "setsid") else None,
            )

            # Wait a moment for Redis to start
            time.sleep(0.5)

            # Try to connect to local Redis
            self._redis_conn = redis.Redis(host="localhost", port=6379, db=0, decode_responses=True)

            # Test connection
            if self._redis_conn.ping():
                logger.warning("Local Redis server started and connected successfully")
                logger.warning("WARNING: Using local Redis server - not suitable for production!")
                self.redis_host = "localhost"
                self.redis_port = 6379
                self.redis_db = 0
                self.redis_password = None
                self.socket_timeout = None
                self.socket_connect_timeout = None
                return True
            else:
                logger.error("Local Redis server connection test failed")
                self._cleanup_local_redis()
                return False

        except Exception as e:
            logger.error(f"Failed to start local Redis server: {e}")
            self._cleanup_local_redis()
            return False

    def _cleanup_local_redis(self):
        """Clean up local Redis process if it exists"""
        if self._local_redis_process:
            try:
                self._local_redis_process.terminate()
                self._local_redis_process.wait(timeout=5)
                logger.info("Local Redis process terminated")
            except subprocess.TimeoutExpired:
                logger.warning("Local Redis process did not terminate gracefully, killing it")
                self._local_redis_process.kill()
                self._local_redis_process.wait()
            except Exception as e:
                logger.error(f"Error cleaning up local Redis process: {e}")
            finally:
                self._local_redis_process = None

    def _cleanup_redis_resources(self):
        """Clean up Redis connection and local process"""
        if self._redis_conn:
            try:
                self._redis_conn.close()
                logger.info("Redis connection closed")
            except Exception as e:
                logger.error(f"Error closing Redis connection: {e}")
            finally:
                self._redis_conn = None

        self._cleanup_local_redis()

    def redis_add_message_stream(self, message: dict):
        logger.debug(f"add_message_stream: {message}")
        return self._redis_conn.xadd("user:queries:stream", message)

    async def redis_consume_message_stream(self, message: dict):
        logger.debug(f"consume_message_stream: {message}")

    def _redis_run_listener_async(self, handler: Callable):
        """Run the async listener in a separate thread"""
        self._redis_listener_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._redis_listener_loop)

        async def listener_wrapper():
            try:
                await self.__redis_listen_query_stream(handler)
            except Exception as e:
                logger.error(f"Listener thread error: {e}")
            finally:
                self._redis_listener_running = False

        self._redis_listener_loop.run_until_complete(listener_wrapper())

    async def __redis_listen_query_stream(
        self, handler=None, last_id: str = "$", block_time: int = 2000
    ):
        """Internal async stream listener"""
        import redis

        self._redis_listener_running = True
        while self._redis_listener_running:
            try:
                # Blocking read for new messages
                messages = self.redis.xread(
                    {"user:queries:stream": last_id}, count=1, block=block_time
                )

                if messages:
                    for _, stream_messages in messages:
                        for message_id, message_data in stream_messages:
                            try:
                                print(f"deal with message_data {message_data}")
                                await handler(message_data)
                                last_id = message_id
                            except Exception as e:
                                logger.error(f"Error processing message {message_id}: {e}")

            except redis.ConnectionError as e:
                logger.error(f"Redis connection error: {e}")
                await asyncio.sleep(5)  # Wait before reconnecting
                self._redis_conn = None  # Force reconnection
            except Exception as e:
                logger.error(f"Unexpected error: {e}")
                await asyncio.sleep(1)

    def redis_start_listening(self, handler: Callable | None = None):
        """Start the Redis stream listener in a background thread"""
        if self._redis_listener_thread and self._redis_listener_thread.is_alive():
            logger.warning("Listener is already running")
            return

        # Check Redis connection before starting listener
        if self.redis is None:
            logger.warning(
                "Redis connection is None, attempting to auto-initialize before starting listener..."
            )
            if not self.auto_initialize_redis():
                logger.error("Failed to initialize Redis connection, cannot start listener")
                return

        if handler is None:
            handler = self.redis_consume_message_stream

        self._redis_listener_thread = ContextThread(
            target=self._redis_run_listener_async,
            args=(handler,),
            daemon=True,
            name="RedisListenerThread",
        )
        self._redis_listener_thread.start()
        logger.info("Started Redis stream listener thread")

    def redis_stop_listening(self):
        """Stop the listener thread gracefully"""
        self._redis_listener_running = False
        if self._redis_listener_thread and self._redis_listener_thread.is_alive():
            self._redis_listener_thread.join(timeout=5.0)
            if self._redis_listener_thread.is_alive():
                logger.warning("Listener thread did not stop gracefully")
        logger.info("Redis stream listener stopped")

    def redis_close(self):
        """Close Redis connection and clean up resources"""
        self._cleanup_redis_resources()
