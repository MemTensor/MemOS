#!/usr/bin/env python3
"""
ORM Examples for MemScheduler

This script demonstrates how to use the BaseDBManager's new environment variable loading methods
for MySQL and Redis connections.
"""

import multiprocessing
import os
import sys

from pathlib import Path


# Add the src directory to the Python path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "src"))

from memos.log import get_logger
from memos.mem_scheduler.orm_modules.base_model import BaseDBManager, DatabaseError
from memos.mem_scheduler.orm_modules.redis_model import RedisDBManager, SimpleListManager


logger = get_logger(__name__)


def test_mysql_engine_from_env():
    """Test loading MySQL engine from environment variables"""
    print("\n" + "=" * 60)
    print("Testing MySQL Engine from Environment Variables")
    print("=" * 60)

    try:
        # Test loading MySQL engine from current environment variables
        mysql_engine = BaseDBManager.load_mysql_engine_from_env()
        if mysql_engine is None:
            print("❌ Failed to create MySQL engine - check environment variables")
            return

        print(f"✅ Successfully created MySQL engine: {mysql_engine}")
        print(f"   Engine URL: {mysql_engine.url}")

        # Test connection
        with mysql_engine.connect() as conn:
            from sqlalchemy import text

            result = conn.execute(text("SELECT 'MySQL connection test successful' as message"))
            message = result.fetchone()[0]
            print(f"   Connection test: {message}")

        mysql_engine.dispose()
        print("   MySQL engine disposed successfully")

    except DatabaseError as e:
        print(f"❌ DatabaseError: {e}")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")


def test_redis_connection_from_env():
    """Test loading Redis connection from environment variables"""
    print("\n" + "=" * 60)
    print("Testing Redis Connection from Environment Variables")
    print("=" * 60)

    try:
        # Test loading Redis connection from current environment variables
        redis_client = BaseDBManager.load_redis_engine_from_env()
        if redis_client is None:
            print("❌ Failed to create Redis connection - check environment variables")
            return

        print(f"✅ Successfully created Redis connection: {redis_client}")

        # Test basic Redis operations
        redis_client.set("test_key", "Hello from ORM Examples!")
        value = redis_client.get("test_key")
        print(f"   Redis test - Set/Get: {value}")

        # Test Redis info
        info = redis_client.info("server")
        redis_version = info.get("redis_version", "unknown")
        print(f"   Redis server version: {redis_version}")

        # Clean up test key
        redis_client.delete("test_key")
        print("   Test key cleaned up")

        redis_client.close()
        print("   Redis connection closed successfully")

    except DatabaseError as e:
        print(f"❌ DatabaseError: {e}")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")


def test_environment_variables():
    """Test and display current environment variables"""
    print("\n" + "=" * 60)
    print("Current Environment Variables")
    print("=" * 60)

    # MySQL environment variables
    mysql_vars = [
        "MYSQL_HOST",
        "MYSQL_PORT",
        "MYSQL_USERNAME",
        "MYSQL_PASSWORD",
        "MYSQL_DATABASE",
        "MYSQL_CHARSET",
    ]

    print("\nMySQL Environment Variables:")
    for var in mysql_vars:
        value = os.getenv(var, "Not set")
        # Mask password for security
        if "PASSWORD" in var and value != "Not set":
            value = "*" * len(value)
        print(f"   {var}: {value}")

    # Redis environment variables
    redis_vars = [
        "REDIS_HOST",
        "REDIS_PORT",
        "REDIS_DB",
        "REDIS_PASSWORD",
        "MEMSCHEDULER_REDIS_HOST",
        "MEMSCHEDULER_REDIS_PORT",
        "MEMSCHEDULER_REDIS_DB",
        "MEMSCHEDULER_REDIS_PASSWORD",
    ]

    print("\nRedis Environment Variables:")
    for var in redis_vars:
        value = os.getenv(var, "Not set")
        # Mask password for security
        if "PASSWORD" in var and value != "Not set":
            value = "*" * len(value)
        print(f"   {var}: {value}")


def test_manual_env_loading():
    """Test loading environment variables manually from .env file"""
    print("\n" + "=" * 60)
    print("Testing Manual Environment Loading")
    print("=" * 60)

    env_file_path = "/Users/travistang/Documents/codes/memos/.env"

    if not os.path.exists(env_file_path):
        print(f"❌ Environment file not found: {env_file_path}")
        return

    try:
        from dotenv import load_dotenv

        # Load environment variables
        load_dotenv(env_file_path)
        print(f"✅ Successfully loaded environment variables from {env_file_path}")

        # Test some key variables
        test_vars = ["OPENAI_API_KEY", "MOS_CHAT_MODEL", "TZ"]
        for var in test_vars:
            value = os.getenv(var, "Not set")
            if "KEY" in var and value != "Not set":
                value = f"{value[:10]}..." if len(value) > 10 else value
            print(f"   {var}: {value}")

    except ImportError:
        print("❌ python-dotenv not installed. Install with: pip install python-dotenv")
    except Exception as e:
        print(f"❌ Error loading environment file: {e}")


