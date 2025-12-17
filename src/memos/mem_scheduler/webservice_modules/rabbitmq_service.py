import json
import os
import ssl
import threading
import time

from pathlib import Path

from memos.configs.mem_scheduler import AuthConfig, RabbitMQConfig
from memos.context.context import ContextThread
from memos.dependency import require_python_package
from memos.log import get_logger
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.general_modules.misc import AutoDroppingQueue
from memos.mem_scheduler.schemas.general_schemas import DIRECT_EXCHANGE_TYPE, FANOUT_EXCHANGE_TYPE
from memos.mem_scheduler.utils.misc_utils import is_cloud_env


logger = get_logger(__name__)


class RabbitMQSchedulerModule(BaseSchedulerModule):
    @require_python_package(
        import_name="pika",
        install_command="pip install pika",
        install_link="https://pika.readthedocs.io/en/stable/index.html",
    )
    def __init__(self):
        """
        Initialize RabbitMQ connection settings.
        """
        super().__init__()

        # RabbitMQ settings
        self.rabbitmq_config: RabbitMQConfig | None = None
        self.rabbit_queue_name = "memos-scheduler"
        self.rabbitmq_exchange_name = "memos-fanout"  # Default, will be overridden by config
        self.rabbitmq_exchange_type = FANOUT_EXCHANGE_TYPE  # Default, will be overridden by config
        self.rabbitmq_connection = None
        self.rabbitmq_channel = None

        # fixed params
        self.rabbitmq_message_cache_max_size = 10  # Max 10 messages
        self.rabbitmq_message_cache = AutoDroppingQueue(
            maxsize=self.rabbitmq_message_cache_max_size
        )
        self.rabbitmq_connection_attempts = 3  # Max retry attempts on connection failure
        self.rabbitmq_retry_delay = 5  # Delay (seconds) between retries
        self.rabbitmq_heartbeat = 60  # Heartbeat interval (seconds) for connectio
        self.rabbitmq_conn_max_waiting_seconds = 30
        self.rabbitmq_conn_sleep_seconds = 1

        # Thread management
        self._rabbitmq_io_loop_thread = None  # For IOLoop execution
        self._rabbitmq_stop_flag = False  # Graceful shutdown flag
        self._rabbitmq_lock = threading.Lock()  # Ensure thread safety

    def is_rabbitmq_connected(self) -> bool:
        """Check if RabbitMQ connection is alive"""
        return (
            self.rabbitmq_connection
            and self.rabbitmq_connection.is_open
            and self.rabbitmq_channel
            and self.rabbitmq_channel.is_open
        )

    def initialize_rabbitmq(
        self, config: dict | None | RabbitMQConfig = None, config_path: str | Path | None = None
    ):
        """
        Establish connection to RabbitMQ using pika.
        """
        try:
            # Skip remote initialization in CI/pytest unless explicitly enabled
            enable_env = os.getenv("MEMOS_ENABLE_RABBITMQ", "").lower() == "true"
            in_ci = os.getenv("CI", "").lower() == "true"
            in_pytest = os.getenv("PYTEST_CURRENT_TEST") is not None
            if (in_ci or in_pytest) and not enable_env:
                logger.info(
                    "Skipping RabbitMQ initialization in CI/test environment. Set MEMOS_ENABLE_RABBITMQ=true to enable."
                )
                return

            from pika.adapters.select_connection import SelectConnection

            if config is None:
                if config_path is None and AuthConfig.default_config_exists():
                    auth_config = AuthConfig.from_local_config()
                elif Path(config_path).exists():
                    auth_config = AuthConfig.from_local_config(config_path=config_path)
                else:
                    logger.error("Fail to initialize auth_config")
                    return
                self.rabbitmq_config = auth_config.rabbitmq
            elif isinstance(config, RabbitMQConfig):
                self.rabbitmq_config = config
            elif isinstance(config, dict):
                self.rabbitmq_config = AuthConfig.from_dict(config).rabbitmq
            else:
                logger.error("Not implemented")

            # Load exchange configuration from config
            if self.rabbitmq_config:
                if (
                    hasattr(self.rabbitmq_config, "exchange_name")
                    and self.rabbitmq_config.exchange_name
                ):
                    self.rabbitmq_exchange_name = self.rabbitmq_config.exchange_name
                    logger.info(f"Using configured exchange name: {self.rabbitmq_exchange_name}")
                if (
                    hasattr(self.rabbitmq_config, "exchange_type")
                    and self.rabbitmq_config.exchange_type
                ):
                    self.rabbitmq_exchange_type = self.rabbitmq_config.exchange_type
                    logger.info(f"Using configured exchange type: {self.rabbitmq_exchange_type}")

                # Start connection process
            parameters = self.get_rabbitmq_connection_param()
            self.rabbitmq_connection = SelectConnection(
                parameters,
                on_open_callback=self.on_rabbitmq_connection_open,
                on_open_error_callback=self.on_rabbitmq_connection_error,
                on_close_callback=self.on_rabbitmq_connection_closed,
            )

            # Start IOLoop in dedicated thread
            self._io_loop_thread = ContextThread(
                target=self.rabbitmq_connection.ioloop.start, daemon=True
            )
            self._io_loop_thread.start()
            logger.info("RabbitMQ connection process started")
        except Exception:
            logger.error("Fail to initialize auth_config", exc_info=True)

    def get_rabbitmq_queue_size(self) -> int:
        """Get the current number of messages in the queue.

        Returns:
            int: Number of messages in the queue.
                 Returns -1 if there's an error or no active connection.
        """
        if self.rabbitmq_exchange_type != DIRECT_EXCHANGE_TYPE:
            logger.warning("Queue size can only be checked for direct exchanges")
            return None

        with self._rabbitmq_lock:
            if not self.is_rabbitmq_connected():
                logger.warning("No active connection to check queue size")
                return -1

            # Declare queue passively (only checks existence, doesn't create)
            # Using passive=True prevents accidental queue creation
            result = self.rabbitmq_channel.queue_declare(
                queue=self.rabbit_queue_name,
                durable=True,  # Match the original queue durability setting
                passive=True,  # Only check queue existence, don't create
            )

            if result is None:
                return 0
            # Return the message count from the queue declaration result
            return result.method.message_count

    def get_rabbitmq_connection_param(self):
        import pika

        credentials = pika.PlainCredentials(
            username=self.rabbitmq_config.user_name,
            password=self.rabbitmq_config.password,
            erase_on_connect=self.rabbitmq_config.erase_on_connect,
        )
        if self.rabbitmq_config.port == 5671:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.check_hostname = False
            context.verify_mode = False
            return pika.ConnectionParameters(
                host=self.rabbitmq_config.host_name,
                port=self.rabbitmq_config.port,
                virtual_host=self.rabbitmq_config.virtual_host,
                credentials=credentials,
                ssl_options=pika.SSLOptions(context),
                connection_attempts=self.rabbitmq_connection_attempts,
                retry_delay=self.rabbitmq_retry_delay,
                heartbeat=self.rabbitmq_heartbeat,
            )
        else:
            return pika.ConnectionParameters(
                host=self.rabbitmq_config.host_name,
                port=self.rabbitmq_config.port,
                virtual_host=self.rabbitmq_config.virtual_host,
                credentials=credentials,
                connection_attempts=self.rabbitmq_connection_attempts,
                retry_delay=self.rabbitmq_retry_delay,
                heartbeat=self.rabbitmq_heartbeat,
            )

    # Connection lifecycle callbacks
    def on_rabbitmq_connection_open(self, connection):
        """Called when connection is established."""
        logger.debug("Connection opened")
        connection.channel(on_open_callback=self.on_rabbitmq_channel_open)

    def on_rabbitmq_connection_error(self, connection, error):
        """Called if connection fails to open."""
        logger.error(f"Connection failed: {error}")
        self.rabbit_reconnect()

    def on_rabbitmq_connection_closed(self, connection, reason):
        """Called when connection closes."""
        logger.warning(f"Connection closed: {reason}")
        if not self._rabbitmq_stop_flag:
            self.rabbit_reconnect()

    # Channel lifecycle callbacks
    def on_rabbitmq_channel_open(self, channel):
        """Called when channel is ready."""
        self.rabbitmq_channel = channel
        logger.debug("Channel opened")

        # Setup exchange and queue
        channel.exchange_declare(
            exchange=self.rabbitmq_exchange_name,
            exchange_type=self.rabbitmq_exchange_type,
            durable=True,
            callback=self.on_rabbitmq_exchange_declared,
        )

    def on_rabbitmq_exchange_declared(self, frame):
        """Called when exchange is ready."""
        self.rabbitmq_channel.queue_declare(
            queue=self.rabbit_queue_name, durable=True, callback=self.on_rabbitmq_queue_declared
        )

    def on_rabbitmq_queue_declared(self, frame):
        """Called when queue is ready."""
        self.rabbitmq_channel.queue_bind(
            exchange=self.rabbitmq_exchange_name,
            queue=self.rabbit_queue_name,
            routing_key=self.rabbit_queue_name,
            callback=self.on_rabbitmq_bind_ok,
        )

    def on_rabbitmq_bind_ok(self, frame):
        """Final setup step when bind is complete."""
        logger.info("RabbitMQ setup completed")

    def on_rabbitmq_message(self, channel, method, properties, body):
        """Handle incoming messages. Only for test."""
        try:
            print(f"Received message: {body.decode()}\n")
            self.rabbitmq_message_cache.put({"properties": properties, "body": body})
            print(f"message delivery_tag: {method.delivery_tag}\n")
            channel.basic_ack(delivery_tag=method.delivery_tag)
        except Exception as e:
            logger.error(f"Message handling failed: {e}", exc_info=True)

    def wait_for_connection_ready(self):
        start_time = time.time()
        while not self.is_rabbitmq_connected():
            delta_time = time.time() - start_time
            if delta_time > self.rabbitmq_conn_max_waiting_seconds:
                logger.error("Failed to start consuming: Connection timeout")
                return False
            self.rabbit_reconnect()
            time.sleep(self.rabbitmq_conn_sleep_seconds)  # Reduced frequency of checks

    # Message handling
    def rabbitmq_start_consuming(self):
        """Start consuming messages asynchronously."""
        self.wait_for_connection_ready()

        self.rabbitmq_channel.basic_consume(
            queue=self.rabbit_queue_name,
            on_message_callback=self.on_rabbitmq_message,
            auto_ack=False,
        )
        logger.info("Started rabbitmq consuming messages")

    def rabbitmq_publish_message(self, message: dict):
        """
        Publish a message to RabbitMQ.
        """
        import pika

        exchange_name = self.rabbitmq_exchange_name
        routing_key = self.rabbit_queue_name
        label = message.get("label")

        # Special handling for knowledgeBaseUpdate in local environment: always empty routing key
        if label == "knowledgeBaseUpdate":
            routing_key = ""

        # Cloud environment override: applies to specific message types if MEMSCHEDULER_RABBITMQ_EXCHANGE_NAME is set
        env_exchange_name = os.getenv("MEMSCHEDULER_RABBITMQ_EXCHANGE_NAME")
        if is_cloud_env() and env_exchange_name and label in ["taskStatus", "knowledgeBaseUpdate"]:
            exchange_name = env_exchange_name
            routing_key = ""  # Routing key is always empty in cloud environment for these types

            # Specific diagnostic logging for messages affected by cloud environment settings
            logger.info(
                f"[DIAGNOSTIC] Publishing {label} message in Cloud Env. "
                f"Exchange: {exchange_name}, Routing Key: '{routing_key}'."
            )
            logger.info(f"  - Message Content: {json.dumps(message, indent=2)}")
        elif label == "knowledgeBaseUpdate":
            # Original diagnostic logging for knowledgeBaseUpdate if NOT in cloud env
            logger.info(
                f"[DIAGNOSTIC] Publishing knowledgeBaseUpdate message (Local Env). "
                f"Current configured Exchange: {exchange_name}, Routing Key: '{routing_key}'."
            )
            logger.info(f"  - Message Content: {json.dumps(message, indent=2)}")

        with self._rabbitmq_lock:
            if not self.is_rabbitmq_connected():
                logger.error("Cannot publish - no active connection")
                return False

            logger.info(
                f"[DIAGNOSTIC] rabbitmq_service.rabbitmq_publish_message: Attempting to publish message. Exchange: {exchange_name}, Routing Key: {routing_key}, Message Content: {json.dumps(message, indent=2, ensure_ascii=False)}"
            )
            try:
                self.rabbitmq_channel.basic_publish(
                    exchange=exchange_name,
                    routing_key=routing_key,
                    body=json.dumps(message),
                    properties=pika.BasicProperties(
                        delivery_mode=2,  # Persistent
                    ),
                    mandatory=True,
                )
                logger.debug(f"Published message: {message}")
                return True
            except Exception as e:
                logger.error(f"Failed to publish message: {e}")
                self.rabbit_reconnect()
                return False

    # Connection management
    def rabbit_reconnect(self):
        """Schedule reconnection attempt."""
        logger.info("Attempting to reconnect...")
        if self.rabbitmq_connection and not self.rabbitmq_connection.is_closed:
            self.rabbitmq_connection.ioloop.stop()

        # Reset connection state
        self.rabbitmq_channel = None
        self.initialize_rabbitmq()

    def rabbitmq_close(self):
        """Gracefully shutdown connection."""
        with self._rabbitmq_lock:
            self._rabbitmq_stop_flag = True

            # Close channel if open
            if self.rabbitmq_channel and self.rabbitmq_channel.is_open:
                try:
                    self.rabbitmq_channel.close()
                except Exception as e:
                    logger.warning(f"Error closing channel: {e}")

            # Close connection if open
            if self.rabbitmq_connection:
                if self.rabbitmq_connection.is_open:
                    try:
                        self.rabbitmq_connection.close()
                    except Exception as e:
                        logger.warning(f"Error closing connection: {e}")

                # Stop IOLoop if running
                try:
                    self.rabbitmq_connection.ioloop.stop()
                except Exception as e:
                    logger.warning(f"Error stopping IOLoop: {e}")

            # Wait for IOLoop thread to finish
            if self._io_loop_thread and self._io_loop_thread.is_alive():
                self._io_loop_thread.join(timeout=5)
                if self._io_loop_thread.is_alive():
                    logger.warning("IOLoop thread did not terminate cleanly")

        logger.info("RabbitMQ connection closed")
