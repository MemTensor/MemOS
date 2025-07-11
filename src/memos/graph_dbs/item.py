import uuid

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from memos.memories.textual.item import TextualMemoryItem


class GraphDBNode(TextualMemoryItem):
    pass


class GraphDBEdge(BaseModel):
    """Represents an edge in a graph database (corresponds to Neo4j relationship)."""

    id: str = Field(
        default_factory=lambda: str(uuid.uuid4()), description="Unique identifier for the edge"
    )
    source: str = Field(..., description="Source node ID")
    target: str = Field(..., description="Target node ID")
    type: Literal["RELATED", "PARENT"] = Field(
        ..., description="Relationship type (must be one of 'RELATED', 'PARENT')"
    )
    properties: dict[str, Any] | None = Field(
        default=None, description="Additional properties for the edge"
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
    def from_dict(cls, data: dict[str, Any]) -> "GraphDBEdge":
        """Create GraphDBEdge from dictionary."""
        return cls(**data)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary format."""
        return self.model_dump(exclude_none=True)
