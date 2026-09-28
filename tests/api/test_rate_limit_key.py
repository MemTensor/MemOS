import importlib
import logging
import sys
import types

from pathlib import Path

import pytest


SRC_DIR = Path(__file__).resolve().parents[2] / "src" / "memos"


def _install_memos_package_stub() -> None:
    if "memos" not in sys.modules:
        memos_pkg = types.ModuleType("memos")
        memos_pkg.__path__ = [str(SRC_DIR)]
        sys.modules["memos"] = memos_pkg

    if "memos.log" not in sys.modules:
        log_stub = types.ModuleType("memos.log")
        log_stub.get_logger = logging.getLogger
        sys.modules["memos.log"] = log_stub
        sys.modules["memos"].log = log_stub

    if "memos.api" not in sys.modules:
        api_pkg = types.ModuleType("memos.api")
        api_pkg.__path__ = [str(SRC_DIR / "api")]
        sys.modules["memos.api"] = api_pkg
        sys.modules["memos"].api = api_pkg


@pytest.fixture(scope="module")
def rate_limit_module():
    _install_memos_package_stub()
    middleware_pkg = types.ModuleType("memos.api.middleware")
    middleware_pkg.__path__ = [str(SRC_DIR / "api" / "middleware")]
    sys.modules["memos.api.middleware"] = middleware_pkg
    sys.modules["memos"].api.middleware = middleware_pkg
    return importlib.import_module("memos.api.middleware.rate_limit")


class _FakeRequest:
    def __init__(self, headers, client_host="10.0.0.1"):
        self.headers = headers
        self.client = types.SimpleNamespace(host=client_host)


KEY = "krlk_" + "a" * 64


def test_bearer_api_key_gets_keyed_bucket(rate_limit_module):
    request = _FakeRequest({"Authorization": f"Bearer {KEY}"})
    assert rate_limit_module._get_client_key(request) == f"ratelimit:key:{KEY[:20]}"


def test_lowercase_bearer_scheme_is_recognized(rate_limit_module):
    request = _FakeRequest({"Authorization": f"bearer {KEY}"})
    assert rate_limit_module._get_client_key(request) == f"ratelimit:key:{KEY[:20]}"


def test_raw_key_header_still_gets_keyed_bucket(rate_limit_module):
    request = _FakeRequest({"Authorization": KEY})
    assert rate_limit_module._get_client_key(request) == f"ratelimit:key:{KEY[:20]}"


def test_non_key_authorization_falls_back_to_ip(rate_limit_module):
    request = _FakeRequest({"Authorization": "Bearer some-other-token"})
    assert rate_limit_module._get_client_key(request) == "ratelimit:ip:10.0.0.1"


def test_missing_authorization_falls_back_to_ip(rate_limit_module):
    request = _FakeRequest({})
    assert rate_limit_module._get_client_key(request) == "ratelimit:ip:10.0.0.1"
