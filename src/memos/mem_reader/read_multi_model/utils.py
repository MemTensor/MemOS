"""Utility functions for message parsing."""

from typing import Any


def extract_role(message: dict[str, Any]) -> str:
    """Extract role from message."""
    return message.get("role", "")
