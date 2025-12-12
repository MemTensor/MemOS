from typing import Any, ClassVar

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


class NebulaGraphDBConfig(BaseGraphDBConfig):
    """
    NebulaGraph-specific configuration.

    Key concepts:
    - `space`: Equivalent to a database or namespace. All tag/edge/schema live within a space.
    - `user_name`: Used for logical tenant isolation if needed.
    - `auto_create`: Whether to automatically create the target space if it does not exist.

    Example:
    ---
    hosts = ["127.0.0.1:9669"]
    user = "root"
    password = "nebula"
    space = "shared_graph"
    user_name = "alice"
    """

    space: str = Field(
        ..., description="The name of the target NebulaGraph space (like a database)"
    )
    user_name: str | None = Field(
        default=None,
        description="Logical user or tenant ID for data isolation (optional, used in metadata tagging)",
    )
    auto_create: bool = Field(
        default=False,
        description="Whether to auto-create the space if it does not exist",
    )
    use_multi_db: bool = Field(
        default=True,
        description=(
            "If True: use Neo4j's multi-database feature for physical isolation; "
            "each user typically gets a separate database. "
            "If False: use a single shared database with logical isolation by user_name."
        ),
    )
    max_client: int = Field(
        default=1000,
        description=("max_client"),
    )
    embedding_dimension: int = Field(default=3072, description="Dimension of vector embedding")

    @model_validator(mode="after")
    def validate_config(self):
        """Validate config."""
        if not self.space:
            raise ValueError("`space` must be provided")
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

    @model_validator(mode="after")
    def validate_config(self):
        """Validate config."""
        if not self.db_name:
            raise ValueError("`db_name` must be provided")
        return self


class GraphDBConfigFactory(BaseModel):
    backend: str = Field(..., description="Backend for graph database")
    config: dict[str, Any] = Field(..., description="Configuration for the graph database backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "neo4j": Neo4jGraphDBConfig,
        "neo4j-community": Neo4jCommunityGraphDBConfig,
        "nebular": NebulaGraphDBConfig,
        "polardb": PolarDBGraphDBConfig,
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
