from typing import Any, ClassVar

from pydantic import BaseModel, Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseGraphDBConfig(BaseConfig):
    """Base class for all graph database configurations."""

    uri: str
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


class GraphDBConfigFactory(BaseModel):
    backend: str = Field(..., description="Backend for graph database")
    config: dict[str, Any] = Field(..., description="Configuration for the graph database backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "neo4j": Neo4jGraphDBConfig,
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
