"""Unit tests for the shared Hermes home resolver.

Regression: issue #2221 — the memos-local-plugin hard-coded ~/.hermes on
Windows, while Hermes itself uses %LOCALAPPDATA%\\hermes ($HERMES_HOME).
The plugin's runtime state, PID files, and native import sources
therefore landed outside Hermes' real home.

These tests pin the four resolution branches Hermes exposes:

  1. HERMES_HOME env override wins on every platform.
  2. On win32 with LOCALAPPDATA set → <LOCALAPPDATA>/hermes.
  3. On win32 without LOCALAPPDATA → <home>/AppData/Local/hermes.
  4. On any other platform → ~/.hermes.

The helper also snapshots the child-process environment (so it stays
consistent with the JSON-RPC bridge subprocess).
"""

from __future__ import annotations

import os
import sys
import unittest

from pathlib import Path


_ADAPTER_ROOT = Path(__file__).resolve().parent.parent.parent / "adapters" / "hermes"
_PLUGIN_DIR = _ADAPTER_ROOT / "memos_provider"
for _p in (_ADAPTER_ROOT, _PLUGIN_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


class HermesHomeResolverTests(unittest.TestCase):
    """Contract tests for `resolve_hermes_home()`."""

    def test_hermes_home_env_wins_on_posix(self) -> None:
        from hermes_home import resolve_hermes_home

        env = {
            "HERMES_HOME": "/tmp/custom-hermes-home",
            "LOCALAPPDATA": "C:\\Users\\bob\\AppData\\Local",
        }
        got = resolve_hermes_home(env=env, platform="linux")
        self.assertEqual(str(got), "/tmp/custom-hermes-home")

    def test_hermes_home_env_wins_on_windows(self) -> None:
        from hermes_home import resolve_hermes_home

        env = {
            "HERMES_HOME": "D:\\hermes-workshop",
            "LOCALAPPDATA": "C:\\Users\\bob\\AppData\\Local",
        }
        got = resolve_hermes_home(env=env, platform="win32")
        # HERMES_HOME override must be returned as-is (resolved), with no
        # suffix added. Comparing to Path(...).resolve() keeps the test
        # portable — both sides go through the same normalisation.
        self.assertEqual(str(got), str(Path("D:\\hermes-workshop").resolve()))

    def test_windows_uses_localappdata_when_hermes_home_unset(self) -> None:
        from hermes_home import resolve_hermes_home

        env = {"LOCALAPPDATA": "C:\\Users\\bob\\AppData\\Local"}
        got = resolve_hermes_home(env=env, platform="win32")
        got_str = str(got).replace("/", "\\")
        # The last two segments must always be AppData\Local\hermes.
        self.assertTrue(
            got_str.endswith("AppData\\Local\\hermes")
            or got_str.endswith("AppData\\Local\\hermes\\"),
            f"expected LOCALAPPDATA/hermes, got {got_str!r}",
        )

    def test_windows_falls_back_to_home_appdata_when_localappdata_missing(self) -> None:
        from hermes_home import resolve_hermes_home

        # Use a POSIX-shaped HOME so the test is portable — Path("C:\\…")
        # is a relative-filename-with-backslash on Linux/macOS, which
        # would resolve against CWD and give misleading results.
        env = {"HOME": "/home/tester"}
        got = resolve_hermes_home(env=env, platform="win32")
        got_str = str(got).replace("\\", "/")
        # Falls back to <HOME>/AppData/Local/hermes on Windows.
        self.assertTrue(
            got_str.endswith("/AppData/Local/hermes"),
            f"expected …/AppData/Local/hermes, got {got_str!r}",
        )
        self.assertTrue(
            got_str.startswith("/home/tester/"),
            f"expected HOME-rooted path, got {got_str!r}",
        )

    def test_posix_default_is_dot_hermes(self) -> None:
        from hermes_home import resolve_hermes_home

        env = {"HOME": "/home/alice"}
        got = resolve_hermes_home(env=env, platform="linux")
        # Path.resolve() normalizes; check by suffix.
        self.assertTrue(
            str(got).endswith("/.hermes") or str(got).endswith("\\.hermes"),
            f"expected ~/.hermes, got {got!r}",
        )

    def test_default_uses_process_env_and_platform_when_none(self) -> None:
        """When no args are provided the helper must read os.environ / sys.platform."""
        from hermes_home import resolve_hermes_home

        got = resolve_hermes_home()
        env_home = os.environ.get("HERMES_HOME", "").strip()
        if env_home:
            self.assertEqual(str(got), str(Path(env_home).expanduser().resolve()))
        else:
            # Any platform is fine; the branch must not raise and must
            # return an absolute path.
            self.assertTrue(got.is_absolute(), f"expected absolute path, got {got!r}")


class ResolvedRuntimeHomeUsesResolverTests(unittest.TestCase):
    """The Python bridge/adapter fallbacks must go through the resolver."""

    def test_memos_provider_fallback_uses_hermes_home_env(self) -> None:
        import memos_provider

        original = os.environ.get("HERMES_HOME")
        original_memos = os.environ.get("MEMOS_HOME")
        original_config = os.environ.get("MEMOS_CONFIG_FILE")
        try:
            os.environ["HERMES_HOME"] = "/tmp/regression-2221-hermes"
            os.environ.pop("MEMOS_HOME", None)
            os.environ.pop("MEMOS_CONFIG_FILE", None)

            got = memos_provider._resolved_memos_runtime_home()
            got_str = str(got)
            # /tmp/regression-2221-hermes/memos-plugin
            self.assertTrue(
                got_str.endswith("/memos-plugin") or got_str.endswith("\\memos-plugin"),
                f"expected …/memos-plugin, got {got_str!r}",
            )
            self.assertIn("regression-2221-hermes", got_str)
        finally:
            if original is None:
                os.environ.pop("HERMES_HOME", None)
            else:
                os.environ["HERMES_HOME"] = original
            if original_memos is not None:
                os.environ["MEMOS_HOME"] = original_memos
            if original_config is not None:
                os.environ["MEMOS_CONFIG_FILE"] = original_config

    def test_bridge_client_fallback_uses_hermes_home_env(self) -> None:
        import bridge_client

        env = {
            "HERMES_HOME": "/tmp/regression-2221-bridge",
            "HOME": "/home/tester",
        }
        got = bridge_client._resolved_runtime_home("hermes", env)
        got_str = str(got)
        self.assertIn("regression-2221-bridge", got_str)
        self.assertTrue(
            got_str.endswith("/memos-plugin") or got_str.endswith("\\memos-plugin"),
            f"expected …/memos-plugin, got {got_str!r}",
        )


if __name__ == "__main__":
    unittest.main()
