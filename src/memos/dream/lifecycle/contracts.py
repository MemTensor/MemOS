"""Validated metadata and event contracts for opt-in Dream maintenance."""

from __future__ import annotations

import hashlib
import json

from datetime import datetime, timezone
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from memos.exceptions import MemoryError as MemOSMemoryError


LIFECYCLE_METADATA_KEY = "_memos_dream_lifecycle_v1"


class LifecycleError(MemOSMemoryError):
    """An observation or transition cannot safely change lifecycle evidence."""


def utc_time(value: datetime | str, *, legacy: bool = False) -> datetime:
    """Normalize a time; only legacy stored times may omit a timezone."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise LifecycleError("Invalid lifecycle timestamp") from exc
    if not isinstance(value, datetime):
        raise LifecycleError("A lifecycle timestamp must be a datetime")
    if value.tzinfo is None or value.utcoffset() is None:
        if not legacy:
            raise LifecycleError("New lifecycle timestamps require a timezone")
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class EventKind(str, Enum):
    RETRIEVED = "retrieved"
    POSITIVE = "positive"
    NEGATIVE = "negative"
    INVALIDATED = "invalidated"


class LifecycleConfig(BaseModel):
    """Retention parameters; their fingerprint prevents silent reinterpretation."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    half_life_seconds: float = Field(default=604800, gt=0, strict=True)
    never_hit_grace_seconds: float = Field(default=604800, ge=0, strict=True)
    archive_strength_threshold: float = Field(default=0.1, ge=0, le=1, strict=True)
    retrieval_reinforcement: float = Field(default=0.1, ge=0, strict=True)
    strength_cap: float = Field(default=2.0, gt=0, strict=True)
    low_usefulness_threshold: float = Field(default=0.2, ge=0, le=1, strict=True)
    min_outcome_count: int = Field(default=3, ge=1, strict=True)
    event_max_age_seconds: float = Field(default=86400, gt=0, strict=True)
    future_tolerance_seconds: float = Field(default=60, ge=0, strict=True)
    receipt_capacity: int = Field(default=128, ge=1, le=100000, strict=True)

    def fingerprint(self) -> str:
        payload = json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


class LifecycleEvent(BaseModel):
    """An immutable, scoped producer event; IDs must not be recycled."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    event_id: str = Field(min_length=1, max_length=512, strict=True)
    memory_id: str = Field(min_length=1, max_length=1024, strict=True)
    cube_id: str = Field(min_length=1, max_length=1024, strict=True)
    at: datetime
    kind: EventKind
    reason: str = Field(default="", max_length=1024, strict=True)

    @field_validator("at", mode="before")
    @classmethod
    def aware_event_time(cls, value):
        try:
            return utc_time(value)
        except LifecycleError as exc:
            raise ValueError(str(exc)) from exc

    def digest(self) -> str:
        payload = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode()).hexdigest()


class EventReceipt(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    identity: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: str = Field(pattern=r"^[0-9a-f]{64}$")
    expires_at: datetime

    @field_validator("expires_at", mode="before")
    @classmethod
    def aware_expiry(cls, value):
        return utc_time(value)


class LifecycleState(BaseModel):
    """The reserved graph envelope; ordinary writers cannot replace it."""

    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    version: int = Field(default=1, ge=1, le=1, strict=True)
    memory_id: str = Field(min_length=1, strict=True)
    cube_id: str = Field(min_length=1, strict=True)
    policy_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_dream_id: str = ""
    created_at: datetime
    base_strength: float = Field(default=1.0, ge=0, strict=True)
    pinned: bool = Field(default=False, strict=True)
    last_hit_at: datetime | None = None
    hit_count: int = Field(default=0, ge=0, strict=True)
    positive_mass: float = Field(default=0.0, ge=0, strict=True)
    negative_mass: float = Field(default=0.0, ge=0, strict=True)
    outcome_count: int = Field(default=0, ge=0, strict=True)
    mass_anchor_at: datetime | None = None
    invalidated_by_feedback: bool = Field(default=False, strict=True)
    status: str = Field(default="active", pattern=r"^(active|archived)$")
    protect_archived_status: bool = Field(default=False, strict=True)
    revision: int = Field(default=0, ge=0, strict=True)
    archived_at: datetime | None = None
    archive_reason: str = ""
    restored_at: datetime | None = None
    restore_reason: str = ""
    receipts: tuple[EventReceipt, ...] = ()

    @field_validator(
        "created_at", "last_hit_at", "mass_anchor_at", "archived_at", "restored_at", mode="before"
    )
    @classmethod
    def stored_time(cls, value):
        return None if value is None else utc_time(value, legacy=True)


class MaintenanceDecision(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", allow_inf_nan=False)

    action: str = Field(pattern=r"^(keep|archive|skip)$")
    reason: str
    strength: float = Field(ge=0)
    usefulness: float = Field(ge=0, le=1)


def checked_state(state: LifecycleState, config: LifecycleConfig) -> LifecycleState:
    """Revalidate even model_copy inputs before a storage reducer trusts them."""
    try:
        state = LifecycleState.model_validate(state.model_dump(mode="python"))
    except ValueError as exc:
        raise LifecycleError("Invalid stored lifecycle envelope") from exc
    if state.policy_fingerprint != config.fingerprint():
        raise LifecycleError("Lifecycle policy mismatch; explicit migration is required")
    if len(state.receipts) > config.receipt_capacity:
        raise LifecycleError("Stored receipt capacity exceeds lifecycle policy")
    identities = [receipt.identity for receipt in state.receipts]
    if len(set(identities)) != len(identities):
        raise LifecycleError("Duplicate stored lifecycle receipt identity")
    return state
