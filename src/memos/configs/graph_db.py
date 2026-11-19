from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from memos.configs.base import BaseConfig
from memos.configs.vec_db import VectorDBConfigFactory


class BaseGraphDBConfig(BaseConfig):
    """Base class for all graph database configurations."""

    uri: str | list
    user: str
    password: str


class Neo4jGraphDBConfig(BaseGraphDBConfig):
    """
    Neo4j-specific configuration.

    This config supports:
    1) Physical isolation (multi-db) — each user gets a dedicated Neo4j database.
    2) Logical isolation (single-db) — all users share one or more databases, but each node is tagged with `user_name`.

    How to use:
    - If `use_multi_db=True`, then `db_name` should usually be the same as `user_name`.
      Each user gets a separate database for physical isolation.
      Example: db_name = "alice", user_name = None or "alice".

    - If `use_multi_db=False`, then `db_name` is your shared database (e.g., "neo4j" or "shared_db").
      You must provide `user_name` to logically isolate each user's data.
      All nodes and queries must respect this tag.

    Example configs:
    ---
    # Physical isolation:
    db_name = "alice"
    use_multi_db = True
    user_name = None

    # Logical isolation:
    db_name = "shared_db_student_group"
    use_multi_db = False
    user_name = "alice"
    """

    db_name: str = Field(..., description="The name of the target Neo4j database")
    auto_create: bool = Field(
        default=False,
        description="If True, automatically create the target db_name in multi-db mode if it does not exist.",
    )

    use_multi_db: bool = Field(
        default=True,
        description=(
            "If True: use Neo4j's multi-database feature for physical isolation; "
            "each user typically gets a separate database. "
            "If False: use a single shared database with logical isolation by user_name."
        ),
    )

    user_name: str | None = Field(
        default=None,
        description=(
            "Logical user or tenant ID for data isolation. "
            "Required if use_multi_db is False. "
            "All nodes must be tagged with this and all queries must filter by this."
        ),
    )

    embedding_dimension: int = Field(default=768, description="Dimension of vector embedding")

    @model_validator(mode="after")
    def validate_config(self):
        """Validate logical constraints to avoid misconfiguration."""
        if not self.use_multi_db and not self.user_name:
            raise ValueError(
                "In single-database mode (use_multi_db=False), `user_name` must be provided for logical isolation."
            )
        return self


class Neo4jCommunityGraphDBConfig(Neo4jGraphDBConfig):
    """
    Community edition config for Neo4j.

    Notes:
    - Must set `use_multi_db = False`
    - Must provide `user_name` for logical isolation
    - Embedding vector DB config is required
    """

    vec_config: VectorDBConfigFactory = Field(
        ..., description="Vector DB config for embedding search"
    )

    @model_validator(mode="after")
    def validate_community(self):
        if self.use_multi_db:
            raise ValueError("Neo4j Community Edition does not support use_multi_db=True.")
        if not self.user_name:
            raise ValueError("Neo4j Community config requires user_name for logical isolation.")
        return self


class PolarDBGraphDBConfig(BaseConfig):
    """
    PolarDB-specific configuration.

    Key concepts:
    - `db_name`: The name of the target PolarDB database
    - `user_name`: Used for logical tenant isolation if needed
    - `auto_create`: Whether to automatically create the target database if it does not exist
    - `use_multi_db`: Whether to use multi-database mode for physical isolation

    Example:
    ---
    host = "localhost"
    port = 5432
    user = "postgres"
    password = "password"
    db_name = "memos_db"
    user_name = "alice"
    use_multi_db = True
    auto_create = True
    """

    host: str = Field(..., description="Database host")
    port: int = Field(default=5432, description="Database port")
    user: str = Field(..., description="Database user")
    password: str = Field(..., description="Database password")
    db_name: str = Field(..., description="The name of the target PolarDB database")
    user_name: str | None = Field(
        default=None,
        description="Logical user or tenant ID for data isolation (optional, used in metadata tagging)",
    )
    auto_create: bool = Field(
        default=False,
        description="Whether to auto-create the database if it does not exist",
    )
    use_multi_db: bool = Field(
        default=True,
        description=(
            "If True: use multi-database mode for physical isolation; "
            "each tenant typically gets a separate database. "
            "If False: use a single shared database with logical isolation by user_name."
        ),
    )
    embedding_dimension: int = Field(default=1024, description="Dimension of vector embedding")
    maxconn: int = Field(
        default=100,
        description="Maximum number of connections in the connection pool",
    )
    connection_wait_timeout: int = Field(
        default=30,
        ge=1,
        le=3600,
        description="Max seconds to wait for a connection slot before raising (0 = wait forever, not recommended)",
    )
    skip_connection_health_check: bool = Field(
        default=False,
        description=(
            "If True, skip SELECT 1 health check when getting connections (~1-2ms saved per request). "
            "Use only when pool/network is reliable."
        ),
    )
    warm_up_on_startup_by_full: bool = Field(
        default=True,
        description=(
            "If True, run search_by_fulltext warm-up on pool connections at init to reduce "
            "first-query latency (~200ms planning). Requires user_name in config."
        ),
    )
    warm_up_on_startup_by_all: bool = Field(
        default=False,
        description=(
            "If True, run all connection warm-up on pool connections at init to reduce "
            "first-query latency (~200ms planning). Requires user_name in config."
        ),
    )

    @model_validator(mode="after")
    def validate_config(self):
        """Validate config."""
        if not self.db_name:
            raise ValueError("`db_name` must be provided")
        return self


