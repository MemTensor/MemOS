"""Regression tests for `_rebuild_if_stale` (Issue #2470).

Pre-fix, `_rebuild_if_stale()` compared TypeScript source timestamps against
`dist/bridge.cjs` only. Since the ESM migration (#1736 / #1998) both spawn
paths prefer `dist/bridge.mjs`, so a stale `.mjs` next to a fresh `.cjs`
would silently skip the rebuild and the daemon would start the stale ESM
artifact.

The fix compares against **every compiled entry that exists** (mirroring
`_bridge_script()`'s precedence) and rebuilds if any one of them is older
than the newest TypeScript source. Missing compiled entries are also
treated as stale.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import daemon_manager as daemon_manager_mod  # noqa: E402


def _write(path: Path, mtime: float, body: str = "// stub\n") -> None:
    """Create ``path`` (and parents) and stamp it with a known mtime."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body)
    os.utime(path, (mtime, mtime))


class _StaleGuardTestBase(unittest.TestCase):
    """Shared harness: patch `_plugin_root` to a tmpdir and track `subprocess.run`."""

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        # Install plugin_root patch for every test — _rebuild_if_stale reads it.
        patch_root = patch.object(
            daemon_manager_mod,
            "_plugin_root",
            return_value=self.root,
        )
        self.addCleanup(patch_root.stop)
        patch_root.start()
        # Pretend npm is on PATH; individual tests can override.
        patch_which = patch.object(
            daemon_manager_mod.shutil,
            "which",
            return_value="/usr/bin/npm",
        )
        self.addCleanup(patch_which.stop)
        patch_which.start()
        # Capture subprocess.run so tests can assert whether npm was invoked
        # without actually launching anything.
        patch_run = patch.object(
            daemon_manager_mod.subprocess,
            "run",
            return_value=MagicMock(stderr="", stdout=""),
        )
        self.addCleanup(patch_run.stop)
        self.run_mock = patch_run.start()

    def tearDown(self) -> None:
        self._tmp.cleanup()


class RebuildIfStaleRegressionTests(_StaleGuardTestBase):
    """Direct behaviour tests covering the Issue #2470 scenarios."""

    # Sources use `.ts` extension — the current `rglob("*.ts")` scan does
    # not match `.mts` / `.cts`, and the issue explicitly leaves that scan
    # alone. See issue #2470 ("The `rglob("*.ts")` source scan can stay as
    # it is.").

    def test_both_compiled_fresh_skips_rebuild(self) -> None:
        """Baseline sanity: nothing to do when every compiled entry is current."""
        source_mtime = 1_000.0
        compiled_mtime = source_mtime + 10.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.mjs", compiled_mtime)
        _write(self.root / "dist" / "bridge.cjs", compiled_mtime)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_not_called()

    def test_stale_mjs_fresh_cjs_still_rebuilds(self) -> None:
        """The headline bug from #2470.

        `dist/bridge.cjs` is newer than the sources, but the ESM entry
        `dist/bridge.mjs` is older. Pre-fix this returned True without
        rebuilding and the daemon then ran the stale `.mjs`.
        """
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        # mjs is older than source → should trigger rebuild
        _write(self.root / "dist" / "bridge.mjs", source_mtime - 50.0)
        # cjs is newer than source → old logic was fooled by this
        _write(self.root / "dist" / "bridge.cjs", source_mtime + 50.0)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_called_once()
        cmd = self.run_mock.call_args.args[0]
        self.assertEqual(cmd[0], "/usr/bin/npm")
        self.assertEqual(cmd[1:], ["run", "build"])

    def test_fresh_mjs_stale_cjs_still_rebuilds(self) -> None:
        """Symmetric case: `.mjs` fresh but `.cjs` stale also triggers a build.

        A partial build that only refreshed the ESM entry still leaves
        `dist/` inconsistent; keeping both compiled entries in lock-step
        matches the "stricter option" from the issue.
        """
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.mjs", source_mtime + 50.0)
        _write(self.root / "dist" / "bridge.cjs", source_mtime - 50.0)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_called_once()

    def test_only_mjs_present_and_stale_rebuilds(self) -> None:
        """Legacy CJS artifact removed; stale ESM entry alone must still rebuild."""
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.mjs", source_mtime - 10.0)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_called_once()

    def test_only_mjs_present_and_fresh_skips_rebuild(self) -> None:
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.mjs", source_mtime + 10.0)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_not_called()

    def test_only_cjs_present_and_stale_rebuilds(self) -> None:
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.cjs", source_mtime - 10.0)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_called_once()

    def test_no_compiled_entry_triggers_build(self) -> None:
        """A missing `dist/` must not silently claim the binary is current."""
        _write(self.root / "core" / "types.ts", 1_000.0)

        self.assertTrue(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_called_once()

    def test_missing_npm_returns_false_without_running(self) -> None:
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.mjs", source_mtime - 10.0)

        with patch.object(daemon_manager_mod.shutil, "which", return_value=None):
            self.assertFalse(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_not_called()

    def test_build_failure_returns_false(self) -> None:
        source_mtime = 1_000.0
        _write(self.root / "core" / "types.ts", source_mtime)
        _write(self.root / "dist" / "bridge.mjs", source_mtime - 10.0)

        self.run_mock.side_effect = subprocess.CalledProcessError(
            returncode=1, cmd=["npm", "run", "build"], stderr="boom\n"
        )
        self.assertFalse(daemon_manager_mod._rebuild_if_stale())
        self.run_mock.assert_called_once()


if __name__ == "__main__":
    unittest.main()
