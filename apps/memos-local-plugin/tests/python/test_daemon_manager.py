"""Unit tests for the daemon_manager managed-daemon gate (issue #2467).

During a systemd restart window the managed bridge daemon is mid-start
while :18800 probes ``free``; a session host that rescue-spawns its own
``--daemon`` then wins first bind and the unit crash-loops forever while
the rogue answers ``/api/v1/health``. The gate under test defers to a
supervisor-managed unit (``systemctl is-active``) instead of racing it.

These tests stub the probe/subprocess layers — no real Node bridge and no
systemd required.

Run:
    python3 -m unittest tests.python.test_daemon_manager
"""

from __future__ import annotations

import contextlib
import os
import subprocess
import sys
import unittest

from pathlib import Path
from unittest.mock import patch


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

import daemon_manager as daemon_manager_mod  # noqa: E402


UNIT = "memos-bridge.service"


class FakeDaemon:
    returncode = None

    def poll(self):
        return None


@contextlib.contextmanager
def acquired_lock(_runtime_home=None):
    yield True


class ManagedDaemonGateTests(unittest.TestCase):
    """Rescue-spawn must yield to an active/activating managed unit (#2467)."""

    def tearDown(self) -> None:
        daemon_manager_mod._viewer_status = None
        daemon_manager_mod._viewer_last_probe_at = 0.0
        daemon_manager_mod._viewer_process = None

    def test_activating_managed_unit_blocks_rescue_spawn(self) -> None:
        """Unit mid-restart + port probes free: no rogue ``--daemon``."""
        with (
            patch.object(daemon_manager_mod, "_probe_viewer", return_value="free"),
            patch.object(
                daemon_manager_mod, "_managed_bridge_unit", return_value=UNIT, create=True
            ),
            patch.object(
                daemon_manager_mod, "_systemd_unit_state", return_value="activating", create=True
            ),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_GRACE_SEC", 0.05, create=True),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_POLL_SEC", 0.01, create=True),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertFalse(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()

    def test_active_managed_unit_blocks_rescue_spawn(self) -> None:
        """Unit active but :18800 not yet bound (pipeline warming up): no spawn."""
        with (
            patch.object(daemon_manager_mod, "_probe_viewer", return_value="free"),
            patch.object(
                daemon_manager_mod, "_managed_bridge_unit", return_value=UNIT, create=True
            ),
            patch.object(
                daemon_manager_mod, "_systemd_unit_state", return_value="active", create=True
            ),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_GRACE_SEC", 0.05, create=True),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_POLL_SEC", 0.01, create=True),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertFalse(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()

    def test_managed_daemon_coming_up_is_waited_for_not_raced(self) -> None:
        """The managed daemon binds during the grace window: report up, no spawn."""
        with (
            patch.object(
                daemon_manager_mod,
                "_probe_viewer",
                side_effect=["free", "free", "running_memos"],
            ),
            patch.object(
                daemon_manager_mod, "_managed_bridge_unit", return_value=UNIT, create=True
            ),
            patch.object(
                daemon_manager_mod,
                "_systemd_unit_state",
                side_effect=["activating", "activating"],
                create=True,
            ),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_GRACE_SEC", 5.0, create=True),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_POLL_SEC", 0.01, create=True),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
            patch.object(daemon_manager_mod.subprocess, "Popen") as popen,
        ):
            self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_not_called()
            self.assertEqual(daemon_manager_mod._viewer_status, "running_memos")

    def test_managed_unit_failure_releases_rescue_spawn(self) -> None:
        """Unit left active/activating (failed/stopped): rescue-spawn proceeds."""
        with (
            patch.object(
                daemon_manager_mod,
                "_probe_viewer",
                side_effect=["free", "free", "free", "running_memos"],
            ),
            patch.object(
                daemon_manager_mod, "_managed_bridge_unit", return_value=UNIT, create=True
            ),
            patch.object(
                daemon_manager_mod,
                "_systemd_unit_state",
                side_effect=["activating", "failed"],
                create=True,
            ),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_GRACE_SEC", 5.0, create=True),
            patch.object(daemon_manager_mod, "MANAGED_UNIT_POLL_SEC", 0.01, create=True),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
            patch.object(
                daemon_manager_mod.subprocess, "Popen", return_value=FakeDaemon()
            ) as popen,
        ):
            self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_called_once()

    def test_no_managed_unit_keeps_unconditional_rescue_spawn(self) -> None:
        """No supervisor signal (systemd absent / unit disabled): today's behavior."""
        with (
            patch.object(
                daemon_manager_mod,
                "_probe_viewer",
                side_effect=["free", "free", "running_memos"],
            ),
            patch.object(
                daemon_manager_mod, "_managed_bridge_unit", return_value=None, create=True
            ),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
            patch.object(
                daemon_manager_mod.subprocess, "Popen", return_value=FakeDaemon()
            ) as popen,
        ):
            self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_called_once()

    def test_inactive_managed_unit_still_allows_rescue_spawn(self) -> None:
        """Unit exists but is stopped: the host is the only way to serve :18800."""
        with (
            patch.object(
                daemon_manager_mod,
                "_probe_viewer",
                side_effect=["free", "free", "running_memos"],
            ),
            patch.object(
                daemon_manager_mod, "_managed_bridge_unit", return_value=UNIT, create=True
            ),
            patch.object(
                daemon_manager_mod, "_systemd_unit_state", return_value="inactive", create=True
            ),
            patch.object(daemon_manager_mod, "_viewer_start_lock", acquired_lock),
            patch.object(daemon_manager_mod, "ensure_bridge_running", return_value=True),
            patch.object(
                daemon_manager_mod.subprocess, "Popen", return_value=FakeDaemon()
            ) as popen,
        ):
            self.assertTrue(daemon_manager_mod.ensure_viewer_daemon())
            popen.assert_called_once()


class ManagedBridgeUnitConfigTests(unittest.TestCase):
    def test_default_unit_is_memos_bridge_service(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "MEMOS_BRIDGE_SYSTEMD_UNIT"}
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(daemon_manager_mod._managed_bridge_unit(), UNIT)

    def test_env_renames_the_unit(self) -> None:
        with patch.dict(os.environ, {"MEMOS_BRIDGE_SYSTEMD_UNIT": "my-bridge.service"}):
            self.assertEqual(daemon_manager_mod._managed_bridge_unit(), "my-bridge.service")

    def test_empty_env_disables_the_gate(self) -> None:
        with patch.dict(os.environ, {"MEMOS_BRIDGE_SYSTEMD_UNIT": "   "}):
            self.assertIsNone(daemon_manager_mod._managed_bridge_unit())


class SystemdUnitStateTests(unittest.TestCase):
    def test_degrades_to_none_without_systemctl(self) -> None:
        with patch.object(daemon_manager_mod.shutil, "which", return_value=None) as which:
            self.assertIsNone(daemon_manager_mod._systemd_unit_state(UNIT))
            which.assert_called_once_with("systemctl")

    def test_reads_stdout_regardless_of_exit_code(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=3, stdout="activating\n", stderr=""
        )
        with (
            patch.object(daemon_manager_mod.shutil, "which", return_value="/usr/bin/systemctl"),
            patch.object(daemon_manager_mod.subprocess, "run", return_value=completed) as run,
        ):
            self.assertEqual(daemon_manager_mod._systemd_unit_state(UNIT), "activating")
            run.assert_called_once_with(
                ["/usr/bin/systemctl", "is-active", UNIT],
                capture_output=True,
                text=True,
                timeout=2.0,
            )

    def test_degrades_to_none_when_systemctl_fails(self) -> None:
        with (
            patch.object(daemon_manager_mod.shutil, "which", return_value="/usr/bin/systemctl"),
            patch.object(
                daemon_manager_mod.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd="systemctl", timeout=2.0),
            ),
        ):
            self.assertIsNone(daemon_manager_mod._systemd_unit_state(UNIT))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
