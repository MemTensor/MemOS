import json
import os
import tempfile
import time

from abc import abstractmethod
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, TypeVar

from sqlalchemy import Boolean, Column, DateTime, String, Text, and_, create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from memos.log import get_logger
from memos.mem_user.user_manager import UserManager


class DatabaseError(Exception):
    """Exception raised for database-related errors"""


T = TypeVar("T")  # The model type (MemoryMonitorManager, QueryMonitorManager, etc.)
ORM = TypeVar("ORM")  # The ORM model type

logger = get_logger(__name__)

Base = declarative_base()


class LockableORM(Base):
    """Abstract base class for lockable ORM models"""

    __abstract__ = True

    # Primary composite key
    user_id = Column(String(255), primary_key=True)
    mem_cube_id = Column(String(255), primary_key=True)

    # Serialized data
    serialized_data = Column(Text, nullable=False)

    lock_acquired = Column(Boolean, default=False)
    lock_expiry = Column(DateTime, nullable=True)

    # Version control tag (0-255, cycles back to 0)
    version_control = Column(String(3), default="0")


class BaseDBManager(UserManager):
    """Abstract base class for database managers with proper locking mechanism

    This class provides a foundation for managing database operations with
    distributed locking capabilities to ensure data consistency across
    multiple processes or threads.
    """

    def __init__(
        self,
        engine: Engine,
        user_id: str | None = None,
        mem_cube_id: str | None = None,
        lock_timeout: int = 10,
    ):
        """Initialize the database manager

        Args:
            engine: SQLAlchemy engine instance
            user_id: Unique identifier for the user
            mem_cube_id: Unique identifier for the memory cube
            lock_timeout: Timeout in seconds for lock acquisition
        """
        # Do not use super init func to avoid UserManager initialization
        self.engine = engine
        self.SessionLocal = None
        self.obj = None
        self.user_id = user_id
        self.mem_cube_id = mem_cube_id
        self.lock_timeout = lock_timeout
        self.last_version_control = None  # Track the last version control tag

        self.init_manager(
            engine=self.engine,
            user_id=self.user_id,
            mem_cube_id=self.mem_cube_id,
        )

    @property
    @abstractmethod
    def orm_class(self) -> type[LockableORM]:
        """Return the ORM model class for this manager

        Returns:
            The SQLAlchemy ORM model class
        """
        raise NotImplementedError()

    @property
    @abstractmethod
    def obj_class(self) -> Any:
        """Return the business object class for this manager

        Returns:
            The business logic object class
        """
        raise NotImplementedError()

    def init_manager(self, engine: Engine, user_id: str, mem_cube_id: str):
        """Initialize the database manager with engine and identifiers

        Args:
            engine: SQLAlchemy engine instance
            user_id: User identifier
            mem_cube_id: Memory cube identifier

        Raises:
            RuntimeError: If database initialization fails
        """
        try:
            self.SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

            logger.info(f"{self.orm_class} initialized with engine {engine}")
            logger.info(f"Set user_id to {user_id}; mem_cube_id to {mem_cube_id}")

            # Create tables if they don't exist
            self._create_table_with_error_handling(engine)
            logger.debug(f"Successfully created/verified table for {self.orm_class.__tablename__}")

        except Exception as e:
            error_msg = f"Failed to initialize database manager for {self.orm_class.__name__}: {e}"
            logger.error(error_msg, exc_info=True)
            raise RuntimeError(error_msg) from e

    def _create_table_with_error_handling(self, engine: Engine):
        """Create table with proper error handling for common database conflicts

        Args:
            engine: SQLAlchemy engine instance

        Raises:
            RuntimeError: If table creation fails after handling known issues
        """
        try:
            self.orm_class.__table__.create(bind=engine, checkfirst=True)
        except Exception as e:
            error_str = str(e).lower()

            # Handle common SQLite index already exists error
            if "index" in error_str and "already exists" in error_str:
                logger.warning(f"Index already exists for {self.orm_class.__tablename__}: {e}")
                # Try to create just the table without indexes
                try:
                    # Create a temporary table definition without indexes
                    table_without_indexes = self.orm_class.__table__.copy()
                    table_without_indexes._indexes.clear()  # Remove all indexes
                    table_without_indexes.create(bind=engine, checkfirst=True)
                    logger.info(
                        f"Created table {self.orm_class.__tablename__} without problematic indexes"
                    )
                except Exception as table_error:
                    logger.error(f"Failed to create table even without indexes: {table_error}")
                    raise
            else:
                # Re-raise other types of errors
                raise

    def _get_session(self) -> Session:
        """Get a database session"""
        return self.SessionLocal()

    def _serialize(self, obj: T) -> str:
        """Serialize the object to JSON"""
        if hasattr(obj, "to_json"):
            return obj.to_json()
        return json.dumps(obj)

    def _deserialize(self, data: str, model_class: type[T]) -> T:
        """Deserialize JSON to object"""
        if hasattr(model_class, "from_json"):
            return model_class.from_json(data)
        return json.loads(data)

    def acquire_lock(self, block: bool = True, **kwargs) -> bool:
        """Acquire a distributed lock for the current user and memory cube

        Args:
            block: Whether to block until lock is acquired
            **kwargs: Additional filter criteria

        Returns:
            True if lock was acquired, False otherwise
        """
        session = self._get_session()

        try:
            now = datetime.now()
            expiry = now + timedelta(seconds=self.lock_timeout)

            # Query for existing record with lock information
            query = (
                session.query(self.orm_class)
                .filter_by(**kwargs)
                .filter(
                    and_(
                        self.orm_class.user_id == self.user_id,
                        self.orm_class.mem_cube_id == self.mem_cube_id,
                    )
                )
            )

            record = query.first()

            # If no record exists, lock can be acquired immediately
            if record is None:
                logger.info(
                    f"No existing record found for {self.user_id}/{self.mem_cube_id}, lock can be acquired"
                )
                return True

            # Check if lock is currently held and not expired
            if record.lock_acquired and record.lock_expiry and now < record.lock_expiry:
                if block:
                    # Wait for lock to be released or expire
                    logger.info(
                        f"Waiting for lock to be released for {self.user_id}/{self.mem_cube_id}"
                    )
                    while record.lock_acquired and record.lock_expiry and now < record.lock_expiry:
                        time.sleep(0.1)  # Small delay before retry
                        session.refresh(record)  # Refresh record state
                        now = datetime.now()
                else:
                    logger.warning(
                        f"Lock is held for {self.user_id}/{self.mem_cube_id}, cannot acquire"
                    )
                    return False

            # Acquire the lock by updating the record
            query.update(
                {
                    "lock_acquired": True,
                    "lock_expiry": expiry,
                },
                synchronize_session=False,
            )

            session.commit()
            logger.info(f"Lock acquired for {self.user_id}/{self.mem_cube_id}")
            return True

        except Exception as e:
            session.rollback()
            logger.error(f"Failed to acquire lock for {self.user_id}/{self.mem_cube_id}: {e}")
            return False
        finally:
            session.close()

    def release_locks(self, user_id: str, mem_cube_id: str, **kwargs):
        """Release locks for the specified user and memory cube

        Args:
            user_id: User identifier
            mem_cube_id: Memory cube identifier
            **kwargs: Additional filter criteria
        """
        session = self._get_session()

        try:
            # Update all matching records to release locks
            result = (
                session.query(self.orm_class)
                .filter_by(**kwargs)
                .filter(
                    and_(
                        self.orm_class.user_id == user_id, self.orm_class.mem_cube_id == mem_cube_id
                    )
                )
                .update(
                    {
                        "lock_acquired": False,
                        "lock_expiry": None,  # Clear expiry time as well
                    },
                    synchronize_session=False,
                )
            )
            session.commit()
            logger.info(f"Lock released for {user_id}/{mem_cube_id} (affected {result} records)")

        except Exception as e:
            session.rollback()
            logger.error(f"Failed to release lock for {user_id}/{mem_cube_id}: {e}")
        finally:
            session.close()

    def _get_primary_key(self) -> dict[str, Any]:
        """Get the primary key dictionary for the current instance

        Returns:
            Dictionary containing user_id and mem_cube_id
        """
        return {"user_id": self.user_id, "mem_cube_id": self.mem_cube_id}

    def _increment_version_control(self, current_tag: str) -> str:
        """Increment the version control tag, cycling from 255 back to 0

        Args:
            current_tag: Current version control tag as string

        Returns:
            Next version control tag as string
        """
        try:
            current_value = int(current_tag)
            next_value = (current_value + 1) % 256  # Cycle from 255 back to 0
            return str(next_value)
        except (ValueError, TypeError):
            # If current_tag is invalid, start from 0
            logger.warning(f"Invalid version_control '{current_tag}', resetting to '0'")
            return "0"

    @abstractmethod
    def merge_items(self, orm_instance, obj_instance, size_limit):
        """Merge items from database with current object instance

        Args:
            orm_instance: ORM instance from database
            obj_instance: Current business object instance
            size_limit: Maximum number of items to keep after merge
        """

    def sync_with_orm(self, size_limit: int | None = None) -> None:
        """
        Synchronize data between the database and the business object.

        This method performs a three-step synchronization process:
        1. Acquire lock and get existing data from database
        2. Merge database items with current object items
        3. Write merged data back to database and release lock

        Args:
            size_limit: Optional maximum number of items to keep after synchronization.
                       If specified, only the most recent items will be retained.
        """
        logger.info(
            f"Starting sync_with_orm for {self.user_id}/{self.mem_cube_id} with size_limit={size_limit}"
        )
        user_id = self.user_id
        mem_cube_id = self.mem_cube_id

        session = self._get_session()

        try:
            # Acquire lock before any database operations
            lock_status = self.acquire_lock(block=True)
            if not lock_status:
                logger.error("Failed to acquire lock for synchronization")
                return

            # 1. Get existing data from database
            orm_instance = (
                session.query(self.orm_class)
                .filter_by(user_id=user_id, mem_cube_id=mem_cube_id)
                .first()
            )

            # If no existing record, create a new one
            if orm_instance is None:
                if self.obj is None:
                    logger.warning("No object to synchronize and no existing database record")
                    return

                orm_instance = self.orm_class(
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    serialized_data=self.obj.to_json(),
                    version_control="0",  # Start with tag 0 for new records
                )
                logger.info(
                    "No existing ORM instance found. Created a new one. "
                    "Note: size_limit was not applied because there is no existing data to merge."
                )
                session.add(orm_instance)
                session.commit()
                # Update last_version_control for new record
                self.last_version_control = "0"
                return

            # 2. Check version control and merge data from database with current object
            if self.obj is not None:
                current_db_tag = orm_instance.version_control
                new_tag = self._increment_version_control(current_db_tag)
                # Check if this is the first sync (last_version_control is None)
                if self.last_version_control is None:
                    # First sync, increment version and perform merge
                    logger.info(
                        f"First sync, incrementing version from {current_db_tag} to {new_tag} for {self.user_id}/{self.mem_cube_id}"
                    )
                elif current_db_tag == self.last_version_control:
                    logger.info(
                        f"Version control unchanged ({current_db_tag}), directly update {self.user_id}/{self.mem_cube_id}"
                    )
                else:
                    # Version control has changed, increment it and perform merge
                    logger.info(
                        f"Version control changed from {self.last_version_control} to {current_db_tag}, incrementing to {new_tag} for {self.user_id}/{self.mem_cube_id}"
                    )
                    try:
                        self.merge_items(
                            orm_instance=orm_instance, obj_instance=self.obj, size_limit=size_limit
                        )
                    except Exception as merge_error:
                        logger.error(f"Error during merge_items: {merge_error}", exc_info=True)
                        logger.warning("Continuing with current object data without merge")

                # 3. Write merged data back to database
                orm_instance.serialized_data = self.obj.to_json()
                orm_instance.version_control = new_tag
                logger.info(f"Updated serialized_data for {self.user_id}/{self.mem_cube_id}")

                # Update last_version_control to current value
                self.last_version_control = orm_instance.version_control
            else:
                logger.warning("No current object to merge with database data")

            session.commit()
            logger.info(f"Synchronization completed for {self.user_id}/{self.mem_cube_id}")

        except Exception as e:
            session.rollback()
            logger.error(
                f"Error during synchronization for {user_id}/{mem_cube_id}: {e}", exc_info=True
            )
        finally:
            # Always release locks and close session
            self.release_locks(user_id=user_id, mem_cube_id=mem_cube_id)
            session.close()

    def save_to_db(self, obj_instance) -> None:
        """Save the current state of the business object to the database

        Args:
            obj_instance: The business object instance to save
        """
        user_id = self.user_id
        mem_cube_id = self.mem_cube_id

        session = self._get_session()

        try:
            # Acquire lock before database operations
            lock_status = self.acquire_lock(block=True)
            if not lock_status:
                logger.error("Failed to acquire lock for saving to database")
                return

            # Check if record already exists
            orm_instance = (
                session.query(self.orm_class)
                .filter_by(user_id=user_id, mem_cube_id=mem_cube_id)
                .first()
            )

            if orm_instance is None:
                # Create new record
                orm_instance = self.orm_class(
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    serialized_data=obj_instance.to_json(),
                    version_control="0",  # Start with version 0 for new records
                )
                session.add(orm_instance)
                logger.info(f"Created new database record for {user_id}/{mem_cube_id}")
                # Update last_version_control for new record
                self.last_version_control = "0"
            else:
                # Update existing record with version control
                current_version = orm_instance.version_control
                new_version = self._increment_version_control(current_version)
                orm_instance.serialized_data = obj_instance.to_json()
                orm_instance.version_control = new_version
                logger.info(
                    f"Updated existing database record for {user_id}/{mem_cube_id} with version {new_version}"
                )
                # Update last_version_control
                self.last_version_control = new_version

            session.commit()

        except Exception as e:
            session.rollback()
            logger.error(f"Error saving to database for {user_id}/{mem_cube_id}: {e}")
        finally:
            # Always release locks and close session
            self.release_locks(user_id=user_id, mem_cube_id=mem_cube_id)
            session.close()

    def load_from_db(self, acquire_lock: bool = False):
        """Load the business object from the database

        Args:
            acquire_lock: Whether to acquire a lock during the load operation

        Returns:
            The deserialized business object instance, or None if not found
        """
        user_id = self.user_id
        mem_cube_id = self.mem_cube_id

        session = self._get_session()

        try:
            if acquire_lock:
                lock_status = self.acquire_lock(block=True)
                if not lock_status:
                    logger.error("Failed to acquire lock for loading from database")
                    return None

            # Query for the database record
            orm_instance = (
                session.query(self.orm_class)
                .filter_by(user_id=user_id, mem_cube_id=mem_cube_id)
                .first()
            )

            if orm_instance is None:
                logger.info(f"No database record found for {user_id}/{mem_cube_id}")
                return None

            # Deserialize the business object from JSON
            db_instance = self.obj_class.from_json(orm_instance.serialized_data)
            # Update last_version_control to track the loaded version
            self.last_version_control = orm_instance.version_control
            logger.info(
                f"Successfully loaded object from database for {user_id}/{mem_cube_id} with version {orm_instance.version_control}"
            )

            return db_instance

        except Exception as e:
            logger.error(f"Error loading from database for {user_id}/{mem_cube_id}: {e}")
            return None
        finally:
            if acquire_lock:
                self.release_locks(user_id=user_id, mem_cube_id=mem_cube_id)
            session.close()

    def close(self):
        """Close the database manager and clean up resources

        This method releases any held locks and disposes of the database engine.
        Should be called when the manager is no longer needed.
        """
        try:
            # Release any locks held by this manager instance
            if self.user_id and self.mem_cube_id:
                self.release_locks(user_id=self.user_id, mem_cube_id=self.mem_cube_id)
                logger.info(f"Released locks for {self.user_id}/{self.mem_cube_id}")

            # Dispose of the engine to close all connections
            if self.engine:
                self.engine.dispose()
                logger.info("Database engine disposed")

        except Exception as e:
            logger.error(f"Error during close operation: {e}")

    @staticmethod
    def create_default_sqlite_engine() -> Engine:
        """Create SQLAlchemy engine with default database path

        Returns:
            SQLAlchemy Engine instance using default scheduler_orm.db
        """
        temp_dir = tempfile.mkdtemp()
        db_path = os.path.join(temp_dir, "test_scheduler_orm.db")

        # Clean up any existing file (though unlikely)
        if os.path.exists(db_path):
            os.remove(db_path)
        # Remove the temp directory if still exists (should be empty)
        if os.path.exists(temp_dir) and not os.listdir(temp_dir):
            os.rmdir(temp_dir)

        # Ensure parent directory exists (re-create in case rmdir removed it)
        parent_dir = Path(db_path).parent
        parent_dir.mkdir(parents=True, exist_ok=True)

        # Log the creation of the default engine with database path
        logger.info(
            "Creating default SQLAlchemy engine with temporary SQLite database at: %s", db_path
        )

        return create_engine(f"sqlite:///{db_path}", echo=False)

    @staticmethod
    def create_engine_from_db_path(db_path: str) -> Engine:
        """Create SQLAlchemy engine from database path

        Args:
            db_path: Path to database file

        Returns:
            SQLAlchemy Engine instance
        """
        # Ensure the directory exists
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        return create_engine(f"sqlite:///{db_path}", echo=False)

    @staticmethod
    def create_mysql_db_path(
        host: str = "localhost",
        port: int = 3306,
        username: str = "root",
        password: str = "",
        database: str = "scheduler_orm",
        charset: str = "utf8mb4",
    ) -> str:
        """Create MySQL database connection URL

        Args:
            host: MySQL server hostname
            port: MySQL server port
            username: Database username
            password: Database password (optional)
            database: Database name
            charset: Character set encoding

        Returns:
            MySQL connection URL string
        """
        # Build MySQL connection URL with proper formatting
        if password:
            db_path = (
                f"mysql+pymysql://{username}:{password}@{host}:{port}/{database}?charset={charset}"
            )
        else:
            db_path = f"mysql+pymysql://{username}@{host}:{port}/{database}?charset={charset}"
        return db_path

    @staticmethod
    def load_mysql_engine_from_env(env_file_path: str | None = None) -> Engine | None:
        """Load MySQL engine from environment variables

        Args:
            env_file_path: Path to .env file (optional, defaults to loading from current environment)

        Returns:
            SQLAlchemy Engine instance configured for MySQL

        Raises:
            DatabaseError: If required environment variables are missing or connection fails
        """
        # Load environment variables from file if provided
        if env_file_path:
            if os.path.exists(env_file_path):
                from dotenv import load_dotenv

                load_dotenv(env_file_path)
                logger.info(f"Loaded environment variables from {env_file_path}")
            else:
                logger.warning(
                    f"Environment file not found: {env_file_path}, using current environment variables"
                )
        else:
            logger.info("Using current environment variables (no env_file_path provided)")

        # Get MySQL configuration from environment variables
        mysql_host = os.getenv("MYSQL_HOST")
        mysql_port_str = os.getenv("MYSQL_PORT")
        mysql_username = os.getenv("MYSQL_USERNAME")
        mysql_password = os.getenv("MYSQL_PASSWORD")
        mysql_database = os.getenv("MYSQL_DATABASE")
        mysql_charset = os.getenv("MYSQL_CHARSET")

        # Check required environment variables
        required_vars = {
            "MYSQL_HOST": mysql_host,
            "MYSQL_USERNAME": mysql_username,
            "MYSQL_PASSWORD": mysql_password,
            "MYSQL_DATABASE": mysql_database,
        }

        missing_vars = [var for var, value in required_vars.items() if not value]
        if missing_vars:
            error_msg = f"Missing required MySQL environment variables: {', '.join(missing_vars)}"
            logger.error(error_msg)
            return None

        # Parse port with validation
        try:
            mysql_port = int(mysql_port_str) if mysql_port_str else 3306
        except ValueError:
            error_msg = f"Invalid MYSQL_PORT value: {mysql_port_str}. Must be a valid integer."
            logger.error(error_msg)
            return None

        # Set default charset if not provided
        if not mysql_charset:
            mysql_charset = "utf8mb4"

        # Create MySQL connection URL
        db_url = BaseDBManager.create_mysql_db_path(
            host=mysql_host,
            port=mysql_port,
            username=mysql_username,
            password=mysql_password,
            database=mysql_database,
            charset=mysql_charset,
        )

        try:
            # Create and test the engine
            engine = create_engine(db_url, echo=False)

            # Test connection
            with engine.connect() as conn:
                from sqlalchemy import text

                conn.execute(text("SELECT 1"))

            logger.info(
                f"Successfully created MySQL engine: {mysql_host}:{mysql_port}/{mysql_database}"
            )
            return engine

        except Exception as e:
            error_msg = f"Failed to create MySQL engine from environment variables: {e}"
            logger.error(error_msg)
            raise DatabaseError(error_msg) from e
