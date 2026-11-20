from typing import Any, ClassVar, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class PostgresProjectDBConfig(BaseConfig):
    """PostgreSQL + pgvector configuration for project memory storage.

    Tables live in the fixed schema ``project_memory`` (see sql/postgres_init.sql).
    """

    host: str = Field(..., description="Database host")
    port: int = Field(default=5432, description="Database port")
    user: str = Field(..., description="Database user")
    password: str = Field(..., description="Database password")
    db_name: str = Field(..., description="Database name")
    minconn: int = Field(default=1, ge=1, description="Minimum pooled connections")
    maxconn: int = Field(default=10, ge=1, description="Maximum pooled connections")
    embedding_dimension: int = Field(
        default=1024, ge=1, le=16000, description="Dimension of vector embedding"
    )
    text_search_parser: Literal["zhparser", "simple"] = Field(
        default="zhparser",
        description="Parser behind project_memory.zh; simple is for local tests without zhparser",
    )
    auto_init: bool = Field(
        default=True, description="Create schema and tables on startup if missing"
    )

    @model_validator(mode="after")
    def validate_pool(self):
        if self.minconn > self.maxconn:
            raise ValueError("minconn must be <= maxconn")
        return self


class ProjectDBConfigFactory(BaseModel):
    backend: str = Field(..., description="Backend for project memory database")
    config: dict[str, Any] = Field(..., description="Configuration for the backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "postgres": PostgresProjectDBConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        if backend not in cls.backend_to_class:
            raise ValueError(f"Unsupported project db backend: {backend}")
        return backend

    @model_validator(mode="after")
    def instantiate_config(self):
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
