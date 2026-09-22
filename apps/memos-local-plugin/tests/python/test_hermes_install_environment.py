"""Execute Unix installer preflight against isolated Hermes layouts."""

import os
import subprocess
import sys

from pathlib import Path


INSTALLER = Path(__file__).resolve().parents[2] / "install.sh"


def fixture_host(root: Path, env_name: str = "venv") -> Path:
    for module in ("hermes_cli", "plugins", "plugins/memory"):
        directory = root / module
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "__init__.py").write_text(
            "def load_memory_provider(name): return None\n" if module == "plugins/memory" else ""
        )
    python = root / env_name / "bin/python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    return python


def probe(tmp_path: Path, **overrides: str) -> subprocess.CompletedProcess:
    source = INSTALLER.read_text()
    start = source.find("resolve_hermes_environment() {")
    assert start >= 0, "installer needs a validated Hermes environment resolver"
    end = source.index("# ─── Hermes install", start)
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
    env.update(HOME=str(tmp_path), PATH="/usr/bin:/bin")
    env.update(overrides)
    script = source[start:end] + "\nresolve_hermes_environment\n"
    return subprocess.run(
        ["/bin/bash", "-c", script],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )


def test_default_layout(tmp_path: Path) -> None:
    root = tmp_path / ".hermes/hermes-agent"
    python = fixture_host(root)
    result = probe(tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == [str(python), str(root / "plugins/memory"), str(root)]


def test_explicit_desktop_root_with_spaces(tmp_path: Path) -> None:
    root = tmp_path / "Library/Application Support/Desktop/backend"
    python = fixture_host(root, ".venv")
    result = probe(tmp_path, HERMES_INSTALL_DIR=str(root))
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[0] == str(python)


def test_bash_launcher_with_spaces(tmp_path: Path) -> None:
    root = tmp_path / "Desktop backend"
    python = fixture_host(root)
    cli = tmp_path / ".local/bin/hermes"
    cli.parent.mkdir(parents=True)
    cli.write_text(f'#!/usr/bin/env bash\nexec "{python}" "{root}/hermes" "$@"\n')
    cli.chmod(0o755)
    result = probe(tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[0] == str(python)


def test_custom_data_home(tmp_path: Path) -> None:
    home = tmp_path / "custom home"
    root = home / "hermes-agent"
    fixture_host(root)
    result = probe(tmp_path, HERMES_HOME=str(home))
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[2] == str(root)


def test_explicit_python_and_root(tmp_path: Path) -> None:
    root = tmp_path / "desktop source"
    fixture_host(root)
    result = probe(tmp_path, HERMES_INSTALL_DIR=str(root), HERMES_PYTHON=sys.executable)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[0] == sys.executable


def test_invalid_override_does_not_fall_back(tmp_path: Path) -> None:
    fixture_host(tmp_path / ".hermes/hermes-agent")
    result = probe(tmp_path, HERMES_PYTHON=str(tmp_path / "missing-python"))
    assert result.returncode != 0
    assert "missing-python" in result.stderr
    assert "HERMES_PYTHON" in result.stderr


def test_missing_host_api_keeps_import_error(tmp_path: Path) -> None:
    root = tmp_path / "old-hermes"
    fixture_host(root)
    (root / "plugins/memory/__init__.py").write_text(
        "raise ImportError('missing host dependency')\n"
    )
    result = probe(tmp_path, HERMES_INSTALL_DIR=str(root))
    assert result.returncode != 0
    assert "missing host dependency" in result.stderr
    assert "HERMES_INSTALL_DIR" in result.stderr


def test_environment_is_checked_before_install_side_effects() -> None:
    source = INSTALLER.read_text()
    body = source[source.index("install_hermes() {") :]
    assert body.index("resolve_hermes_environment") < body.index("Stopping existing bridge daemon")
    assert body.index("resolve_hermes_environment") < body.index("deploy_tarball_to_prefix")


def test_incompatible_host_api_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "old-hermes"
    fixture_host(root)
    (root / "plugins/memory/__init__.py").write_text("")
    result = probe(tmp_path, HERMES_INSTALL_DIR=str(root))
    assert result.returncode != 0
    assert "load_memory_provider" in result.stderr


def test_python_shebang_launcher(tmp_path: Path) -> None:
    root = tmp_path / "custom-host"
    python = fixture_host(root)
    cli = tmp_path / ".local/bin/hermes"
    cli.parent.mkdir(parents=True)
    cli.write_text(f"#!{python}\n")
    cli.chmod(0o755)
    result = probe(tmp_path)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines()[0] == str(python)


def test_failed_preflight_does_not_stop_or_deploy(tmp_path: Path) -> None:
    source = INSTALLER.read_text()
    start = source.index("resolve_hermes_environment() {")
    end = source.index("# ─── Main", start)
    script = (
        """
header() { :; }
step() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
pgrep() { echo unexpected-process-probe >&2; exit 99; }
deploy_tarball_to_prefix() { echo unexpected-deployment >&2; exit 99; }
"""
        + source[start:end]
        + "\ninstall_hermes\n"
    )
    result = subprocess.run(
        ["/bin/bash", "-c", script],
        env={
            "HOME": str(tmp_path),
            "PATH": "/usr/bin:/bin",
            "HERMES_PYTHON": str(tmp_path / "missing"),
        },
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    assert result.returncode != 0
    assert "preflight failed" in result.stderr
    assert "unexpected-" not in result.stderr
    assert not (tmp_path / ".hermes").exists()
