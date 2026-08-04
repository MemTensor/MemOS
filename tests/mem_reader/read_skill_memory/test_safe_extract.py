"""Regression tests for zip-slip / path-traversal hardening in
``_extract_and_parse_skill_zip``.

Issue #2203: ``zipfile.ZipFile.extractall`` was called without per-entry
path validation. A crafted zip could write files outside the requested
extraction directory. These tests build hostile zips in-memory and assert
that the safe-extract helper rejects them with ``ValueError``.
"""

from __future__ import annotations

import os
import zipfile

from typing import TYPE_CHECKING

import pytest

from memos.mem_reader.read_skill_memory.upload_skill_memory import (
    _extract_and_parse_skill_zip,
    _safe_extract_zip,
)


if TYPE_CHECKING:
    from pathlib import Path


def _write_zip(tmp_path: Path, name: str, entries: list[tuple[str, bytes]]) -> Path:
    """Write a zip file with the given (arcname, data) entries."""
    zip_path = tmp_path / name
    with zipfile.ZipFile(zip_path, "w") as zf:
        for arcname, data in entries:
            zf.writestr(arcname, data)
    return zip_path


def _write_zip_with_symlink(tmp_path: Path, name: str, link_name: str, target: str) -> Path:
    """Write a zip file containing a symlink entry pointing to ``target``."""
    zip_path = tmp_path / name
    # Build ZipInfo with the symlink mode (0o120000 in the high bits of
    # external_attr, ignore the trailing perm bits).
    with zipfile.ZipFile(zip_path, "w") as zf:
        info = zipfile.ZipInfo(link_name)
        # UPPER 16 bits = unix mode; 0o120000 = symlink.
        info.external_attr = (0o120777 & 0xFFFF) << 16
        zf.writestr(info, target)
    return zip_path


# ---------------------------------------------------------------------------
# _safe_extract_zip — direct unit tests
# ---------------------------------------------------------------------------


def test_safe_extract_rejects_parent_traversal(tmp_path: Path) -> None:
    """An entry with `../` should raise ValueError, no file created."""
    zip_path = _write_zip(
        tmp_path,
        "malicious.zip",
        [("../escaped.txt", b"poc")],
    )
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf, pytest.raises(ValueError):
        _safe_extract_zip(zf, extract_dir)
    assert not (tmp_path / "escaped.txt").exists()


def test_safe_extract_rejects_deep_traversal(tmp_path: Path) -> None:
    """Multiple `..` segments should also be rejected."""
    zip_path = _write_zip(
        tmp_path,
        "malicious.zip",
        [("../../../../../etc/escaped_canary", b"poc")],
    )
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf, pytest.raises(ValueError):
        _safe_extract_zip(zf, extract_dir)


def test_safe_extract_rejects_absolute_path(tmp_path: Path) -> None:
    """An absolute-path entry should be rejected."""
    # Use the tmp_path/canary as the "absolute" target so we can assert it
    # was not created (rather than picking /tmp/... which might already
    # exist as a file the test runner cannot write to).
    canary = tmp_path / "canary_should_not_exist.txt"
    zip_path = _write_zip(
        tmp_path,
        "malicious.zip",
        # We fabricate an absolute name manually with a ZipInfo so the
        # zipfile library does not sanitize it in transit.
        [],
    )
    with zipfile.ZipFile(zip_path, "a") as zf:
        info = zipfile.ZipInfo(str(canary))
        zf.writestr(info, b"poc")
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf, pytest.raises(ValueError):
        _safe_extract_zip(zf, extract_dir)
    assert not canary.exists()


def test_safe_extract_rejects_symlink_entry(tmp_path: Path) -> None:
    """A symlink zip entry should be rejected outright."""
    zip_path = _write_zip_with_symlink(
        tmp_path,
        "malicious.zip",
        link_name="link_to_shadow",
        target="/etc/shadow",
    )
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf, pytest.raises(ValueError):
        _safe_extract_zip(zf, extract_dir)


def test_safe_extract_accepts_legitimate_zip(tmp_path: Path) -> None:
    """A well-formed zip must still extract successfully."""
    zip_path = _write_zip(
        tmp_path,
        "legit.zip",
        [
            ("SKILL.md", b"---\nname: demo\n---\n# Trigger\ndo the thing\n"),
            ("scripts/hello.py", b"print('hi')\n"),
            ("reference/notes.md", b"see also\n"),
        ],
    )
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf:
        _safe_extract_zip(zf, extract_dir)

    assert (
        extract_dir / "SKILL.md"
    ).read_text() == "---\nname: demo\n---\n# Trigger\ndo the thing\n"
    assert (extract_dir / "scripts" / "hello.py").exists()
    assert (extract_dir / "reference" / "notes.md").exists()


# ---------------------------------------------------------------------------
# _extract_and_parse_skill_zip — end-to-end guard
# ---------------------------------------------------------------------------


def test_extract_and_parse_rejects_malicious_zip(tmp_path: Path) -> None:
    """The high-level parser must propagate the safe-extract rejection."""
    zip_path = _write_zip(
        tmp_path,
        "malicious.zip",
        [
            ("SKILL.md", b"---\nname: demo\n---\n# Trigger\nx\n"),
            ("../escaped.txt", b"poc"),
        ],
    )
    with pytest.raises(ValueError):
        _extract_and_parse_skill_zip(zip_path)
    assert not (tmp_path / "escaped.txt").exists()


def test_extract_and_parse_accepts_legitimate_zip(tmp_path: Path) -> None:
    """Well-formed skill zip must parse into a skill_memory dict."""
    zip_path = _write_zip(
        tmp_path,
        "legit.zip",
        [
            (
                "SKILL.md",
                b"---\nname: demo-skill\ndescription: a demo\n---\n"
                b"# Trigger\nsome trigger\n\n# Procedure\nsteps here\n",
            ),
        ],
    )
    skill = _extract_and_parse_skill_zip(zip_path)
    assert skill["name"] == "demo-skill"
    assert skill["description"] == "a demo"
    assert skill["procedure"].startswith("steps")


def test_safe_extract_when_symlink_ext_attr_is_ignored_on_windows(tmp_path: Path) -> None:
    """Defensive: even on platforms where symlink bits are ignored during
    extractall, the pre-check must still reject."""
    # Same shape as test_safe_extract_rejects_symlink_entry but re-asserts
    # nothing landed in extract_dir if the check fires.
    zip_path = _write_zip_with_symlink(
        tmp_path,
        "malicious.zip",
        link_name="link_to_target",
        target=str(tmp_path / "nonexistent"),
    )
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf, pytest.raises(ValueError):
        _safe_extract_zip(zf, extract_dir)
    # extract_dir should not contain the symlink entry
    if extract_dir.exists():
        assert not any(extract_dir.iterdir())
    # Also assert we did not follow the target
    assert not (tmp_path / "nonexistent").exists()


def test_safe_extract_permits_dotdot_inside_name(tmp_path: Path) -> None:
    """Names like `foo..bar` (no path separator) must still work."""
    zip_path = _write_zip(
        tmp_path,
        "legit.zip",
        [("file..name.txt", b"ok")],
    )
    extract_dir = tmp_path / "sandbox"
    with zipfile.ZipFile(zip_path, "r") as zf:
        _safe_extract_zip(zf, extract_dir)
    assert (extract_dir / "file..name.txt").read_bytes() == b"ok"


# Silence unused import warnings on platforms where os is only touched in
# assertions above.
_ = os
