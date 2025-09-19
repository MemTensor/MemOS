import os
import tempfile

import pytest

from memos.mem_scheduler.orm_modules.base_model import BaseDBManager
from memos.mem_scheduler.orm_modules.monitor_models import DBManagerForMemoryMonitorManager
from memos.mem_scheduler.schemas.monitor_schemas import (
    MemoryMonitorItem,
    MemoryMonitorManager,
)


class TestVersionControl:
    """Test version control functionality"""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary database for testing."""
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_version_control.db")
        yield db_path
        # Cleanup
        try:
            if os.path.exists(db_path):
                os.remove(db_path)
            os.rmdir(temp_dir)
        except (OSError, PermissionError):
            pass

    @pytest.fixture
    def memory_manager_obj(self):
        """Create a MemoryMonitorManager object for testing"""
        return MemoryMonitorManager(
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            memories=[
                MemoryMonitorItem(
                    item_id="test-item-1",
                    memory_text="Test memory 1",
                    tree_memory_item=None,
                    tree_memory_item_mapping_key="test_key_1",
                    keywords_score=0.8,
                    sorting_score=0.9,
                    importance_score=0.7,
                    recording_count=1,
                )
            ],
        )

    def test_version_control_increment(self, temp_db, memory_manager_obj):
        """Test that version_control increments correctly"""
        engine = BaseDBManager.create_engine_from_db_path(temp_db)
        manager = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # Test increment method
            assert manager._increment_version_control("0") == "1"
            assert manager._increment_version_control("255") == "0"  # Should cycle back to 0
            assert manager._increment_version_control("100") == "101"
            assert (
                manager._increment_version_control("invalid") == "0"
            )  # Should handle invalid input

        finally:
            manager.close()

    def test_new_record_has_version_zero(self, temp_db, memory_manager_obj):
        """Test that new records start with version_control = "0" """
        engine = BaseDBManager.create_engine_from_db_path(temp_db)
        manager = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # Save to database
            manager.save_to_db(memory_manager_obj)

            # Check that last_version_control was set to "0"
            assert manager.last_version_control == "0"

            # Load from database and verify version_control
            loaded_obj = manager.load_from_db()
            assert loaded_obj is not None

            # Check that the version was tracked
            assert manager.last_version_control == "0"

        finally:
            manager.close()

    def test_version_control_increments_on_save(self, temp_db, memory_manager_obj):
        """Test that version_control increments when saving existing records"""
        engine = BaseDBManager.create_engine_from_db_path(temp_db)
        manager = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # First save - should create with version "0"
            manager.save_to_db(memory_manager_obj)
            assert manager.last_version_control == "0"

            # Second save - should increment to version "1"
            manager.save_to_db(memory_manager_obj)
            assert manager.last_version_control == "1"

            # Third save - should increment to version "2"
            manager.save_to_db(memory_manager_obj)
            assert manager.last_version_control == "2"

        finally:
            manager.close()

    def test_sync_with_orm_version_control(self, temp_db, memory_manager_obj):
        """Test version control behavior in sync_with_orm"""
        engine = BaseDBManager.create_engine_from_db_path(temp_db)
        manager = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # First sync - should create with version "0"
            manager.sync_with_orm()
            assert manager.last_version_control == "0"

            # Second sync with same object - should increment version because sync_with_orm always increments
            manager.sync_with_orm()
            assert (
                manager.last_version_control == "1"
            )  # Should increment to "1" since sync_with_orm always increments

            # Third sync - should increment to version "2"
            manager.sync_with_orm()
            assert manager.last_version_control == "2"  # Should increment to "2"

            # Simulate a change by creating a new object with different content
            new_memory_manager = MemoryMonitorManager(
                user_id="test_user",
                mem_cube_id="test_mem_cube",
                memories=[
                    MemoryMonitorItem(
                        item_id="test-item-2",
                        memory_text="Test memory 2",
                        tree_memory_item=None,
                        tree_memory_item_mapping_key="test_key_2",
                        keywords_score=0.9,
                        sorting_score=0.8,
                        importance_score=0.6,
                        recording_count=2,
                    )
                ],
            )

            # Update the manager's object
            manager.obj = new_memory_manager

            # Sync again - should increment version because object content changed
            manager.sync_with_orm()
            assert manager.last_version_control == "3"  # Should increment to "3"

        finally:
            manager.close()

    def test_version_control_cycles_correctly(self, temp_db, memory_manager_obj):
        """Test that version_control cycles from 255 back to 0"""
        engine = BaseDBManager.create_engine_from_db_path(temp_db)
        manager = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # Test the increment method directly
            assert manager._increment_version_control("255") == "0"
            assert manager._increment_version_control("254") == "255"
            assert manager._increment_version_control("0") == "1"

        finally:
            manager.close()

    def test_load_from_db_updates_version_control(self, temp_db, memory_manager_obj):
        """Test that load_from_db updates last_version_control correctly"""
        engine = BaseDBManager.create_engine_from_db_path(temp_db)
        manager = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # Save to database first
            manager.save_to_db(memory_manager_obj)
            assert manager.last_version_control == "0"

            # Create a new manager instance to load the data
            load_manager = DBManagerForMemoryMonitorManager(
                engine=engine,
                user_id="test_user",
                mem_cube_id="test_mem_cube",
            )

            # Load from database
            loaded_obj = load_manager.load_from_db()
            assert loaded_obj is not None
            assert load_manager.last_version_control == "0"  # Should be updated to loaded version

            load_manager.close()

        finally:
            manager.close()

    def test_version_control_persistence_across_instances(self, temp_db, memory_manager_obj):
        """Test that version control persists across different manager instances"""
        engine = BaseDBManager.create_engine_from_db_path(temp_db)

        # First manager instance
        manager1 = DBManagerForMemoryMonitorManager(
            engine=engine,
            user_id="test_user",
            mem_cube_id="test_mem_cube",
            obj=memory_manager_obj,
        )

        try:
            # Save multiple times to increment version
            manager1.save_to_db(memory_manager_obj)
            assert manager1.last_version_control == "0"

            manager1.save_to_db(memory_manager_obj)
            assert manager1.last_version_control == "1"

            manager1.save_to_db(memory_manager_obj)
            assert manager1.last_version_control == "2"

            # Create second manager instance
            manager2 = DBManagerForMemoryMonitorManager(
                engine=engine,
                user_id="test_user",
                mem_cube_id="test_mem_cube",
                obj=memory_manager_obj,
            )

            # Load should show the same version
            loaded_obj = manager2.load_from_db()
            assert loaded_obj is not None
            assert manager2.last_version_control == "2"  # Should match the last saved version

            # Save again should increment from the loaded version
            manager2.save_to_db(memory_manager_obj)
            assert manager2.last_version_control == "3"

            manager2.close()

        finally:
            manager1.close()
