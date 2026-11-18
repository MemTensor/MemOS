# Redaction is field-based; free-form text is only truncated.
from __future__ import annotations

import dataclasses
import json
import math

from collections.abc import Mapping
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any


_SECRET_PARTS = (
    "api_key",
    "apikey",
    "access_key",
    "password",
    "secret",
    "authorization",
    "cookie",
    "credential",
    "token",
)
_VECTOR_KEYS = {"embedding", "embeddings", "vector", "vectors"}
_ARGUMENT_KEYS = {"argument", "arguments"}


def _is_secret_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _SECRET_PARTS)


def _truncate(value: str, max_value_chars: int) -> str:
    if len(value) <= max_value_chars:
        return value
    return value[:max_value_chars] + "…"


# Limits apply per container; cycle detection follows the active recursion path.
def to_jsonable(
    value: Any,
    *,
    max_value_chars: int = 20_000,
    max_items: int = 200,
    _seen: set[int] | None = None,
) -> Any:
    """Create a bounded JSON-compatible snapshot without secrets or vectors."""

    if value is None or isinstance(value, bool | int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return _truncate(value, max_value_chars)
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    if isinstance(value, date | datetime | Path | Enum):
        return str(getattr(value, "value", value))

    seen = _seen if _seen is not None else set()
    value_id = id(value)
    if value_id in seen:
        return "<cycle>"
    seen.add(value_id)

    try:
        # Expand models first so nested fields receive the same redaction.
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            value = {field.name: getattr(value, field.name) for field in dataclasses.fields(value)}
        elif hasattr(value, "model_dump"):
            try:
                value = value.model_dump(mode="json")
            except TypeError:
                value = value.model_dump()

        if isinstance(value, Mapping):
            result: dict[str, Any] = {}
            for index, (raw_key, item) in enumerate(value.items()):
                if index >= max_items:
                    result["<truncated>"] = f"{len(value) - max_items} more items"
                    break
                key = str(raw_key)
                if _is_secret_key(key):
                    result[key] = "<redacted>"
                elif key.lower() in _VECTOR_KEYS:
                    length = len(item) if hasattr(item, "__len__") else "unknown"
                    result[key] = f"<omitted-vector:{length}>"
                elif key.lower() in _ARGUMENT_KEYS and isinstance(item, str):
                    # OpenAI tool calls carry a JSON string, which must be decoded
                    # before key-based redaction. Incomplete arguments are not safe
                    # to retain because their secret fields cannot be inspected.
                    try:
                        arguments = json.loads(item)
                    except (ValueError, RecursionError):
                        arguments = None
                    if isinstance(arguments, dict | list):
                        sanitized = to_jsonable(
                            arguments,
                            max_value_chars=max_value_chars,
                            max_items=max_items,
                            _seen=seen,
                        )
                        result[key] = _truncate(
                            json.dumps(sanitized, ensure_ascii=False), max_value_chars
                        )
                    else:
                        result[key] = "<omitted-unparseable-arguments>"
                else:
                    result[key] = to_jsonable(
                        item,
                        max_value_chars=max_value_chars,
                        max_items=max_items,
                        _seen=seen,
                    )
            return result

        if isinstance(value, list | tuple | set | frozenset):
            items = list(value)
            result = [
                to_jsonable(
                    item,
                    max_value_chars=max_value_chars,
                    max_items=max_items,
                    _seen=seen,
                )
                for item in items[:max_items]
            ]
            if len(items) > max_items:
                result.append(f"<{len(items) - max_items} more items>")
            return result

        if hasattr(value, "__dict__"):
            return to_jsonable(
                vars(value),
                max_value_chars=max_value_chars,
                max_items=max_items,
                _seen=seen,
            )
        return _truncate(repr(value), max_value_chars)
    finally:
        # Shared objects in sibling branches are not cycles.
        seen.discard(value_id)