class PostgresGraphDBConfig(BaseConfig):
    """
    PostgreSQL + pgvector configuration for MemOS.

    Uses standard PostgreSQL with pgvector extension for vector search.
    Does NOT require Apache AGE or other graph extensions.

    Schema:
    - {schema}_graph_{n}."Memory" and "Edges", one physical shard per tenant

    Example:
    ---
    host = "postgres"
    port = 5432
    user = "n8n"
    password = "secret"
    db_name = "n8n"
    schema_name = "memos"
    user_name = "default"
    """

    host: str = Field(..., description="Database host")
    port: int = Field(default=5432, description="Database port")
    user: str = Field(..., description="Database user")
    password: str = Field(..., description="Database password")
    db_name: str = Field(..., description="Database name")
    schema_name: str = Field(default="memos", description="Schema name for MemOS tables")
    user_name: str | None = Field(
        default=None,
        description="Logical user/tenant ID for data isolation",
    )
    use_multi_db: bool = Field(
        default=False,
        description="If False: use single database with logical isolation by user_name",
    )
    embedding_dimension: int = Field(default=1024, description="Dimension of vector embedding")
    shard_count: int = Field(
        default=400,
        ge=1,
        le=4096,
        description="Number of MD5 tenant shards",
    )
    maxconn: int = Field(
        default=20,
        description="Maximum number of connections in the connection pool",
    )
    minconn: int = Field(
        default=8,
        ge=1,
        description="Warm connections kept in the pool",
    )
    vector_index_type: Literal["hnsw", "ivfflat"] = Field(
        default="hnsw",
        description="pgvector approximate index type",
    )
    hnsw_m: int = Field(default=16, ge=2, le=100)
    hnsw_ef_construction: int = Field(default=64, ge=4, le=1000)
    ivfflat_lists: int = Field(default=100, ge=1)
    fulltext_config: str = Field(
        default="jiebacfg",
        description="PostgreSQL text search configuration used to build search_vector",
    )

    @model_validator(mode="after")
    def validate_config(self):
        """Validate config."""
        if not self.db_name:
            raise ValueError("`db_name` must be provided")
        if not self.use_multi_db and not self.user_name:
            raise ValueError("In single-database mode, `user_name` must be provided")
        if self.minconn > self.maxconn:
            raise ValueError(f"`minconn` ({self.minconn}) must be <= `maxconn` ({self.maxconn})")
        if not self.fulltext_config.replace(".", "_").isidentifier():
            raise ValueError("`fulltext_config` must be a valid PostgreSQL configuration name")
        return self


class GraphDBConfigFactory(BaseModel):
    backend: str = Field(..., description="Backend for graph database")
    config: dict[str, Any] = Field(..., description="Configuration for the graph database backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "neo4j": Neo4jGraphDBConfig,
        "neo4j-community": Neo4jCommunityGraphDBConfig,
        "polardb": PolarDBGraphDBConfig,
        "postgres": PostgresGraphDBConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        if backend not in cls.backend_to_class:
            raise ValueError(f"Unsupported graph db backend: {backend}")
        return backend

    @model_validator(mode="after")
    def instantiate_config(self):
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
