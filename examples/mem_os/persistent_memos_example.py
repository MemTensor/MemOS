"""
Example demonstrating persistent user management in MemOS.

This example shows how to use the PersistentUserManager to maintain
user configurations across service restarts.
"""

import os
import tempfile

from memos.configs.mem_os import MOSConfig
from memos.mem_os.product import MOSProduct
from memos.mem_user.persistent_user_manager import PersistentUserManager, UserRole


def create_sample_config(user_id: str) -> MOSConfig:
    """Create a sample configuration for a user."""
    return MOSConfig(
        user_id=user_id,
        chat_model={
            "backend": "openai",
            "config": {
                "model_name_or_path": "gpt-3.5-turbo",
                "api_key": "your-api-key-here",
                "temperature": 0.7,
            },
        },
        mem_reader={
            "backend": "naive",
            "config": {
                "llm": {
                    "backend": "openai",
                    "config": {
                        "model_name_or_path": "gpt-3.5-turbo",
                        "api_key": "your-api-key-here",
                    },
                },
                "embedder": {
                    "backend": "ollama",
                    "config": {
                        "model_name_or_path": "nomic-embed-text:latest",
                    },
                },
            },
        },
        enable_textual_memory=True,
        enable_activation_memory=False,
        top_k=5,
        max_turns_window=20,
    )


def demonstrate_persistence():
    """Demonstrate the persistence functionality."""
    print("=== MemOS Persistent User Management Demo ===\n")

    # Create a temporary database for this demo
    temp_dir = tempfile.mkdtemp()
    db_path = os.path.join(temp_dir, "demo_memos.db")

    try:
        # Step 1: Create a persistent user manager
        print("1. Creating PersistentUserManager...")
        user_manager = PersistentUserManager(db_path=db_path)
        print(f"   Database created at: {db_path}")

        # Step 2: Create some sample configurations
        print("\n2. Creating sample user configurations...")
        user_configs = {}
        for i in range(3):
            user_id = f"user_{i + 1}"
            user_name = f"User {i + 1}"
            config = create_sample_config(user_id)
            user_configs[user_id] = config

            # Create user with configuration
            created_id = user_manager.create_user_with_config(
                user_name, config, UserRole.USER, user_id
            )
            print(f"   Created user: {user_name} (ID: {created_id})")

        # Step 3: Verify configurations are saved
        print("\n3. Verifying configurations are saved...")
        for user_id in user_configs:
            config = user_manager.get_user_config(user_id)
            if config:
                print(f"   ✓ Configuration found for {user_id}")
                print(f"     - Textual memory enabled: {config.enable_textual_memory}")
                print(f"     - Top-k: {config.top_k}")
            else:
                print(f"   ✗ Configuration not found for {user_id}")

        # Step 4: Simulate service restart by creating a new manager instance
        print("\n4. Simulating service restart...")
        print("   Creating new PersistentUserManager instance...")
        new_user_manager = PersistentUserManager(db_path=db_path)

        # Step 5: Verify configurations are restored
        print("\n5. Verifying configurations are restored after restart...")
        for user_id in user_configs:
            config = new_user_manager.get_user_config(user_id)
            if config:
                print(f"   ✓ Configuration restored for {user_id}")
            else:
                print(f"   ✗ Configuration not restored for {user_id}")

        # Step 6: Create MOSProduct and demonstrate restoration
        print("\n6. Creating MOSProduct with persistent user manager...")
        default_config = create_sample_config("default_user")
        mos_product = MOSProduct(default_config=default_config)

        # The MOSProduct should automatically restore user instances
        print(f"   Active user instances: {len(mos_product.user_instances)}")
        for user_id in mos_product.user_instances:
            print(f"   - {user_id}")

        # Step 7: Demonstrate configuration update
        print("\n7. Demonstrating configuration update...")
        user_id = "user_1"
        original_config = user_manager.get_user_config(user_id)
        if original_config:
            # Update configuration
            updated_config = original_config.model_copy(deep=True)
            updated_config.top_k = 10
            updated_config.enable_activation_memory = True

            success = user_manager.save_user_config(user_id, updated_config)
            if success:
                print(f"   ✓ Updated configuration for {user_id}")
                print(f"     - New top-k: {updated_config.top_k}")
                print(f"     - Activation memory: {updated_config.enable_activation_memory}")
            else:
                print(f"   ✗ Failed to update configuration for {user_id}")

        # Step 8: List all configurations
        print("\n8. Listing all user configurations...")
        all_configs = user_manager.list_user_configs()
        print(f"   Total configurations: {len(all_configs)}")
        for user_id, config in all_configs.items():
            print(
                f"   - {user_id}: top_k={config.top_k}, textual_memory={config.enable_textual_memory}"
            )

        print("\n=== Demo completed successfully! ===")
        print(f"Database file: {db_path}")
        print("You can inspect this file to see the persistent data.")

    except Exception as e:
        print(f"Error during demo: {e}")
        raise
    finally:
        # Cleanup
        if os.path.exists(db_path):
            os.remove(db_path)
        if os.path.exists(temp_dir):
            os.rmdir(temp_dir)


def demonstrate_api_usage():
    """Demonstrate how the API would work with persistence."""
    print("\n=== API Usage Example ===")
    print("""
    With the new persistent system, your API calls would work like this:

    1. Register a user (configuration is automatically saved):
       POST /product/users/register
       {
         "user_id": "john_doe",
         "user_name": "John Doe",
         "interests": "AI, machine learning, programming"
       }

    2. Get user configuration:
       GET /product/users/john_doe/config

    3. Update user configuration:
       PUT /product/users/john_doe/config
       {
         "user_id": "john_doe",
         "enable_activation_memory": true,
         "top_k": 10,
         ...
       }

    4. After service restart, all user instances are automatically restored
       and the user can immediately use the system without re-registration.
    """)


if __name__ == "__main__":
    demonstrate_persistence()
    demonstrate_api_usage()
