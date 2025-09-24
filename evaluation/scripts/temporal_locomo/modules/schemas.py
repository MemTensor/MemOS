from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class ContextUpdateMethod(Enum):
    """Enumeration for context update methods"""

    DIRECT = "direct"  # Directly update with current context
    TEMPLATE = "chat_history"  # Update using template with history queries and answers


class RecordingCase(BaseModel):
    """
    Data structure for recording evaluation cases in temporal locomo evaluation.

    This schema represents a single evaluation case containing conversation history,
    context information, memory data, and evaluation results.
    """

    # Conversation identification
    conv_id: str = Field(description="Conversation identifier for this evaluation case")

    # Conversation history and context
    history_queries: list[str] = Field(
        default_factory=list, description="List of previous queries in the conversation history"
    )

    context: str = Field(
        default="",
        description="Current search context retrieved from memory systems for answering the query",
    )

    pre_context: str | None = Field(
        default=None,
        description="Previous context from the last query, used for answerability analysis",
    )

    # Query and answer information
    query: str = Field(description="The current question/query being evaluated")

    answer: str = Field(description="The generated answer for the query")

    # Memory data
    memories: list[Any] = Field(
        default_factory=list,
        description="Current memories retrieved from the memory system for this query",
    )

    pre_memories: list[Any] | None = Field(
        default=None, description="Previous memories from the last query, used for comparison"
    )

    # Evaluation metrics
    can_answer: bool | None = Field(
        default=None,
        description="Whether the context can answer the query (only for memos_scheduler frame)",
    )

    can_answer_reason: str | None = Field(
        default=None, description="Reasoning for the can_answer decision"
    )

    # Additional metadata
    category: int | None = Field(
        default=None, description="Category of the query (1-4, where 5 is filtered out)"
    )

    golden_answer: str | None = Field(
        default=None, description="Ground truth answer for evaluation"
    )

    search_duration_ms: float | None = Field(
        default=None, description="Time taken for memory search in milliseconds"
    )

    response_duration_ms: float | None = Field(
        default=None, description="Time taken for response generation in milliseconds"
    )

    can_answer_duration_ms: float | None = Field(
        default=None, description="Time taken for answerability analysis in milliseconds"
    )

    def to_dict(self) -> dict[str, Any]:
        """
        Convert the RecordingCase to a dictionary for serialization.

        Returns:
            Dict[str, Any]: Dictionary representation of the RecordingCase
        """
        return self.dict()

    def to_json(self, indent: int = 2) -> str:
        """
        Convert the RecordingCase to a JSON string.

        Args:
            indent: JSON indentation level

        Returns:
            str: JSON string representation of the RecordingCase
        """
        return self.json(indent=indent, ensure_ascii=False)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RecordingCase":
        """
        Create a RecordingCase from a dictionary.

        Args:
            data: Dictionary containing RecordingCase data

        Returns:
            RecordingCase: New instance created from the dictionary
        """
        return cls(**data)

    @classmethod
    def from_json(cls, json_str: str) -> "RecordingCase":
        """
        Create a RecordingCase from a JSON string.

        Args:
            json_str: JSON string containing RecordingCase data

        Returns:
            RecordingCase: New instance created from the JSON string
        """
        import json

        data = json.loads(json_str)
        return cls.from_dict(data)

    class Config:
        """Pydantic configuration"""

        extra = "allow"  # Allow additional fields not defined in the schema
        validate_assignment = True  # Validate on assignment
        use_enum_values = True  # Use enum values instead of enum names
