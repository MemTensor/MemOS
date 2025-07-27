"""Example demonstrating the use of UserManagerFactory with different backends."""

from memos.configs.mem_user import UserManagerConfigFactory
from memos.mem_user.factory import UserManagerFactory
from memos.mem_user.persistent_factory import PersistentUserManagerFactory


def example_sqlite_default():
    """Example: Create SQLite user manager with default settings."""
    print("=== SQLite Default Example ===")

    # Method 1: Using factory with minimal config
    user_manager = UserManagerFactory.create_sqlite()

    # Method 2: Using config factory (equivalent)
    UserManagerConfigFactory(
        backend="sqlite",
        config={},  # Uses all defaults
    )

    print(f"Created user manager: {type(user_manager).__name__}")
    print(f"Database path: {user_manager.db_path}")

    # Test basic operations
    users = user_manager.list_users()
    print(f"Initial users: {[user.user_name for user in users]}")

    user_manager.close()


def example_sqlite_custom():
    """Example: Create SQLite user manager with custom settings."""
    print("\n=== SQLite Custom Example ===")

    config_factory = UserManagerConfigFactory(
        backend="sqlite", config={"db_path": "/tmp/custom_memos.db", "user_id": "admin"}
    )

    user_manager = UserManagerFactory.from_config(config_factory)
    print(f"Created user manager: {type(user_manager).__name__}")
    print(f"Database path: {user_manager.db_path}")

    # Test operations
    user_id = user_manager.create_user("test_user")
    print(f"Created user: {user_id}")

    user_manager.close()


def example_mysql():
    """Example: Create MySQL user manager."""
    print("\n=== MySQL Example ===")

    # Method 1: Using factory with parameters
    try:
        user_manager = UserManagerFactory.create_mysql(
            host="localhost",
            port=3306,
            username="root",
            password="your_password",  # Replace with actual password
            database="test_memos_users",
        )

        print(f"Created user manager: {type(user_manager).__name__}")
        print(f"Connection URL: {user_manager.connection_url}")

        # Test operations
        users = user_manager.list_users()
        print(f"Users: {[user.user_name for user in users]}")

        user_manager.close()

    except Exception as e:
        print(f"MySQL connection failed (expected if not set up): {e}")


def example_persistent_managers():
    """Example: Create persistent user managers with configuration storage."""
    print("\n=== Persistent User Manager Examples ===")

    # SQLite persistent manager
    config_factory = UserManagerConfigFactory(backend="sqlite", config={})

    persistent_manager = PersistentUserManagerFactory.from_config(config_factory)
    print(f"Created persistent manager: {type(persistent_manager).__name__}")

    # Test config operations
    from memos.configs.mem_os import MOSConfig

    # Create a sample config (you might need to adjust this based on MOSConfig structure)
    try:
        # This is a simplified example - adjust based on actual MOSConfig requirements
        sample_config = MOSConfig()  # Use default config

        # Save user config
        success = persistent_manager.save_user_config("test_user", sample_config)
        print(f"Config saved: {success}")

        # Retrieve user config
        retrieved_config = persistent_manager.get_user_config("test_user")
        print(f"Config retrieved: {retrieved_config is not None}")

    except Exception as e:
        print(f"Config operations failed: {e}")

    persistent_manager.close()


if __name__ == "__main__":
    # Run all examples
    example_sqlite_default()
