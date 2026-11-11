"""Optional driver boundaries must hold even when psycopg2 is not installed."""

import os
import subprocess
import sys
import textwrap

from pathlib import Path

import pytest


def run_without_driver(body):
    prefix = """
import importlib.abc
import sys
class MissingDriver(importlib.abc.MetaPathFinder):
    attempts = []
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "psycopg2" or fullname.startswith("psycopg2."):
            self.attempts.append(fullname)
            raise ModuleNotFoundError("No module named " + repr(fullname), name=fullname)
missing = MissingDriver()
sys.meta_path.insert(0, missing)
"""
    environment = dict(os.environ)
    environment.pop("MEMOS_OPENGAUSS_TEST_CONFIG", None)
    return subprocess.run(
        [sys.executable, "-c", prefix + textwrap.dedent(body)],
        cwd=Path(__file__).resolve().parents[2],
        env=environment,
        capture_output=True,
        text=True,
        timeout=30,
    )


@pytest.mark.parametrize("initialize", [False, True])
def test_driver_is_loaded_only_when_backend_is_initialized(initialize):
    result = run_without_driver(
        f"""
        from memos.graph_dbs.factory import GraphStoreFactory
        from memos.graph_dbs.opengauss import OpenGaussGraphDB
        assert not missing.attempts, missing.attempts
        assert GraphStoreFactory.backend_to_class["opengauss"] is OpenGaussGraphDB
        if {initialize!r}:
            try:
                OpenGaussGraphDB(None)
            except ImportError as error:
                assert "pip install psycopg2-binary" in str(error)
                assert "https://pypi.org/project/psycopg2-binary/" in str(error)
            else:
                raise AssertionError("Missing driver was not rejected")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_integration_modules_collect_without_optional_driver():
    result = run_without_driver(
        """
        from pathlib import Path
        import pytest
        paths = sorted(str(path) for path in Path("tests/graph_dbs").glob("test_opengauss*.py"))
        status = pytest.main(["--collect-only", "-q", "-rs", *paths])
        assert not missing.attempts, missing.attempts
        raise SystemExit(status)
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "tests collected" in result.stdout
    assert "could not import" not in result.stdout + result.stderr


def test_enabled_integration_requires_real_driver():
    result = run_without_driver(
        """
        import json
        import os
        from tests.graph_dbs.test_opengauss_integration import database
        os.environ["MEMOS_OPENGAUSS_TEST_CONFIG"] = json.dumps({
            "host": "db", "user": "fixture", "password": "synthetic-password",
            "db_name": "test", "user_name": "A", "embedding_dimension": 3,
        })
        try:
            next(database.__wrapped__())
        except ImportError as error:
            assert "pip install psycopg2-binary" in str(error)
        else:
            raise AssertionError("Enabled integration must fail when its driver is missing")
        """
    )
    assert result.returncode == 0, result.stdout + result.stderr
