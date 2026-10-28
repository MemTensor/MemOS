import json
import sys
import tempfile
import unittest

from pathlib import Path
from unittest.mock import patch


PROVIDER_DIR = Path(__file__).resolve().parents[2] / "adapters" / "hermes" / "memos_provider"
sys.path.insert(0, str(PROVIDER_DIR))

import daemon_manager  # noqa: E402

from runtime_home import resolve_runtime_home, select_windows_runtime_home  # noqa: E402


class RuntimeHomeTests(unittest.TestCase):
    def test_legacy_database_wins_and_marker_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            legacy = root / "legacy"
            install = root / "local" / "hermes" / "memos-plugin"
            (legacy / "data").mkdir(parents=True)
            (legacy / "data" / "memos.db").write_bytes(b"legacy")

            selected = select_windows_runtime_home(
                legacy_home=legacy,
                install_root=install,
            )
            self.assertEqual(selected, legacy.resolve())
            marker = json.loads((install / ".memos-runtime-home").read_text("utf-8"))
            self.assertEqual(marker["source"], "legacy-database")

            (install / "data").mkdir()
            (install / "data" / "memos.db").write_bytes(b"new")
            self.assertEqual(
                select_windows_runtime_home(legacy_home=legacy, install_root=install),
                legacy.resolve(),
            )

    def test_both_databases_without_marker_is_an_explicit_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            legacy = root / "legacy"
            install = root / "install"
            for home in (legacy, install):
                (home / "data").mkdir(parents=True)
                (home / "data" / "memos.db").write_bytes(b"db")
            with self.assertRaisesRegex(RuntimeError, "both Windows Hermes runtime homes"):
                select_windows_runtime_home(legacy_home=legacy, install_root=install)

    def test_environment_override_precedes_windows_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            forced = Path(tmp) / "forced"
            selected = resolve_runtime_home(
                env={"MEMOS_HOME": str(forced), "LOCALAPPDATA": str(Path(tmp) / "local")},
                platform_name="nt",
                user_home=Path(tmp) / "user",
            )
            self.assertEqual(selected, forced.resolve())

    def test_daemon_command_and_environment_use_the_selected_home(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime_home = Path(tmp) / "legacy"
            bridge = Path(tmp) / "bridge.cjs"
            bridge.write_text("", encoding="utf-8")
            with (
                patch.object(daemon_manager, "_plugin_root", return_value=Path(tmp)),
                patch.object(daemon_manager, "_bridge_script", return_value=bridge),
                patch.object(daemon_manager, "_node_binary", return_value="node"),
            ):
                command = daemon_manager._bridge_command(
                    daemon=True,
                    runtime_home=runtime_home,
                )
            self.assertIn(f"--home={runtime_home.resolve()}", command)


if __name__ == "__main__":
    unittest.main()
