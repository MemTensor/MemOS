"""Defines memory item types for textual memory."""

import uuid

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TextualMemoryMetadata(BaseModel):
    """Metadata for a memory item.

    This includes information such as the type of memory, when it occurred,
    its source, and other relevant details.
    """

    user_id: str | None = Field(
        default=None,
        description="The ID of the user associated with the memory. Useful for multi-user systems.",
    )
    session_id: str | None = Field(
        default=None,
        description="The ID of the session during which the memory was created. Useful for tracking context in conversations.",
    )
    status: Literal["activated", "archived", "deleted"] | None = Field(
        default="activated",
        description="The status of the memory, e.g., 'activated', 'archived', 'deleted'.",
    )
    title: str | None = Field(default=None)
    confidence: float | None = Field(
        default=None,
        description="A numeric score (float between 0 and 100) indicating how certain you are about the accuracy or reliability of the memory.",
    )
    source: Literal["conversation", "retrieved", "web", "file"] | None = Field(
        default=None, description="The origin of the memory"
    )
    tags: list[str] | None = Field(
        default=None,
        description='A list of keywords or thematic labels associated with the memory for categorization or retrieval, e.g., `["travel", "health", "project-x"]`.',
    )
    updated_at: str | None = Field(
        default_factory=lambda: datetime.now().isoformat(),
        description="The timestamp of the last modification to the memory. Useful for tracking memory freshness or change history. Format: ISO 8601.",
    )

    model_config = ConfigDict(extra="allow")

    def __str__(self) -> str:
        """Pretty string representation of the metadata."""
        meta = self.model_dump(exclude_none=True)
        return ", ".join(f"{k}={v}" for k, v in meta.items())


class TreeNodeTextualMemoryMetadata(TextualMemoryMetadata):
    """Extended metadata for structured memory, layered retrieval, and lifecycle tracking."""

    memory_type: Literal["WorkingMemory", "LongTermMemory", "UserMemory"] = Field(
        default="WorkingMemory", description="Memory lifecycle type."
    )
    key: str | None = Field(default=None, description="Memory key or title.")
    sources: list[str] | None = Field(
        default=None, description="Multiple origins of the memory (e.g., URLs, notes)."
    )
    embedding: list[float] | None = Field(
        default=None,
        description="The vector embedding of the memory content, used for semantic search or clustering.",
    )
    created_at: str | None = Field(
        default_factory=lambda: datetime.now().isoformat(),
        description="The timestamp of the first creation to the memory. Useful "
        "for tracking memory initialization. Format: ISO 8601.",
    )
    usage: list[str] | None = Field(
        default=[],
        description="Usage history of this node",
    )
    background: str | None = Field(
        default="",
        description="background of this node",
    )

    @field_validator("sources")
    @classmethod
    def validate_sources(cls, v):
        if v is not None and not isinstance(v, list):
            raise ValueError("Sources must be a list of strings.")
        return v

    def __str__(self) -> str:
        """Pretty string representation of the metadata."""
        meta = self.model_dump(exclude_none=True)
        return ", ".join([f"{k}={v}" for k, v in meta.items() if k != "embedding"])


class SearchedTreeNodeTextualMemoryMetadata(TreeNodeTextualMemoryMetadata):
    """Metadata for nodes returned by search, includes similarity info."""

    relativity: float | None = Field(
        default=None, description="Similarity score with respect to the query, 0 ~ 1."
    )


class TextualMemoryItem(BaseModel):
    """Represents a single memory item in the textual memory.

    This serves as a standardized format for memory items across different
    textual memory implementations.
    """

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    memory: str
    metadata: (
        TextualMemoryMetadata
        | TreeNodeTextualMemoryMetadata
        | SearchedTreeNodeTextualMemoryMetadata
    ) = Field(default_factory=TextualMemoryMetadata)

    model_config = ConfigDict(extra="forbid")

    @classmethod
    def validate_id(cls, v):
        try:
            uuid.UUID(v)
        except ValueError as e:
            raise ValueError("Invalid UUID format") from e
        return v

    @classmethod
    def from_dict(cls, data: dict) -> "TextualMemoryItem":
        return cls(**data)

    def to_dict(self) -> dict:
        return self.model_dump(exclude_none=True)

    def __str__(self) -> str:
        """Pretty string representation of the memory item."""
        return f"<ID: {self.id} | Memory: {self.memory} | Metadata: {self.metadata!s}>"
