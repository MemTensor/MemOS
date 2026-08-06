"""Unit tests for bridge script resolution (Issue #1736).

The bridge launcher must prefer `dist/bridge.mjs` (pure ESM, fixes the
CJS↔ESM trampoline failure on Node 22) over `dist/bridge.cjs` (legacy
CommonJS) and over the development sources.

These tests fake the plugin root via a temporary directory and inspect
which path `_bridge_script` and `_bridge_command` produce.
"""

from __future__ import annotations

import sys
import unittest

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import bridge_client as bridge_client_mod  # noqa: E402
import daemon_manager as daemon_manager_mod  # noqa: E402


def _layout(root: Path, *, mjs: bool, cjs: bool, mts: bool, cts: bool) -> None:
    """Create the requested set of bridge entry files under ``root``."""
    (root / "dist").mkdir(parents=True, exist_ok=True)
    (root / "node_modules" / "tsx" / "dist").mkdir(parents=True, exist_ok=True)
    (root / "node_modules" / "tsx" / "dist" / "cli.mjs").write_text("// stub\n")
    if mjs:
        (root / "dist" / "bridge.mjs").write_text("// stub\n")
    if cjs:
        (root / "dist" / "bridge.cjs").write_text("// stub\n")
    if mts:
        (root / "bridge.mts").write_text("// stub\n")
    if cts:
        (root / "bridge.cts").write_text("// stub\n")


class BridgeScriptResolutionTests(unittest.TestCase):
    """Direct precedence test for `bridge_client._bridge_script`."""

    def _resolve(self, root: Path) -> Path:
        return bridge_client_mod._bridge_script(root)

    def test_prefers_dist_mjs_over_everything_else(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=True, cjs=True, mts=True, cts=True)
            self.assertEqual(self._resolve(root), root / "dist" / "bridge.mjs")

    def test_falls_back_to_dist_cjs_when_no_mjs(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=False, cjs=True, mts=True, cts=True)
            self.assertEqual(self._resolve(root), root / "dist" / "bridge.cjs")

    def test_falls_back_to_source_mts_when_no_dist(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=False, cjs=False, mts=True, cts=True)
            self.assertEqual(self._resolve(root), root / "bridge.mts")

    def test_falls_back_to_legacy_source_cts(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=False, cjs=False, mts=False, cts=True)
            self.assertEqual(self._resolve(root), root / "bridge.cts")

    def test_returns_legacy_cts_path_when_nothing_exists(self) -> None:
        """Default to the historical cts path so error messages stay stable."""
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=False, cjs=False, mts=False, cts=False)
            self.assertEqual(self._resolve(root), root / "bridge.cts")


class BridgeCommandLaunchTests(unittest.TestCase):
    """`MemosBridgeClient.__init__` must launch `.mjs` files with plain ``node``.

    The provided ``bridge_path`` flows straight into ``subprocess.Popen``,
    which is patched out. We assert the assembled command line and verify
    no ``tsx`` wrapper is inserted for the new ESM entry.
    """

    def _captured_cmd(self, script_path: str) -> list[str]:
        with (
            patch.object(bridge_client_mod.subprocess, "Popen") as popen,
            patch.object(bridge_client_mod.shutil, "which", return_value="/usr/bin/node"),
            patch.object(bridge_client_mod.threading, "Thread"),
        ):
            popen.return_value.pid = 999
            popen.return_value.stdin = None
            popen.return_value.stdout = None
            popen.return_value.stderr = None
            bridge_client_mod.MemosBridgeClient(bridge_path=script_path)
            popen.assert_called_once()
            return list(popen.call_args.args[0])

    def test_mjs_path_launches_with_node_directly(self) -> None:
        cmd = self._captured_cmd("/tmp/dist/bridge.mjs")
        self.assertEqual(cmd[0], "/usr/bin/node")
        self.assertIn("/tmp/dist/bridge.mjs", cmd)
        self.assertNotIn("tsx", " ".join(cmd))
        self.assertIn("--agent=hermes", cmd)
        self.assertIn("--no-viewer", cmd)

    def test_cjs_path_still_launches_with_node_directly(self) -> None:
        cmd = self._captured_cmd("/tmp/dist/bridge.cjs")
        self.assertEqual(cmd[0], "/usr/bin/node")
        self.assertIn("/tmp/dist/bridge.cjs", cmd)
        self.assertNotIn("tsx", " ".join(cmd))

    def test_mts_source_routes_through_tsx(self) -> None:
        """`.mts` is TypeScript source and needs the tsx loader."""
        cmd = self._captured_cmd("/tmp/bridge.mts")
        joined = " ".join(cmd)
        self.assertIn("/tmp/bridge.mts", cmd)
        # Either explicit `tsx/dist/cli.mjs` or `--import tsx`.
        self.assertTrue("tsx" in joined, f"expected tsx wrapper in cmd: {cmd!r}")

    def test_cts_source_still_routes_through_tsx(self) -> None:
        cmd = self._captured_cmd("/tmp/bridge.cts")
        joined = " ".join(cmd)
        self.assertIn("/tmp/bridge.cts", cmd)
        self.assertTrue("tsx" in joined, f"expected tsx wrapper in cmd: {cmd!r}")


class DaemonBridgeScriptTests(unittest.TestCase):
    """Same precedence rules apply to the viewer-daemon helper."""

    def _resolve(self, root: Path) -> Path:
        # The daemon module's `_bridge_script` reads `_plugin_root()` directly
        # — patch it to return the temporary root.
        with patch.object(daemon_manager_mod, "_plugin_root", return_value=root):
            return daemon_manager_mod._bridge_script()

    def _command(self, root: Path) -> list[str]:
        with (
            patch.object(daemon_manager_mod, "_plugin_root", return_value=root),
            patch.object(daemon_manager_mod, "_node_binary", return_value="/usr/bin/node"),
        ):
            return daemon_manager_mod._bridge_command(daemon=True)

    def test_daemon_prefers_dist_mjs(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=True, cjs=True, mts=False, cts=True)
            self.assertEqual(self._resolve(root), root / "dist" / "bridge.mjs")

    def test_daemon_command_for_mjs_uses_node(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            _layout(root, mjs=True, cjs=True, mts=False, cts=True)
            cmd = self._command(root)
            self.assertEqual(cmd[0], "/usr/bin/node")
            self.assertTrue(cmd[1].endswith("dist/bridge.mjs"))
            self.assertIn("--agent=hermes", cmd)
            self.assertIn("--daemon", cmd)
            self.assertNotIn("tsx", " ".join(cmd))


if __name__ == "__main__":
    unittest.main()
