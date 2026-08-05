"""Canonical Hermes-home resolver used by the memos-local-plugin adapter.

Mirrors Hermes' own ``_get_platform_default_hermes_home`` so the plugin's
runtime data, PID files, and native import sources land inside the same
directory the Hermes daemon reads on every platform.

Resolution precedence:

1. ``HERMES_HOME`` environment variable (path is expanded + resolved).
2. On win32: ``%LOCALAPPDATA%\\hermes`` (with fallback
   ``~/AppData/Local/hermes`` when ``LOCALAPPDATA`` is unset).
3. On any other platform: ``~/.hermes``.

Regression: issue #2221 — the plugin previously hard-coded ``~/.hermes``
even on Windows, which put its data outside Hermes' real home.
"""

from __future__ import annotations

import os
import sys

from pathlib import Path


def _expand(value: str, env: dict[str, str] | None = None) -> Path:
    """Expand ~ using the caller-supplied HOME if available.

    Uses ``os.path.expanduser`` for the leading ``~`` semantics but
    swaps in the child-environment HOME first so bridge subprocesses
    inherit a stable resolution.
    """
    src = value
    home = ""
    if env is not None:
        home = env.get("HOME", "").strip() or env.get("USERPROFILE", "").strip()
    if src.startswith("~"):
        base = home or str(Path.home())
        if src == "~":
            src = base
        elif src.startswith("~/") or src.startswith("~\\"):
            src = str(Path(base) / src[2:])
    return Path(src).resolve()


def resolve_hermes_home(
    env: dict[str, str] | None = None,
    platform: str | None = None,
) -> Path:
    """Return the canonical Hermes home directory for the given env/platform.

    ``env`` and ``platform`` default to ``os.environ`` and ``sys.platform``
    respectively; callers pass them explicitly to keep the resolver
    unit-testable without process mutation.
    """
    effective_env: dict[str, str]
    if env is None:
        effective_env = dict(os.environ)
    else:
        effective_env = dict(env)
    effective_platform = platform if platform is not None else sys.platform

    hermes_home = effective_env.get("HERMES_HOME", "").strip()
    if hermes_home:
        return _expand(hermes_home, effective_env)

    if effective_platform == "win32":
        local_appdata = effective_env.get("LOCALAPPDATA", "").strip()
        if local_appdata:
            return _expand(local_appdata, effective_env) / "hermes"
        # Match Hermes' fallback: <home>/AppData/Local/hermes.
        home = effective_env.get(
            "USERPROFILE",
            effective_env.get("HOME", "") or str(Path.home()),
        )
        return _expand(home, effective_env) / "AppData" / "Local" / "hermes"

    home = effective_env.get("HOME", "").strip() or str(Path.home())
    return _expand(home, effective_env) / ".hermes"


__all__ = ["resolve_hermes_home"]
