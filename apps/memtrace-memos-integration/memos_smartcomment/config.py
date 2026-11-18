from __future__ import annotations

import math
import os

from dataclasses import dataclass
from pathlib import Path

from memos.exceptions import ConfigurationError


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _as_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _positive_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


@dataclass(frozen=True, slots=True)
class SmartCommentSettings:
    """Runtime settings owned by the external tracing plugin."""

    output_dir: Path = Path(".memos/memtrace")
    queue_size: int = 1024
    max_value_chars: int = 20_000
    # Enable SmartComment checks without changing immutable persisted-memory semantics.
    strict: bool = False
    project_id: str = "memos"
    # Cache eviction never deletes durable JSON snapshots.
    max_cached_traces: int = 64
    max_cached_graph_items: int = 50_000
    cache_ttl_seconds: float = 300
    # Import only the persisted ancestors of final Search results.
    link_search_to_add: bool = False
    # "local" follows the service machine; an IANA timezone overrides it.
    output_timezone: str = "local"

    def __post_init__(self) -> None:
        # Direct callers must not accidentally disable queue or cache bounds.
        for name in (
            "queue_size",
            "max_value_chars",
            "max_cached_traces",
            "max_cached_graph_items",
        ):
            value = getattr(self, name)
            if type(value) is not int or value <= 0:
                raise ConfigurationError(f"{name} must be a positive integer")
        ttl = self.cache_ttl_seconds
        if (
            type(ttl) not in (int, float)
            or ttl <= 0
            or (isinstance(ttl, float) and not math.isfinite(ttl))
        ):
            raise ConfigurationError("cache_ttl_seconds must be positive and finite")

    @classmethod
    def from_env(cls) -> SmartCommentSettings:
        return cls(
            output_dir=Path(os.getenv("MEMOS_SMARTCOMMENT_OUTPUT_DIR", ".memos/memtrace")),
            queue_size=_positive_int("MEMOS_SMARTCOMMENT_QUEUE_SIZE", 1024),
            max_value_chars=_positive_int("MEMOS_SMARTCOMMENT_MAX_VALUE_CHARS", 20_000),
            strict=_as_bool("MEMOS_SMARTCOMMENT_STRICT"),
            project_id=os.getenv("MEMOS_SMARTCOMMENT_PROJECT_ID", "memos"),
            max_cached_traces=_positive_int("MEMOS_SMARTCOMMENT_MAX_CACHED_TRACES", 64),
            max_cached_graph_items=_positive_int(
                "MEMOS_SMARTCOMMENT_MAX_CACHED_GRAPH_ITEMS", 50_000
            ),
            cache_ttl_seconds=_positive_float("MEMOS_SMARTCOMMENT_CACHE_TTL_SECONDS", 300),
            link_search_to_add=_as_bool("MEMOS_SMARTCOMMENT_LINK_SEARCH_TO_ADD"),
            output_timezone=os.getenv("MEMOS_SMARTCOMMENT_OUTPUT_TIMEZONE", "local"),
        )
