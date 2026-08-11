"""Stable runtime-home selection for Hermes on Windows.

The Windows installer lives under LocalAppData, but releases before this
resolver could still create the SQLite database under the legacy user-profile
home. Selection is deliberately non-destructive: old data stays in place and
only a small marker under the install root records which home owns it.
"""

from __future__ import annotations

import contextlib
import json
import os

from pathlib import Path
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from collections.abc import Mapping


RUNTIME_HOME_MARKER = ".memos-runtime-home"


def resolve_runtime_home(
    *,
    env: Mapping[str, str] | None = None,
    platform_name: str | None = None,
    plugin_root: Path | None = None,
    user_home: Path | None = None,
    persist: bool = True,
) -> Path:
    """Resolve one runtime home without copying or merging user data."""
    values = os.environ if env is None else env
    selected = values.get("MEMOS_HOME", "").strip()
    if selected:
        return Path(selected).expanduser().resolve()
    config_file = values.get("MEMOS_CONFIG_FILE", "").strip()
    if config_file:
        return Path(config_file).expanduser().resolve().parent

    platform_name = os.name if platform_name is None else platform_name
    legacy_home = (user_home or Path.home()) / ".hermes" / "memos-plugin"
    if platform_name != "nt":
        return legacy_home.resolve()

    local_app_data = values.get("LOCALAPPDATA", "").strip()
    install_root = (
        Path(local_app_data) / "hermes" / "memos-plugin" if local_app_data else plugin_root
    )
    if install_root is None:
        return legacy_home.resolve()
    return select_windows_runtime_home(
        legacy_home=legacy_home,
        install_root=install_root,
        persist=persist,
    )


def select_windows_runtime_home(
    *,
    legacy_home: Path,
    install_root: Path,
    persist: bool = True,
) -> Path:
    """Apply legacy-data-first selection and persist the result atomically."""
    legacy_home = legacy_home.resolve()
    install_root = install_root.resolve()
    marker = install_root / RUNTIME_HOME_MARKER
    marked = _read_marker(marker)
    if marked is not None:
        return marked

    legacy_db = (legacy_home / "data" / "memos.db").is_file()
    canonical_db = (install_root / "data" / "memos.db").is_file()
    if legacy_db and canonical_db:
        raise RuntimeError(
            "both Windows Hermes runtime homes contain a database; "
            f"set MEMOS_HOME explicitly ({legacy_home} or {install_root})"
        )

    if legacy_db:
        selected, source = legacy_home, "legacy-database"
    elif canonical_db:
        selected, source = install_root, "canonical-database"
    elif _has_meaningful_data(legacy_home):
        selected, source = legacy_home, "legacy-data"
    else:
        selected, source = install_root, "new-install"

    if persist:
        _write_marker(marker, selected, source)
    return selected


def _read_marker(marker: Path) -> Path | None:
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(payload, dict):
        return None
    value = payload.get("path")
    if (
        payload.get("version") != 1
        or not isinstance(value, str)
        or not value.strip()
        or not Path(value).is_absolute()
    ):
        return None
    return Path(value).resolve()


def _write_marker(marker: Path, selected: Path, source: str) -> None:
    marker.parent.mkdir(parents=True, exist_ok=True)
    temp = marker.with_name(f"{marker.name}.{os.getpid()}.tmp")
    temp.write_text(
        json.dumps(
            {"version": 1, "path": str(selected), "source": source},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    with contextlib.suppress(PermissionError):
        temp.chmod(0o600)
    temp.replace(marker)


def _has_meaningful_data(root: Path) -> bool:
    if (root / "config.yaml").is_file() or (root / ".auth.json").is_file():
        return True
    skills = root / "skills"
    try:
        return next(skills.iterdir(), None) is not None
    except OSError:
        return False
