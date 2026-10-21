"""Shared helpers for parsing LLM-as-a-Judge replies.

Both LongMemEval (`evaluation/scripts/longmemeval/lme_eval.py`) and LoCoMo
(`evaluation/scripts/locomo/locomo_eval.py`) ask the judge model to emit a
one-sentence rationale followed by a JSON snippet of the form
``{"label": "CORRECT"}``. A prompt-compliant reply therefore starts with
natural-language prose, so applying ``json.loads`` directly to the full body
raises ``JSONDecodeError`` and silently drops the sample
(see https://github.com/MemTensor/MemOS/issues/2525).

This module centralises the label extraction so both graders share a single
implementation and a single error-reporting shape.
"""

from __future__ import annotations

import re


# Matches ``{"label": "VALUE"}`` with optional whitespace, allowing either
# single or double quotes around the value. Keeps LoCoMo's original behaviour.
_LABEL_PATTERN = re.compile(r"""\{\s*"label"\s*:\s*["']([^"']*)["']\s*\}""")

# How many bytes of the raw reply to include in the error message. Enough to
# distinguish empty replies, truncated replies, and chatty replies without a
# label; bounded so that log lines stay readable.
_PREVIEW_BYTES = 200


def extract_label_json(text: str | None) -> str | None:
    """Return the full ``{"label": "VALUE"}`` substring, or ``None``.

    The returned value is safe to feed back into :func:`json.loads` as long as
    the regex matched a double-quoted shape (single-quoted matches survive the
    regex but are not valid JSON; callers should use :func:`parse_judge_label`
    which handles both cases).
    """
    if not text:
        return None
    match = _LABEL_PATTERN.search(text)
    if match is None:
        return None
    return match.group(0)


def _preview(message_content: str | None) -> str:
    """Return a short, log-safe quoted preview of ``message_content``."""
    if message_content is None:
        return "None"
    if message_content == "":
        return "''"
    truncated = message_content[:_PREVIEW_BYTES]
    suffix = "..." if len(message_content) > _PREVIEW_BYTES else ""
    # ``!r`` already escapes control characters (newlines become ``\\n``, etc.),
    # so no manual pre-escaping is needed. Doing it manually would double-escape
    # (a real newline would render as ``\\\\n`` in the log line).
    return f"{truncated!r}{suffix}"


def parse_judge_label(message_content: str | None) -> str:
    """Extract the judge's label from ``message_content``.

    Returns the label value (e.g. ``"CORRECT"``) on success. Raises
    :class:`ValueError` with a short preview of the raw content when the body
    is empty, ``None``, or contains no ``{"label": ...}`` snippet. The preview
    lets operators tell a transient empty completion apart from a
    prompt-compliant "<reasoning>\\n<json>" body that regressed for a different
    reason — the root cause the bug report called out as currently
    indistinguishable in the logs.
    """
    match = _LABEL_PATTERN.search(message_content) if message_content else None
    if match is None:
        raise ValueError(
            f'judge reply has no {{"label": ...}} JSON (preview: {_preview(message_content)})'
        )

    # Use the regex capture group for the label value rather than running
    # ``json.loads`` on the raw substring. The pattern already enforces the
    # ``{"label": "..."}`` shape, so an explicit JSON parse would just repeat
    # that validation. Reading ``group(1)`` also avoids a global
    # ``replace("'", '"')`` fallback that would mangle any single quote inside
    # the label value itself (e.g. ``{"label": "it's CORRECT"}``).
    return match.group(1)
