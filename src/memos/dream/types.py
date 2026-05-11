from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


class MotiveType(str, Enum):
    """Dream motive taxonomy.

    Each type corresponds to a distinct reason for triggering a Dream run.
    Community implementations can add signal producers for any of these.
    """

    NEWNESS = "newness"
    FREQUENCY = "frequency"
    CONFLICT = "conflict"
    FEEDBACK = "feedback"
    FRAGMENTATION = "fragmentation"


class TargetMemoryType(str, Enum):
    """Memory types that Dream can write back to.

    Dream consolidation may produce updates across heterogeneous memory stores.
    """

    LONG_TERM = "LongTermMemory"
    SKILL = "SkillMemory"
    PROFILE = "ProfileMemory"
    PREFERENCE = "PreferenceMemory"
    INSIGHT = "InsightMemory"
    DREAM_DIARY = "DreamDiary"


class DreamActionType(str, Enum):
    """Write intents emitted by Dream reasoning."""

    CREATE = "create"
    UPDATE = "update"
    MERGE = "merge"
    ARCHIVE = "archive"


class DreamAction(BaseModel):
    """A single write-back instruction produced by Dream reasoning.

    Each action represents one memory mutation (create/update/merge/archive).
    The `rationale` field carries the hypothetical-deduction justification:
    the Dream must demonstrate that *a concrete question can be answered better*
    with this memory present before it is persisted.
    """

    action_type: DreamActionType
    target_memory_type: TargetMemoryType
    target_memory_id: str | None = None
    source_memory_ids: list[str] = Field(default_factory=list)
    new_content: str = ""
    rationale: str = ""
    confidence: float = 0.0
    metadata: dict[str, Any] = Field(default_factory=dict)


class DreamMemoryLifecycle(BaseModel):
    """Lifecycle tracking metadata attached to Dream-produced memories.

    Used by the periodic maintenance process to decide whether a Dream memory
    should be retained, decayed, or archived:
    - Long time not hit → decay / archive
    - Hit but low usefulness → archive
    - Overturned by feedback → immediate archive
    """

    memory_id: str
    source_dream_id: str = ""
    created_at: datetime = Field(default_factory=datetime.utcnow)
    last_hit_at: datetime | None = None
    hit_count: int = 0
    usefulness_score: float = 0.0
    invalidated_by_feedback: bool = False
    status: str = "active"


class DreamSignalSnapshot(BaseModel):
    """Normalized Dream trigger payload passed through the scheduler.

    The current plugin ships the newness signal only. Projects that need
    recall/conflict/feedback signals should add those fields together with
    corresponding producers.
    """

    mem_cube_id: str
    user_id: str = ""
    user_name: str = ""
    session_id: str = ""
    pending_memory_ids: list[str] = Field(default_factory=list)


class DreamMotive(BaseModel):
    """Reason why a Dream run should happen for a cluster of memories."""

    motive_id: str
    motive_type: MotiveType
    description: str
    memory_ids: list[str] = Field(default_factory=list)


class DreamCluster(BaseModel):
    """A Dream work unit created from one motive."""

    cluster_id: str
    motive: DreamMotive
    recalled_items: list[Any] = Field(default_factory=list)


class DreamDiaryEntry(BaseModel):
    """Human-readable dream diary entry, aligned with the Dream diary PRD.

    Each entry carries its own identity (`diary_id`) from the moment it is
    created, so downstream persistence can store it without generating IDs.
    """

    diary_id: str = Field(default_factory=lambda: f"dream_diary_{uuid4().hex}")
    title: str
    summary: str
    dream_entry: str = ""
    motive: dict | None = None
    themes: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    status: str = "completed"

    def format_content(self) -> str:
        """Serialize the entry into a single text block for storage."""
        parts = [self.title, self.summary]
        if self.dream_entry:
            parts.append(self.dream_entry)
        return "\n\n".join(parts)


class DreamResult(BaseModel):
    """Per-cluster Dream output produced by the pipeline.

    Contains both the write-back actions (memory mutations) and the
    explainable diary entry for the Dream run.
    """

    cluster_id: str
    actions: list[DreamAction] = Field(default_factory=list)
    diary_entry: DreamDiaryEntry | None = None
