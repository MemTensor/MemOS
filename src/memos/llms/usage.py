"""Context-local metering of provider-reported model usage.

Adapters call `record_usage` with the `usage` object of each provider response. Nothing is kept
unless a caller opened a meter with `meter_usage()` in the same context, so metering costs nothing
elsewhere. A meter opened in a thread is not visible to worker threads started without
`contextvars.copy_context()`.

A call whose provider returned no `usage` is still recorded, as `calls_without_usage`, so a total
built from the meter can tell a complete bill from an undercount. Callers that cannot rely on the
adapter to report (any backend may be configured) wrap the call in `expect_usage`, which records a
usage-less call when the adapter recorded nothing.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any


if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator


CHAT = "chat"
EMBEDDING = "embedding"
COUNTERS = (
    "calls",
    "failed_calls",
    "calls_without_usage",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "cached_tokens",
    "reasoning_tokens",
)

_current: ContextVar[UsageMeter | None] = ContextVar("memos_usage_meter", default=None)


def _number(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


def _field(source: Any, name: str) -> Any:
    if source is None:
        return None
    if isinstance(source, dict):
        return source.get(name)
    return getattr(source, name, None)


def usage_counts(usage: Any) -> dict[str, int]:
    """Token counters of an OpenAI-compatible `usage` object or dict; missing fields are 0."""
    prompt = _number(_field(usage, "prompt_tokens"))
    completion = _number(_field(usage, "completion_tokens"))
    cached = _number(_field(_field(usage, "prompt_tokens_details"), "cached_tokens"))
    # DeepSeek reports cache hits at the top level instead of prompt_tokens_details.
    cached = cached or _number(_field(usage, "prompt_cache_hit_tokens"))
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": _number(_field(usage, "total_tokens")) or prompt + completion,
        "cached_tokens": cached,
        "reasoning_tokens": _number(
            _field(_field(usage, "completion_tokens_details"), "reasoning_tokens")
        ),
    }


class UsageMeter:
    """Usage counters per (kind, model) observed while the meter was active."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        self.records = 0

    def add(
        self, kind: str, model: str | None, usage: Any | None = None, *, failed: bool = False
    ) -> None:
        key = (kind, model or "unknown")
        row = self.rows.setdefault(
            key, {"kind": key[0], "model": key[1], **dict.fromkeys(COUNTERS, 0)}
        )
        row["calls"] += 1
        self.records += 1
        if failed:
            row["failed_calls"] += 1
            return
        if usage is None:
            row["calls_without_usage"] += 1
            return
        for name, value in usage_counts(usage).items():
            row[name] += value

    def summary(self) -> list[dict[str, Any]]:
        return [dict(self.rows[key]) for key in sorted(self.rows)]


@contextmanager
def meter_usage() -> Iterator[UsageMeter]:
    """Collect usage reported in this context until the block exits; meters do not nest."""
    meter = UsageMeter()
    token = _current.set(meter)
    try:
        yield meter
    finally:
        _current.reset(token)


def record_usage(
    kind: str, model: str | None, usage: Any | None = None, *, failed: bool = False
) -> None:
    """Record one provider call in the active meter, if any. Never raises."""
    meter = _current.get()
    if meter is not None:
        try:
            meter.add(kind, model, usage, failed=failed)
        except Exception:  # Metering must never break a model call.
            return


@contextmanager
def expect_usage(kind: str, model: str | None) -> Iterator[None]:
    """Record a usage-less (or failed) call when the wrapped call reported nothing itself."""
    meter = _current.get()
    before = meter.records if meter is not None else 0
    try:
        yield
    except Exception:
        if meter is not None and meter.records == before:
            meter.add(kind, model, failed=True)
        raise
    if meter is not None and meter.records == before:
        meter.add(kind, model)


def merge_usage(*groups: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sum usage rows by (kind, model)."""
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for rows in groups:
        for row in rows or []:
            key = (row["kind"], row["model"])
            out = merged.setdefault(
                key, {"kind": key[0], "model": key[1], **dict.fromkeys(COUNTERS, 0)}
            )
            for name in COUNTERS:
                out[name] += _number(row.get(name))
    return [merged[key] for key in sorted(merged)]
