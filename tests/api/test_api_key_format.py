import importlib
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

    if "memos.api" not in sys.modules:
        api_pkg = types.ModuleType("memos.api")
        api_pkg.__path__ = [str(SRC_DIR / "api")]
        sys.modules["memos.api"] = api_pkg
        sys.modules["memos"].api = api_pkg


@pytest.fixture(scope="module")
def api_keys_module():
    _install_memos_package_stub()
    utils_pkg = types.ModuleType("memos.api.utils")
    utils_pkg.__path__ = [str(SRC_DIR / "api" / "utils")]
    sys.modules["memos.api.utils"] = utils_pkg
    sys.modules["memos"].api.utils = utils_pkg
    return importlib.import_module("memos.api.utils.api_keys")


@pytest.fixture(scope="module")
def auth_module(api_keys_module):
    import logging

    log_stub = types.ModuleType("memos.log")
    log_stub.get_logger = logging.getLogger
    sys.modules["memos.log"] = log_stub
    sys.modules["memos"].log = log_stub
    return importlib.import_module("memos.api.middleware.auth")


# int(x, 16) accepted these 64-char hex_parts; none of them is a form
# generate_api_key() can ever produce.
NON_CANONICAL_HEX_PARTS = [
    "+" + "a" * 63,
    "-" + "a" * 63,
    "0x" + "a" * 62,
    "a" * 30 + "_" + "b" * 33,
    " " + "a" * 63,
]


def test_generated_key_passes_format_validation(api_keys_module):
    generated = api_keys_module.generate_api_key()
    assert api_keys_module.validate_key_format(generated.key)


def test_canonical_key_is_accepted(api_keys_module, auth_module):
    key = "krlk_" + "a" * 64
    assert api_keys_module.validate_key_format(key)
    assert auth_module.validate_key_format(key)


@pytest.mark.parametrize("hex_part", NON_CANONICAL_HEX_PARTS)
def test_non_canonical_hex_is_rejected(hex_part, api_keys_module, auth_module):
    key = "krlk_" + hex_part
    assert not api_keys_module.validate_key_format(key)
    assert not auth_module.validate_key_format(key)


def test_wrong_length_is_rejected(api_keys_module, auth_module):
    assert not api_keys_module.validate_key_format("krlk_" + "a" * 63)
    assert not auth_module.validate_key_format("krlk_" + "a" * 65)


def test_missing_prefix_is_rejected(api_keys_module, auth_module):
    assert not api_keys_module.validate_key_format("a" * 64)
    assert not auth_module.validate_key_format("")
