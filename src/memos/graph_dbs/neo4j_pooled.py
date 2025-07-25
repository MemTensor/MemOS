"""Neo4j GraphDB implementation with connection pooling."""

from memos.configs.graph_db import Neo4jGraphDBConfig
from memos.dependency import require_python_package
from memos.graph_dbs.connection_pool import connection_pool
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.log import get_logger


logger = get_logger(__name__)


class Neo4jPooledGraphDB(Neo4jGraphDB):
    """Neo4j-based implementation with connection pooling to reduce connection overhead."""

    @require_python_package(
        import_name="neo4j",
        install_command="pip install neo4j",
        install_link="https://neo4j.com/docs/python-manual/current/install/",
    )
    def __init__(self, config: Neo4jGraphDBConfig):
        """Neo4j-based implementation with connection pooling.

        This implementation uses a shared connection pool to reuse database connections
        across multiple instances, reducing the overhead of creating new connections
        for each user.

        Tenant Modes:
        - use_multi_db = True:
            Dedicated Database Mode (Multi-Database Multi-Tenant).
            Each tenant or logical scope uses a separate Neo4j database.
            `db_name` is the specific tenant database.
            `user_name` can be None (optional).

        - use_multi_db = False:
            Shared Database Multi-Tenant Mode.
            All tenants share a single Neo4j database.
            `db_name` is the shared database.
            `user_name` is required to isolate each tenant's data at the node level.
            All node queries will enforce `user_name` in WHERE conditions and store it in metadata,
            but it will be removed automatically before returning to external consumers.
        """
        self.config = config

        # Use connection pool instead of creating new driver
        self.driver = connection_pool.get_driver(config.uri, config.user, config.password)
        self.db_name = config.db_name
        self.user_name = config.user_name

        self.system_db_name = "system" if config.use_multi_db else config.db_name
        if config.auto_create:
            self._ensure_database_exists()

        # Create only if not exists
        self.create_index(dimensions=config.embedding_dimension)

        logger.debug(
            f"Neo4jPooledGraphDB initialized for {config.uri}:{config.user}, "
            f"total active connections: {connection_pool.get_active_connections()}"
        )
