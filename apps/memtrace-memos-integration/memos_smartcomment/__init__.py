# ruff: noqa: N999
"""MemOS adapter for asynchronous smartcomment execution-graph tracing."""

from __future__ import annotations

from typing import Any


__all__ = ["SmartCommentPlugin"]


def __getattr__(name: str) -> Any:
    if name == "SmartCommentPlugin":
        from memos_smartcomment.plugin import SmartCommentPlugin

        return SmartCommentPlugin
    raise AttributeError(name)
