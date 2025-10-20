from typing import Any

from pydantic import BaseModel, Field


class ContextUpdateMethod:
    """Enumeration for context update methods"""

    PRE_CONTEXT = "pre_context"
    CHAT_HISTORY = "chat_history"
    CURRENT_CONTEXT = "current_context"

    @classmethod
    def values(cls):
        """Return a list of all constant values"""
        return [
            getattr(cls, attr)
            for attr in dir(cls)
            if not attr.startswith("_") and isinstance(getattr(cls, attr), str)
        ]


class RecordingCase(BaseModel):
    """
    Data structure for recording evaluation cases in temporal locomo evaluation.

    This schema represents a single evaluation case containing conversation history,
    context information, memory data, and evaluation results.
    """

    # Conversation identification
    conv_id: str = Field(description="Conversation identifier for this evaluation case")

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


class TimeEvalRecordingCase(BaseModel):
    memos_search_duration_ms: float | None = Field(
        default=None, description="Time taken for memory search in milliseconds"
    )

    memos_response_duration_ms: float | None = Field(
        default=None, description="Time taken for response generation in milliseconds"
    )

    memos_can_answer_duration_ms: float | None = Field(
        default=None, description="Time taken for answerability analysis in milliseconds"
    )

    scheduler_search_duration_ms: float | None = Field(
        default=None, description="Time taken for memory search in milliseconds"
    )

    scheduler_response_duration_ms: float | None = Field(
        default=None, description="Time taken for response generation in milliseconds"
    )

    scheduler_can_answer_duration_ms: float | None = Field(
        default=None, description="Time taken for answerability analysis in milliseconds"
    )
