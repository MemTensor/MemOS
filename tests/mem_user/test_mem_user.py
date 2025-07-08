"""
Test cases for the MemOS User Management System.

This module contains comprehensive test cases for testing user authentication,
authorization, and cube management functionality.
"""

import os
import tempfile
import uuid

from datetime import datetime
from pathlib import Path

import pytest

from memos.mem_user.user_manager import UserManager, UserRole


class TestUserManager:
    """Test cases for UserManager class."""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary database for testing."""
        # Create temporary database file
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_memos.db")
        yield db_path
        # Cleanup - note: file cleanup is handled by user_manager fixture
        try:
            if os.path.exists(db_path):
                os.remove(db_path)
            os.rmdir(temp_dir)
        except (OSError, PermissionError):
            # On Windows, files might still be locked, ignore cleanup errors
            pass

    @pytest.fixture
    def user_manager(self, temp_db):
        """Create UserManager instance with temporary database."""
        manager = UserManager(db_path=temp_db)
        yield manager
        # Ensure database connections are closed
        manager.close()

    def test_initialization(self, temp_db):
        """Test UserManager initialization."""
        manager = UserManager(db_path=temp_db)

        # Check database file exists
        assert os.path.exists(temp_db)

        # Check root user is created
        root_user = manager.get_user("root")
        assert root_user is not None
        assert root_user.user_name == "root"
        assert root_user.role == UserRole.ROOT
        assert root_user.is_active is True

    def test_initialization_default_path(self, monkeypatch):
        """Test UserManager initialization with default path."""
        # Mock settings.MEMOS_DIR
        temp_dir = tempfile.mkdtemp()
        mock_memos_dir = Path(temp_dir)

        class MockSettings:
            MEMOS_DIR = mock_memos_dir

        # Replace the settings import
        monkeypatch.setattr("memos.mem_user.user_manager.settings", MockSettings())

        try:
            manager = UserManager()
            expected_path = mock_memos_dir / "memos_users.db"
            assert manager.db_path == str(expected_path)
            assert os.path.exists(expected_path)
        finally:
            # Cleanup
            expected_path = mock_memos_dir / "memos_users.db"
            if os.path.exists(expected_path):
                os.remove(expected_path)
            if os.path.exists(temp_dir):
                os.rmdir(temp_dir)


class TestUserOperations:
    """Test cases for user operations."""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary database for testing."""
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_memos.db")
        yield db_path
        if os.path.exists(db_path):
            os.remove(db_path)
        os.rmdir(temp_dir)

    @pytest.fixture
    def user_manager(self, temp_db):
        """Create UserManager instance with temporary database."""
        manager = UserManager(db_path=temp_db)
        yield manager
        manager.close()

    def test_create_user(self, user_manager):
        """Test user creation."""
        user_id = user_manager.create_user("test_user", UserRole.USER)

        assert user_id is not None
        assert isinstance(user_id, str)

        # Verify user exists
        user = user_manager.get_user(user_id)
        assert user is not None
        assert user.user_name == "test_user"
        assert user.role == UserRole.USER
        assert user.is_active is True

    def test_create_user_with_custom_id(self, user_manager):
        """Test user creation with custom ID."""
        custom_id = "custom_user_123"
        user_id = user_manager.create_user("custom_user", UserRole.ADMIN, custom_id)

        assert user_id == custom_id

        user = user_manager.get_user(custom_id)
        assert user is not None
        assert user.user_id == custom_id
        assert user.user_name == "custom_user"
        assert user.role == UserRole.ADMIN

    def test_create_duplicate_user(self, user_manager):
        """Test creating user with duplicate name."""
        # Create first user
        user_id1 = user_manager.create_user("duplicate_user", UserRole.USER)

        # Try to create user with same name
        user_id2 = user_manager.create_user("duplicate_user", UserRole.ADMIN)

        # Should return existing user ID
        assert user_id1 == user_id2

        # Verify only one user exists
        user = user_manager.get_user(user_id1)
        assert user.role == UserRole.USER  # Original role preserved

    def test_get_user_by_name(self, user_manager):
        """Test getting user by name."""
        user_id = user_manager.create_user("named_user", UserRole.USER)

        user = user_manager.get_user_by_name("named_user")
        assert user is not None
        assert user.user_id == user_id
        assert user.user_name == "named_user"

        # Test non-existent user
        non_existent = user_manager.get_user_by_name("non_existent")
        assert non_existent is None

    def test_validate_user(self, user_manager):
        """Test user validation."""
        user_id = user_manager.create_user("valid_user", UserRole.USER)

        # Valid user
        assert user_manager.validate_user(user_id) is True

        # Non-existent user
        assert user_manager.validate_user("non_existent") is False

        # Deactivated user
        user_manager.delete_user(user_id)
        assert user_manager.validate_user(user_id) is False

    def test_list_users(self, user_manager):
        """Test listing users."""
        # Create multiple users
        user_manager.create_user("user1", UserRole.USER)
        user_manager.create_user("user2", UserRole.ADMIN)
        user_id3 = user_manager.create_user("user3", UserRole.GUEST)

        users = user_manager.list_users()

        # Should include root user + 3 created users
        assert len(users) == 4

        user_names = [user.user_name for user in users]
        assert "root" in user_names
        assert "user1" in user_names
        assert "user2" in user_names
        assert "user3" in user_names

        # Deactivate one user
        user_manager.delete_user(user_id3)

        active_users = user_manager.list_users()
        active_names = [user.user_name for user in active_users]
        assert len(active_users) == 3
        assert "user3" not in active_names

    def test_delete_user(self, user_manager):
        """Test user deletion (soft delete)."""
        user_id = user_manager.create_user("delete_user", UserRole.USER)

        # Verify user exists and is active
        assert user_manager.validate_user(user_id) is True

        # Delete user
        result = user_manager.delete_user(user_id)
        assert result is True

        # Verify user is deactivated
        assert user_manager.validate_user(user_id) is False

        # User still exists but is inactive
        user = user_manager.get_user(user_id)
        assert user is not None
        assert user.is_active is False

    def test_delete_root_user(self, user_manager):
        """Test that root user cannot be deleted."""
        result = user_manager.delete_user("root")
        assert result is False

        # Root user should still be active
        assert user_manager.validate_user("root") is True

    def test_delete_nonexistent_user(self, user_manager):
        """Test deleting non-existent user."""
        result = user_manager.delete_user("non_existent")
        assert result is False