def test_redis_lockable_orm_with_list():
    """Test RedisDBManager with list[str] type synchronization"""
    print("\n" + "=" * 60)
    print("Testing RedisDBManager with list[str]")
    print("=" * 60)

    try:
        from memos.mem_scheduler.orm_modules.redis_model import RedisDBManager

        # Create a simple list manager instance
        list_manager = SimpleListManager(["apple", "banana", "cherry"])
        print(f"Original list manager: {list_manager}")

        # Create RedisDBManager instance
        redis_client = BaseDBManager.load_redis_engine_from_env()
        if redis_client is None:
            print("❌ Failed to create Redis connection - check environment variables")
            return

        db_manager = RedisDBManager(
            redis_client=redis_client,
            user_id="test_user",
            mem_cube_id="test_list_cube",
            obj=list_manager,
        )

        # Save to Redis
        db_manager.save_to_db(list_manager)
        print("✅ List manager saved to Redis")

        # Load from Redis
        loaded_manager = db_manager.load_from_db()
        if loaded_manager:
            print(f"Loaded list manager: {loaded_manager}")
            print(f"Items match: {list_manager.items == loaded_manager.items}")
        else:
            print("❌ Failed to load list manager from Redis")

        # Clean up
        redis_client.delete("lockable_orm:test_user:test_list_cube:data")
        redis_client.delete("lockable_orm:test_user:test_list_cube:lock")
        redis_client.delete("lockable_orm:test_user:test_list_cube:version")
        redis_client.close()

    except Exception as e:
        print(f"❌ Error in RedisDBManager test: {e}")


def modify_list_process(process_id: int, items_to_add: list[str]):
    """Function to be run in separate processes to modify the list using merge_items"""
    try:
        from memos.mem_scheduler.orm_modules.redis_model import RedisDBManager

        # Create Redis connection
        redis_client = BaseDBManager.load_redis_engine_from_env()
        if redis_client is None:
            print(f"Process {process_id}: Failed to create Redis connection")
            return

        # Create a temporary list manager for this process with items to add
        temp_manager = SimpleListManager()

        db_manager = RedisDBManager(
            redis_client=redis_client,
            user_id="test_user",
            mem_cube_id="multiprocess_list",
            obj=temp_manager,
        )

        print(f"Process {process_id}: Starting modification with items: {items_to_add}")
        for item in items_to_add:
            db_manager.obj.add_item(item)
            # Use sync_with_orm which internally uses merge_items
            db_manager.sync_with_orm(size_limit=None)

        print(f"Process {process_id}: Successfully synchronized with Redis")

        redis_client.close()

    except Exception as e:
        print(f"Process {process_id}: Error - {e}")
        import traceback

        traceback.print_exc()


def test_multiprocess_synchronization():
    """Test multiprocess synchronization with RedisDBManager"""
    print("\n" + "=" * 60)
    print("Testing Multiprocess Synchronization")
    print("=" * 60)

    try:
        # Initialize Redis with empty list
        redis_client = BaseDBManager.load_redis_engine_from_env()
        if redis_client is None:
            print("❌ Failed to create Redis connection")
            return

        # Initialize with empty list
        initial_manager = SimpleListManager([])
        db_manager = RedisDBManager(
            redis_client=redis_client,
            user_id="test_user",
            mem_cube_id="multiprocess_list",
            obj=initial_manager,
        )
        db_manager.save_to_db(initial_manager)
        print("✅ Initialized empty list manager in Redis")

        # Define items for each process to add
        process_items = [
            ["item1", "item2"],
            ["item3", "item4"],
            ["item5", "item6"],
            ["item1", "item7"],  # item1 is duplicate, should not be added twice
        ]

        # Create and start processes
        processes = []
        for i, items in enumerate(process_items):
            p = multiprocessing.Process(target=modify_list_process, args=(i + 1, items))
            processes.append(p)
            p.start()

        # Wait for all processes to complete
        for p in processes:
            p.join()

        print("\n" + "-" * 40)
        print("All processes completed. Checking final result...")

        # Load final result
        final_db_manager = RedisDBManager(
            redis_client=redis_client,
            user_id="test_user",
            mem_cube_id="multiprocess_list",
            obj=SimpleListManager([]),
        )
        final_manager = final_db_manager.load_from_db()

        if final_manager:
            print(f"Final synchronized list manager: {final_manager}")
            print(f"Final list length: {len(final_manager)}")
            print("Expected items: {'item1', 'item2', 'item3', 'item4', 'item5', 'item6', 'item7'}")
            print(f"Actual items: {set(final_manager.items)}")

            # Check if all unique items are present
            expected_items = {"item1", "item2", "item3", "item4", "item5", "item6", "item7"}
            actual_items = set(final_manager.items)

            if expected_items == actual_items:
                print("✅ All processes contributed correctly - synchronization successful!")
            else:
                print(f"❌ Expected items: {expected_items}")
                print(f"   Actual items: {actual_items}")
        else:
            print("❌ Failed to load final result")

        # Clean up
        redis_client.delete("lockable_orm:test_user:multiprocess_list:data")
        redis_client.delete("lockable_orm:test_user:multiprocess_list:lock")
        redis_client.delete("lockable_orm:test_user:multiprocess_list:version")
        redis_client.close()

    except Exception as e:
        print(f"❌ Error in multiprocess synchronization test: {e}")


def main():
    """Main function to run all tests"""
    print("ORM Examples - Environment Variable Loading Tests")
    print("=" * 80)

    # Test environment variables display
    test_environment_variables()

    # Test manual environment loading
    test_manual_env_loading()

    # Test MySQL engine loading
    test_mysql_engine_from_env()

    # Test Redis connection loading
    test_redis_connection_from_env()

    # Test RedisLockableORM with list[str]
    test_redis_lockable_orm_with_list()

    # Test multiprocess synchronization
    test_multiprocess_synchronization()

    print("\n" + "=" * 80)
    print("All tests completed!")
    print("=" * 80)


if __name__ == "__main__":
    main()
