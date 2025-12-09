"""Defines memory item types for textual memory."""

import json
import logging
import uuid

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


ALLOWED_ROLES = {"user", "assistant", "system"}


class SourceMessage(BaseModel):
    """
    Purpose: **memory provenance / traceability**.

    Capture the minimal, reproducible origin context of a memory item so it can be
    audited, traced, rolled back, or de-duplicated later.

    Fields & conventions:
        - type: Source kind (e.g., "chat", "doc", "web", "file", "system", ...).
            If not provided, upstream logic may infer it:
            presence of `role` ⇒ "chat"; otherwise ⇒ "doc".
        - role: Conversation role ("user" | "assistant" | "system" | "tool") when the
            source is a chat turn.
        - content: Minimal reproducible snippet from the source. If omitted,
            upstream may fall back to `doc_path` / `url` / `message_id`.
        - file_info: File information for file source.
        - chat_time / message_id / doc_path: Locators for precisely pointing back
            to the original record (timestamp, message id, document path).
        - Extra fields: Allowed (`model_config.extra="allow"`) to carry arbitrary
            provenance attributes (e.g., url, page, offset, span, local_confidence).
    """

    type: str | None = "chat"
    role: Literal["user", "assistant", "system", "tool"] | None = None
    chat_time: str | None = None
    message_id: str | None = None
    content: str | None = None
    doc_path: str | None = None
    file_info: dict | None = None
    model_config = ConfigDict(extra="allow")


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
    type: str | None = Field(default=None)
    key: str | None = Field(default=None, description="Memory key or title.")
    confidence: float | None = Field(
        default=None,
        description="A numeric score (float between 0 and 100) indicating how certain you are about the accuracy or reliability of the memory.",
    )
    source: Literal["conversation", "retrieved", "web", "file", "system"] | None = Field(
        default=None, description="The origin of the memory"
    )
    tags: list[str] | None = Field(
        default=None,
        description='A list of keywords or thematic labels associated with the memory for categorization or retrieval, e.g., `["travel", "health", "project-x"]`.',
    )
    visibility: Literal["private", "public", "session"] | None = Field(
        default=None, description="e.g., 'private', 'public', 'session'"
    )
    updated_at: str | None = Field(
        default_factory=lambda: datetime.now().isoformat(),
        description="The timestamp of the last modification to the memory. Useful for tracking memory freshness or change history. Format: ISO 8601.",
    )
    info: dict | None = Field(
        default=None,
        description="Arbitrary key-value pairs for additional metadata.",
    )

    model_config = ConfigDict(extra="allow")

    covered_history: Any | None = Field(
        default=None,
        description="Record the memory id covered by the update",
    )

    def __str__(self) -> str:
        """Pretty string representation of the metadata."""
        meta = self.model_dump(exclude_none=True)
        return ", ".join(f"{k}={v}" for k, v in meta.items())