class TestCubeOperations:
    """Test cases for cube operations."""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary database for testing."""
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_memos.db")
        yield db_path
        if os.path.exists(db_path):
            os.remove(db_path)
        os.rmdir(temp_dir)

    @pytest.fixture
    def user_manager(self, temp_db):
        """Create UserManager instance with temporary database."""
        manager = UserManager(db_path=temp_db)
        yield manager
        manager.close()

    def test_create_cube(self, user_manager):
        """Test cube creation."""
        # Create owner user
        owner_id = user_manager.create_user("cube_owner", UserRole.USER)

        # Create cube
        cube_id = user_manager.create_cube("test_cube", owner_id)

        assert cube_id is not None
        assert isinstance(cube_id, str)

        # Verify cube exists
        cube = user_manager.get_cube(cube_id)
        assert cube is not None
        assert cube.cube_name == "test_cube"
        assert cube.owner_id == owner_id
        assert cube.is_active is True

    def test_create_cube_with_path_and_custom_id(self, user_manager):
        """Test cube creation with path and custom ID."""
        owner_id = user_manager.create_user("cube_owner", UserRole.USER)

        custom_cube_id = "custom_cube_123"
        cube_path = str(Path("/path/to/cube"))  # Use pathlib for cross-platform path handling

        cube_id = user_manager.create_cube(
            "custom_cube", owner_id, cube_path=cube_path, cube_id=custom_cube_id
        )

        assert cube_id == custom_cube_id

        cube = user_manager.get_cube(custom_cube_id)
        assert cube is not None
        assert cube.cube_id == custom_cube_id
        assert cube.cube_name == "custom_cube"
        assert cube.cube_path == cube_path
        assert cube.owner_id == owner_id

    def test_create_cube_invalid_owner(self, user_manager):
        """Test cube creation with invalid owner."""
        with pytest.raises(ValueError, match="does not exist"):
            user_manager.create_cube("test_cube", "non_existent_owner")

    def test_validate_user_cube_access(self, user_manager):
        """Test user cube access validation."""
        # Create users
        owner_id = user_manager.create_user("owner", UserRole.USER)
        user_id = user_manager.create_user("user", UserRole.USER)

        # Create cube
        cube_id = user_manager.create_cube("test_cube", owner_id)

        # Owner should have access
        assert user_manager.validate_user_cube_access(owner_id, cube_id) is True

        # Other user should not have access initially
        assert user_manager.validate_user_cube_access(user_id, cube_id) is False

        # Add user to cube
        user_manager.add_user_to_cube(user_id, cube_id)
        assert user_manager.validate_user_cube_access(user_id, cube_id) is True

        # Non-existent user should not have access
        assert user_manager.validate_user_cube_access("non_existent", cube_id) is False

        # Non-existent cube should not be accessible
        assert user_manager.validate_user_cube_access(owner_id, "non_existent") is False

    def test_get_user_cubes(self, user_manager):
        """Test getting user's accessible cubes."""
        # Create users
        owner_id = user_manager.create_user("owner", UserRole.USER)
        user_id = user_manager.create_user("user", UserRole.USER)

        # Create cubes
        cube_id1 = user_manager.create_cube("cube1", owner_id)
        cube_id2 = user_manager.create_cube("cube2", owner_id)
        cube_id3 = user_manager.create_cube("cube3", user_id)

        # Add user to cube1
        user_manager.add_user_to_cube(user_id, cube_id1)

        # Get cubes accessible by user
        user_cubes = user_manager.get_user_cubes(user_id)
        cube_ids = [cube.cube_id for cube in user_cubes]

        assert len(user_cubes) == 2
        assert cube_id1 in cube_ids  # Added to cube
        assert cube_id3 in cube_ids  # Owned cube
        assert cube_id2 not in cube_ids  # No access

        # Get cubes accessible by owner
        owner_cubes = user_manager.get_user_cubes(owner_id)
        owner_cube_ids = [cube.cube_id for cube in owner_cubes]

        assert len(owner_cubes) == 2
        assert cube_id1 in owner_cube_ids
        assert cube_id2 in owner_cube_ids
        assert cube_id3 not in owner_cube_ids

    def test_add_user_to_cube(self, user_manager):
        """Test adding user to cube."""
        # Create users and cube
        owner_id = user_manager.create_user("owner", UserRole.USER)
        user_id = user_manager.create_user("user", UserRole.USER)
        cube_id = user_manager.create_cube("test_cube", owner_id)

        # Add user to cube
        result = user_manager.add_user_to_cube(user_id, cube_id)
        assert result is True

        # Verify access
        assert user_manager.validate_user_cube_access(user_id, cube_id) is True

        # Adding same user again should still work
        result = user_manager.add_user_to_cube(user_id, cube_id)
        assert result is True

        # Adding non-existent user should fail
        result = user_manager.add_user_to_cube("non_existent", cube_id)
        assert result is False

        # Adding user to non-existent cube should fail
        result = user_manager.add_user_to_cube(user_id, "non_existent")
        assert result is False

    def test_remove_user_from_cube(self, user_manager):
        """Test removing user from cube."""
        # Create users and cube
        owner_id = user_manager.create_user("owner", UserRole.USER)
        user_id = user_manager.create_user("user", UserRole.USER)
        cube_id = user_manager.create_cube("test_cube", owner_id)

        # Add and then remove user
        user_manager.add_user_to_cube(user_id, cube_id)
        assert user_manager.validate_user_cube_access(user_id, cube_id) is True

        result = user_manager.remove_user_from_cube(user_id, cube_id)
        assert result is True
        assert user_manager.validate_user_cube_access(user_id, cube_id) is False

        # Cannot remove owner
        result = user_manager.remove_user_from_cube(owner_id, cube_id)
        assert result is False
        assert user_manager.validate_user_cube_access(owner_id, cube_id) is True

        # Removing non-existent user should fail
        result = user_manager.remove_user_from_cube("non_existent", cube_id)
        assert result is False

    def test_delete_cube(self, user_manager):
        """Test cube deletion (soft delete)."""
        owner_id = user_manager.create_user("owner", UserRole.USER)
        cube_id = user_manager.create_cube("test_cube", owner_id)

        # Verify cube is active
        cube = user_manager.get_cube(cube_id)
        assert cube.is_active is True

        # Delete cube
        result = user_manager.delete_cube(cube_id)
        assert result is True

        # Verify cube is deactivated
        cube = user_manager.get_cube(cube_id)
        assert cube.is_active is False

        # Should not have access to deactivated cube
        assert user_manager.validate_user_cube_access(owner_id, cube_id) is False

    def test_delete_nonexistent_cube(self, user_manager):
        """Test deleting non-existent cube."""
        result = user_manager.delete_cube("non_existent")
        assert result is False


