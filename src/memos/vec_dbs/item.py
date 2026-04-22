"""Defines vector database item types."""

import uuid

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class VecDBItem(BaseModel):
    """Represents a single item in the vector database.

    This serves as a standardized format for vector database items across different
    vector database implementations (Qdrant, FAISS, Weaviate, etc.).
    """

    id: str = Field(default=str(uuid.uuid4()), description="Unique identifier for the item")
    vector: list[float] | None = Field(default=None, description="Embedding vector")
    payload: dict[str, Any] | None = Field(
        default=None, description="Additional payload for filtering/retrieval"
    )
    score: float | None = Field(
        default=None, description="Similarity score (used in search results)"
    )

    model_config = ConfigDict(extra="forbid")

    @field_validator("id")
    @classmethod
    def validate_id(cls, v):
        """Validate that ID is a valid UUID."""
        if not isinstance(v, str) or not uuid.UUID(v, version=4):
            raise ValueError("ID must be a valid UUID string")
        return v

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "VecDBItem":
        """Create VecDBItem from dictionary."""
        return cls(**data)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary format."""
        return self.model_dump(exclude_none=True)


class MilvusVecDBItem(VecDBItem):
    """Represents a single item in the Milvus vector database."""

    memory: str | None = Field(default=None, description="Memory string")
    original_text: str | None = Field(default=None, description="Original text content")
