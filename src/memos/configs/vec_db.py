from typing import Any, ClassVar, Literal

from pydantic import Field, field_validator, model_validator

from memos import settings
from memos.configs.base import BaseConfig
from memos.log import get_logger


logger = get_logger(__name__)


class BaseVecDBConfig(BaseConfig):
    """Base class for all vector database configurations."""

    collection_name: str = Field(..., description="Name of the collection")
    vector_dimension: int | None = Field(default=None, description="Dimension of the vectors")
    distance_metric: Literal["cosine", "euclidean", "dot"] | None = Field(
        default=None,
        description="Distance metric for vector similarity calculation. Options: 'cosine', 'euclidean', 'dot'",
    )


class QdrantVecDBConfig(BaseVecDBConfig):
    """Configuration for Qdrant vector database."""

    host: str | None = Field(default=None, description="Host for Qdrant")
    port: int | None = Field(default=None, description="Port for Qdrant")
    path: str | None = Field(default=None, description="Path for Qdrant")
    url: str | None = Field(default=None, description="Qdrant Cloud/remote endpoint URL")
    api_key: str | None = Field(default=None, description="Qdrant Cloud API key")

    @model_validator(mode="after")
    def set_default_path(self):
        # Only fall back to embedded/local path when no remote host/port/path/url is provided.
        if all(x is None for x in (self.host, self.port, self.path, self.url)):
            logger.warning(
                "No host, port, or path provided for Qdrant. Defaulting to local path: %s",
                settings.MEMOS_DIR / "qdrant",
            )
            self.path = str(settings.MEMOS_DIR / "qdrant")
        return self


class MilvusVecDBConfig(BaseVecDBConfig):
    """Configuration for Milvus vector database."""

    uri: str = Field(..., description="URI for Milvus connection")
    collection_name: list[str] = Field(..., description="Name(s) of the collection(s)")
    max_length: int = Field(
        default=65535, description="Maximum length for string fields (varChar type)"
    )
    user_name: str = Field(default="", description="User name for Milvus connection")
    password: str = Field(default="", description="Password for Milvus connection")


class VectorDBConfigFactory(BaseConfig):
    """Factory class for creating vector database configurations."""

    backend: str = Field(..., description="Backend for vector database")
    config: dict[str, Any] = Field(..., description="Configuration for the vector database backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "qdrant": QdrantVecDBConfig,
        "milvus": MilvusVecDBConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid vector database backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "VectorDBConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
