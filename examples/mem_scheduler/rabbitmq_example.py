import threading
import time

from memos.configs.mem_scheduler import AuthConfig
from memos.mem_scheduler.webservice_modules.rabbitmq_service import RabbitMQSchedulerModule


def publish_message(rabbitmq_module, message):
    """Function to publish a message."""
    rabbitmq_module.rabbitmq_publish_message(message)
    print(f"Published message: {message}\n")


def main():
    # Initialize RabbitMQ module
    rabbitmq_module = RabbitMQSchedulerModule()
    rabbitmq_module.rabbit_queue_name = "test"

    # Initialize from configuration dictionary
    if not AuthConfig.default_config_exists():
        print("Please set configs for rabbitmq.")
        return
    else:
        rabbitmq_module.initialize_rabbitmq(config=AuthConfig.from_local_config().rabbitmq)

    try:
        rabbitmq_module.wait_for_connection_ready()

        # === Publish some test messages ===
        # List to hold thread references
        threads = []

        # Publish some test messages using multiple threads
        for i in range(3):
            message = {"type": "test", "data": f"Message {i}", "timestamp": time.time()}
            thread = threading.Thread(target=publish_message, args=(rabbitmq_module, message))
            thread.start()
            threads.append(thread)

        # Start consumer
        rabbitmq_module.rabbitmq_start_consuming()

        # Join threads to ensure all messages are published before proceeding
        for thread in threads:
            thread.join()

    except KeyboardInterrupt:
        print("\nProgram interrupted by user")

    finally:
        # Give some time for cleanup
        time.sleep(3)

        # Close connections
        rabbitmq_module.rabbitmq_close()
        print("RabbitMQ connection closed")


if __name__ == "__main__":
    main()
