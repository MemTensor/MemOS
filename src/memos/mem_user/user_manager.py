"""User management system for MemOS.

This module provides user authentication, authorization, and cube management
functionality using SQLAlchemy and SQLite.
"""

import uuid

from datetime import datetime
from enum import Enum
from pathlib import Path

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    String,
    Table,
    create_engine,
)
from sqlalchemy import (
    Enum as SQLEnum,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, declarative_base, relationship, sessionmaker

from memos import settings
from memos.log import get_logger


logger = get_logger(__name__)

Base = declarative_base()


class UserRole(Enum):
    """User roles enumeration."""

    ROOT = "root"
    ADMIN = "admin"
    USER = "user"
    GUEST = "guest"


# Association table for many-to-many relationship between users and cubes
user_cube_association = Table(
    "user_cube_association",
    Base.metadata,
    Column("user_id", String, ForeignKey("users.user_id"), primary_key=True),
    Column("cube_id", String, ForeignKey("cubes.cube_id"), primary_key=True),
    Column("created_at", DateTime, default=datetime.now),
)


class User(Base):
    """User model for the database."""

    __tablename__ = "users"

    user_id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_name = Column(String, unique=True, nullable=False)
    role = Column(SQLEnum(UserRole), default=UserRole.USER, nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)

    # Relationship with cubes
    cubes = relationship("Cube", secondary=user_cube_association, back_populates="users")
    owned_cubes = relationship("Cube", back_populates="owner", cascade="all, delete-orphan")

    def __repr__(self):
        return f"<User(user_id='{self.user_id}', user_name='{self.user_name}', role='{self.role.value}')>"


class Cube(Base):
    """Cube model for the database."""

    __tablename__ = "cubes"

    cube_id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    cube_name = Column(String, nullable=False)
    cube_path = Column(String, nullable=True)  # Local path or remote repo
    owner_id = Column(String, ForeignKey("users.user_id"), nullable=False)
    created_at = Column(DateTime, default=datetime.now, nullable=False)
    updated_at = Column(DateTime, default=datetime.now, onupdate=datetime.now, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)

    # Relationships
    owner = relationship("User", back_populates="owned_cubes")
    users = relationship("User", secondary=user_cube_association, back_populates="cubes")

    def __repr__(self):
        return f"<Cube(cube_id='{self.cube_id}', cube_name='{self.cube_name}', owner_id='{self.owner_id}')>"


class UserManager:
    """User management system for MemOS."""

    def __init__(self, db_path: str | None = None, user_id: str = "root"):
        """Initialize the user manager with database connection.

        Args:
            db_path (str, optional): Path to the SQLite database file.
                If None, uses default path in MEMOS_DIR.
            user_id (str, optional): User ID. If None, uses default user ID.
        """
        if db_path is None:
            db_path = str(settings.MEMOS_DIR / "memos_users.db")

        # Ensure the directory exists
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        self.db_path = db_path
        self.engine = create_engine(f"sqlite:///{db_path}", echo=False)
        self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=self.engine)

        # Create tables
        Base.metadata.create_all(bind=self.engine)

        # Initialize with root user if no users exist
        self._init_root_user(user_id)

        logger.info(f"UserManager initialized with database at {db_path}")

    def _get_session(self) -> Session:
        """Get a database session."""
        return self.SessionLocal()

    def _init_root_user(self, user_id: str) -> None:
        """Initialize the root user if no users exist."""
        session = self._get_session()
        try:
            # Check if any users exist
            user_count = session.query(User).count()
            if user_count == 0:
                root_user = User(user_id=user_id, user_name=user_id, role=UserRole.ROOT)
                session.add(root_user)
                session.commit()
                logger.info("Root user created successfully")
            else:
                self.create_user(user_name=user_id, user_id=user_id, role=UserRole.ROOT)
        except Exception as e:
            session.rollback()
            logger.error(f"Failed to create {user_id} user: {e}")
        finally:
            session.close()

    def create_user(
        self, user_name: str, role: UserRole = UserRole.USER, user_id: str | None = None
    ) -> str:
        """Create a new user.

        Args:
            user_name (str): Name of the user.
            role (UserRole): Role of the user.
            user_id (str, optional): Custom user ID. If None, generates UUID.

        Returns:
            str: The created user ID.

        Raises:
            ValueError: If user_name already exists.
        """
        session = self._get_session()
        try:
            # Check if user_name already exists
            existing_user = session.query(User).filter(User.user_name == user_name).first()
            if existing_user:
                logger.info(f"User with name '{user_name}' already exists")
                return existing_user.user_id
            user = User(user_name=user_name, role=role, user_id=user_id or str(uuid.uuid4()))
            session.add(user)
            session.commit()
            logger.info(f"User '{user_name}' created with ID: {user.user_id}")
            return user.user_id
        except IntegrityError:
            session.rollback()
            logger.info(f"failed to create user with name '{user_name}' already exists")
        except Exception as e:
            session.rollback()
            logger.error(f"Error creating user: {e}")
            raise
        finally:
            session.close()

    def get_user(self, user_id: str) -> User | None:
        """Get user by ID.

        Args:
            user_id (str): The user ID.

        Returns:
            User: The user object or None if not found.
        """
        session = self._get_session()
        try:
            return session.query(User).filter(User.user_id == user_id).first()
        finally:
            session.close()

    def get_user_by_name(self, user_name: str) -> User | None:
        """Get user by name.

        Args:
            user_name (str): The user name.

        Returns:
            User: The user object or None if not found.
        """
        session = self._get_session()
        try:
            return session.query(User).filter(User.user_name == user_name).first()
        finally:
            session.close()

    def validate_user(self, user_id: str) -> bool:
        """Validate if a user exists and is active.

        Args:
            user_id (str): The user ID to validate.

        Returns:
            bool: True if user exists and is active, False otherwise.
        """
        user = self.get_user(user_id)
        return user is not None and user.is_active

    def list_users(self) -> list[User]:
        """List all active users.

        Returns:
            list[User]: List of all active users.
        """
        session = self._get_session()
        try:
            return session.query(User).filter(User.is_active).all()
        finally:
            session.close()

    def create_cube(
        self,
        cube_name: str,
        owner_id: str,
        cube_path: str | None = None,
        cube_id: str | None = None,
    ) -> str:
        """Create a new cube.

        Args:
            cube_name (str): Name of the cube.
            owner_id (str): ID of the cube owner.
            cube_path (str, optional): Path to the cube.
            cube_id (str, optional): Custom cube ID. If None, generates UUID.

        Returns:
            str: The created cube ID.

        Raises:
            ValueError: If owner doesn't exist.
        """
        session = self._get_session()
        try:
            # Validate owner exists
            owner = session.query(User).filter(User.user_id == owner_id).first()
            if not owner:
                raise ValueError(f"User with ID '{owner_id}' does not exist")

            cube = Cube(
                cube_name=cube_name,
                owner_id=owner_id,
                cube_path=cube_path,
                cube_id=cube_id or str(uuid.uuid4()),
            )
            session.add(cube)

            # Add owner to cube users
            cube.users.append(owner)

            session.commit()
            logger.info(f"Cube '{cube_name}' created with ID: {cube.cube_id}")
            return cube.cube_id
        except Exception as e:
            session.rollback()
            logger.error(f"Error creating cube: {e}")
            raise
        finally:
            session.close()

    def get_cube(self, cube_id: str) -> Cube | None:
        """Get cube by ID.

        Args:
            cube_id (str): The cube ID.

        Returns:
            Cube: The cube object or None if not found.
        """
        session = self._get_session()
        try:
            return session.query(Cube).filter(Cube.cube_id == cube_id).first()
        finally:
            session.close()

    def validate_user_cube_access(self, user_id: str, cube_id: str) -> bool:
        """Validate if a user has access to a cube.

        Args:
            user_id (str): The user ID.
            cube_id (str): The cube ID.

        Returns:
            bool: True if user has access to cube, False otherwise.
        """
        session = self._get_session()
        try:
            # Check if user exists and is active
            user = session.query(User).filter(User.user_id == user_id, User.is_active).first()
            if not user:
                return False

            # Check if cube exists and is active
            cube = session.query(Cube).filter(Cube.cube_id == cube_id, Cube.is_active).first()
            if not cube:
                return False

            # Check if user has access to cube (owner or in users list)
            if cube.owner_id == user_id:
                return True

            # Check many-to-many relationship
            return user in cube.users
        finally:
            session.close()

    def get_user_cubes(self, user_id: str) -> list[Cube]:
        """Get all cubes accessible by a user.

        Args:
            user_id (str): The user ID.

        Returns:
            list[Cube]: List of cubes accessible by the user.
        """
        session = self._get_session()
        try:
            user = session.query(User).filter(User.user_id == user_id).first()
            if not user:
                return []

            active_cubes = [cube for cube in user.cubes if cube.is_active]
            return sorted(active_cubes, key=lambda cube: cube.created_at, reverse=True)
        finally:
            session.close()

    def add_user_to_cube(self, user_id: str, cube_id: str) -> bool:
        """Add a user to a cube's access list.

        Args:
            user_id (str): The user ID.
            cube_id (str): The cube ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        session = self._get_session()
        try:
            user = session.query(User).filter(User.user_id == user_id).first()
            cube = session.query(Cube).filter(Cube.cube_id == cube_id).first()

            if not user or not cube:
                return False

            if user not in cube.users:
                cube.users.append(user)
                session.commit()
                logger.info(f"User '{user_id}' added to cube '{cube_id}'")

            return True
        except Exception as e:
            session.rollback()
            logger.error(f"Error adding user to cube: {e}")
            return False
        finally:
            session.close()

    def remove_user_from_cube(self, user_id: str, cube_id: str) -> bool:
        """Remove a user from a cube's access list.

        Args:
            user_id (str): The user ID.
            cube_id (str): The cube ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        session = self._get_session()
        try:
            user = session.query(User).filter(User.user_id == user_id).first()
            cube = session.query(Cube).filter(Cube.cube_id == cube_id).first()

            if not user or not cube:
                return False

            # Don't remove owner
            if cube.owner_id == user_id:
                logger.warning(f"Cannot remove owner '{user_id}' from cube '{cube_id}'")
                return False

            if user in cube.users:
                cube.users.remove(user)
                session.commit()
                logger.info(f"User '{user_id}' removed from cube '{cube_id}'")

            return True
        except Exception as e:
            session.rollback()
            logger.error(f"Error removing user from cube: {e}")
            return False
        finally:
            session.close()

    def delete_user(self, user_id: str) -> bool:
        """Soft delete a user (set is_active to False).

        Args:
            user_id (str): The user ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        session = self._get_session()
        try:
            user = session.query(User).filter(User.user_id == user_id).first()
            if not user:
                return False

            # Don't delete root user
            if user.role == UserRole.ROOT:
                logger.warning("Cannot delete root user")
                return False

            user.is_active = False
            session.commit()
            logger.info(f"User '{user_id}' deactivated")
            return True
        except Exception as e:
            session.rollback()
            logger.error(f"Error deleting user: {e}")
            return False
        finally:
            session.close()

    def delete_cube(self, cube_id: str) -> bool:
        """Soft delete a cube (set is_active to False).

        Args:
            cube_id (str): The cube ID.

        Returns:
            bool: True if successful, False otherwise.
        """
        session = self._get_session()
        try:
            cube = session.query(Cube).filter(Cube.cube_id == cube_id).first()
            if not cube:
                return False

            cube.is_active = False
            session.commit()
            logger.info(f"Cube '{cube_id}' deactivated")
            return True
        except Exception as e:
            session.rollback()
            logger.error(f"Error deleting cube: {e}")
            return False
        finally:
            session.close()

    def close(self) -> None:
        """Close the database engine and dispose of all connections.

        This method should be called when the UserManager is no longer needed
        to ensure proper cleanup of database connections.
        """
        if hasattr(self, "engine"):
            self.engine.dispose()
            logger.info("UserManager database connections closed")