class TestUserRoles:
    """Test cases for user roles and permissions."""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary database for testing."""
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_memos.db")
        yield db_path
        if os.path.exists(db_path):
            os.remove(db_path)
        os.rmdir(temp_dir)

    @pytest.fixture
    def user_manager(self, temp_db):
        """Create UserManager instance with temporary database."""
        manager = UserManager(db_path=temp_db)
        yield manager
        manager.close()

    def test_user_roles(self, user_manager):
        """Test different user roles."""
        # Test all user roles
        admin_id = user_manager.create_user("admin", UserRole.ADMIN)
        user_id = user_manager.create_user("user", UserRole.USER)
        guest_id = user_manager.create_user("guest", UserRole.GUEST)

        admin = user_manager.get_user(admin_id)
        user = user_manager.get_user(user_id)
        guest = user_manager.get_user(guest_id)
        root = user_manager.get_user("root")

        assert admin.role == UserRole.ADMIN
        assert user.role == UserRole.USER
        assert guest.role == UserRole.GUEST
        assert root.role == UserRole.ROOT

    def test_root_user_protection(self, user_manager):
        """Test root user cannot be deleted."""
        # Root user should exist
        root = user_manager.get_user("root")
        assert root is not None
        assert root.role == UserRole.ROOT

        # Cannot delete root user
        result = user_manager.delete_user("root")
        assert result is False

        # Root user should still be active
        assert user_manager.validate_user("root") is True


class TestDatabaseIntegrity:
    """Test cases for database integrity and edge cases."""

    @pytest.fixture
    def temp_db(self):
        """Create a temporary database for testing."""
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_memos.db")
        yield db_path
        if os.path.exists(db_path):
            os.remove(db_path)
        os.rmdir(temp_dir)

    @pytest.fixture
    def user_manager(self, temp_db):
        """Create UserManager instance with temporary database."""
        manager = UserManager(db_path=temp_db)
        yield manager
        manager.close()

    def test_cascade_delete_user_cubes(self, user_manager):
        """Test that user's owned cubes are handled when user is deleted."""
        # Create user and cube
        owner_id = user_manager.create_user("owner", UserRole.USER)
        cube_id = user_manager.create_cube("test_cube", owner_id)

        # Verify relationships
        assert user_manager.validate_user_cube_access(owner_id, cube_id) is True

        # Delete user (soft delete)
        user_manager.delete_user(owner_id)

        # User should be deactivated
        assert user_manager.validate_user(owner_id) is False

        # Cube should still exist but user shouldn't have access
        cube = user_manager.get_cube(cube_id)
        assert cube is not None
        assert user_manager.validate_user_cube_access(owner_id, cube_id) is False

    def test_timestamps(self, user_manager):
        """Test that timestamps are properly set."""
        # Create user
        user_id = user_manager.create_user("timestamp_user", UserRole.USER)
        user = user_manager.get_user(user_id)

        assert user.created_at is not None
        assert user.updated_at is not None
        assert isinstance(user.created_at, datetime)
        assert isinstance(user.updated_at, datetime)

        # Create cube
        cube_id = user_manager.create_cube("timestamp_cube", user_id)
        cube = user_manager.get_cube(cube_id)

        assert cube.created_at is not None
        assert cube.updated_at is not None
        assert isinstance(cube.created_at, datetime)
        assert isinstance(cube.updated_at, datetime)

    def test_uuid_generation(self, user_manager):
        """Test UUID generation for IDs."""
        # Create user without custom ID
        user_id = user_manager.create_user("uuid_user", UserRole.USER)

        # Should be valid UUID format
        try:
            uuid.UUID(user_id)
        except ValueError:
            pytest.fail(f"Generated user_id '{user_id}' is not a valid UUID")

        # Create cube without custom ID
        cube_id = user_manager.create_cube("uuid_cube", user_id)

        try:
            uuid.UUID(cube_id)
        except ValueError:
            pytest.fail(f"Generated cube_id '{cube_id}' is not a valid UUID")

    def test_session_management(self, user_manager):
        """Test that database sessions are properly managed."""
        # This test ensures that sessions are properly closed
        # by performing multiple operations

        users = []
        cubes = []

        # Create multiple users and cubes
        for i in range(10):
            user_id = user_manager.create_user(f"user_{i}", UserRole.USER)
            users.append(user_id)

            cube_id = user_manager.create_cube(f"cube_{i}", user_id)
            cubes.append(cube_id)

        # Verify all users exist
        for user_id in users:
            assert user_manager.validate_user(user_id) is True

        # Verify all cubes exist
        for cube_id in cubes:
            cube = user_manager.get_cube(cube_id)
            assert cube is not None
            assert cube.is_active is True

        # Clean up - delete some users and cubes
        for i in range(0, 10, 2):  # Delete every other user/cube
            user_manager.delete_user(users[i])
            user_manager.delete_cube(cubes[i])

        # Verify deletions
        for i in range(10):
            user_active = user_manager.validate_user(users[i])
            cube = user_manager.get_cube(cubes[i])

            if i % 2 == 0:  # Deleted users/cubes
                assert user_active is False
                assert cube.is_active is False
            else:  # Active users/cubes
                assert user_active is True
                assert cube.is_active is True
