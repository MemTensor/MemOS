import sys
import types

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


SRC_DIR = Path(__file__).resolve().parents[1] / "src" / "memos"


@pytest.fixture
def download_examples():
    # memos.cli only needs a namespace stub at package level; the module
    # itself has no heavy imports (the FastAPI app import is lazy)
    if "memos" not in sys.modules:
        memos_pkg = types.ModuleType("memos")
        memos_pkg.__path__ = [str(SRC_DIR)]
        sys.modules["memos"] = memos_pkg
    import memos.cli

    return memos.cli.download_examples


# an empty-zip archive header makes the extraction loop a no-op; the point
# of the test is the arguments passed to requests.get
EMPTY_ZIP = b"PK\x05\x06" + b"\x00" * 18


def test_download_examples_sends_timeout(download_examples):
    fake_response = MagicMock()
    fake_response.content = EMPTY_ZIP
    with patch("requests.get", return_value=fake_response) as mock_get:
        download_examples("/tmp/memos-cli-examples-test")
    _, kwargs = mock_get.call_args
    assert kwargs.get("timeout") is not None


def test_download_examples_still_succeeds(download_examples, tmp_path):
    fake_response = MagicMock()
    fake_response.content = EMPTY_ZIP
    with patch("requests.get", return_value=fake_response):
        assert download_examples(str(tmp_path)) is True