class TreeNodeTextualMemoryMetadata(TextualMemoryMetadata):
    """Extended metadata for structured memory, layered retrieval, and lifecycle tracking."""

    memory_type: Literal[
        "WorkingMemory",
        "LongTermMemory",
        "UserMemory",
        "OuterMemory",
        "ToolSchemaMemory",
        "ToolTrajectoryMemory",
    ] = Field(default="WorkingMemory", description="Memory lifecycle type.")
    sources: list[SourceMessage] | None = Field(
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
    usage: list[str] = Field(
        default_factory=list,
        description="Usage history of this node",
    )
    background: str | None = Field(
        default="",
        description="background of this node",
    )

    file_ids: list[str] | None = Field(
        default_factory=list,
        description="The ids of the files associated with the memory.",
    )

    @field_validator("sources", mode="before")
    @classmethod
    def coerce_sources(cls, v):
        if v is None:
            return v
            # Handle string representation of sources (e.g., from PostgreSQL array or malformed data)
        if isinstance(v, str):
            logging.info(f"[coerce_sources] v: {v} type: {type(v)}")
            # If it's a string that looks like a list representation, try to parse it
            # This handles cases like: "[uuid1, uuid2, uuid3]" or "[item1, item2]"
            v_stripped = v.strip()
            if v_stripped.startswith("[") and v_stripped.endswith("]"):
                # Remove brackets and split by comma
                content = v_stripped[1:-1].strip()
                if content:
                    # Split by comma and clean up each item
                    items = [item.strip() for item in content.split(",")]
                    # Convert to list of strings
                    v = items
                else:
                    v = []
            else:
                # Single string, wrap in list
                v = [v]
        if not isinstance(v, list):
            raise TypeError("sources must be a list")
        out = []
        for item in v:
            if isinstance(item, SourceMessage):
                out.append(item)

            elif isinstance(item, dict):
                d = dict(item)
                if d.get("type") is None:
                    d["type"] = "chat" if d.get("role") in ALLOWED_ROLES else "doc"
                out.append(SourceMessage(**d))

            elif isinstance(item, str):
                try:
                    parsed = json.loads(item)
                except Exception:
                    parsed = None

                if isinstance(parsed, dict):
                    if parsed.get("type") is None:
                        parsed["type"] = "chat" if parsed.get("role") in ALLOWED_ROLES else "doc"
                    out.append(SourceMessage(**parsed))
                else:
                    out.append(SourceMessage(type="doc", content=item))

            else:
                out.append(SourceMessage(type="doc", content=str(item)))
        return out

    def __str__(self) -> str:
        """Pretty string representation of the metadata."""
        meta = self.model_dump(exclude_none=True)
        return ", ".join([f"{k}={v}" for k, v in meta.items() if k != "embedding"])


class SearchedTreeNodeTextualMemoryMetadata(TreeNodeTextualMemoryMetadata):
    """Metadata for nodes returned by search, includes similarity info."""

    relativity: float | None = Field(
        default=None, description="Similarity score with respect to the query, 0 ~ 1."
    )


class PreferenceTextualMemoryMetadata(TextualMemoryMetadata):
    """Metadata for preference memory item."""

    preference_type: Literal["explicit_preference", "implicit_preference"] = Field(
        default="explicit_preference", description="Type of preference."
    )
    dialog_id: str | None = Field(default=None, description="ID of the dialog.")
    original_text: str | None = Field(default=None, description="String of the dialog.")
    embedding: list[float] | None = Field(default=None, description="Vector of the dialog.")
    preference: str | None = Field(default=None, description="Preference.")
    created_at: str | None = Field(default=None, description="Timestamp of the dialog.")
    mem_cube_id: str | None = Field(default=None, description="ID of the MemCube.")
    score: float | None = Field(default=None, description="Score of the retrieval result.")


class TextualMemoryItem(BaseModel):
    """Represents a single memory item in the textual memory.

    This serves as a standardized format for memory items across different
    textual memory implementations.
    """

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    memory: str
    metadata: (
        SearchedTreeNodeTextualMemoryMetadata
        | TreeNodeTextualMemoryMetadata
        | TextualMemoryMetadata
        | PreferenceTextualMemoryMetadata
    ) = Field(default_factory=TextualMemoryMetadata)

    model_config = ConfigDict(extra="forbid")

    @field_validator("id")
    @classmethod
    def _validate_id(cls, v: str) -> str:
        uuid.UUID(v)
        return v

    @classmethod
    def from_dict(cls, data: dict) -> "TextualMemoryItem":
        return cls(**data)

    def to_dict(self) -> dict:
        return self.model_dump(exclude_none=True)

    @field_validator("metadata", mode="before")
    @classmethod
    def _coerce_metadata(cls, v: Any):
        if isinstance(
            v,
            SearchedTreeNodeTextualMemoryMetadata
            | TreeNodeTextualMemoryMetadata
            | TextualMemoryMetadata
            | PreferenceTextualMemoryMetadata,
        ):
            return v
        if isinstance(v, dict):
            if "metadata" in v and isinstance(v["metadata"], dict):
                nested_metadata = v["metadata"]
                nested_metadata = nested_metadata.copy()
                nested_metadata.pop("id", None)
                nested_metadata.pop("memory", None)
                v = nested_metadata
            else:
                v = v.copy()
                v.pop("id", None)
                v.pop("memory", None)

            if v.get("relativity") is not None:
                return SearchedTreeNodeTextualMemoryMetadata(**v)
            if v.get("preference_type") is not None:
                return PreferenceTextualMemoryMetadata(**v)
            if any(k in v for k in ("sources", "memory_type", "embedding", "background", "usage")):
                return TreeNodeTextualMemoryMetadata(**v)
            return TextualMemoryMetadata(**v)
        return v

    def __str__(self) -> str:
        """Pretty string representation of the memory item."""
        return f"<ID: {self.id} | Memory: {self.memory} | Metadata: {self.metadata!s}>"


def list_all_fields() -> list[str]:
    """List all possible fields of the TextualMemoryItem model."""
    top = list(TextualMemoryItem.model_fields.keys())
    meta_models = [
        TextualMemoryMetadata,
        TreeNodeTextualMemoryMetadata,
        SearchedTreeNodeTextualMemoryMetadata,
        PreferenceTextualMemoryMetadata,
    ]
    meta_all = sorted(set().union(*[set(m.model_fields.keys()) for m in meta_models]))

    return top + meta_all
