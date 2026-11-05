"""Regression test for the LongMemEval add request contract."""

import importlib.util
import json

from pathlib import Path
from unittest.mock import Mock, patch


_CLIENT_PATH = Path(__file__).parents[2] / "evaluation/scripts/utils/client.py"
_CLIENT_SPEC = importlib.util.spec_from_file_location("lme_client", _CLIENT_PATH)
assert _CLIENT_SPEC is not None and _CLIENT_SPEC.loader is not None
_CLIENT_MODULE = importlib.util.module_from_spec(_CLIENT_SPEC)
_CLIENT_SPEC.loader.exec_module(_CLIENT_MODULE)


def test_memos_add_sends_session_id_to_product_api(monkeypatch):
    monkeypatch.setenv("MEMOS_URL", "http://memos")
    response = Mock(status_code=200)
    response.text = json.dumps({"message": "Memory added successfully", "data": []})

    with patch.object(_CLIENT_MODULE.requests, "request", return_value=response) as request:
        _CLIENT_MODULE.MemosApiClient().add(
            messages=[{"role": "user", "content": "hello"}],
            user_id="user-1",
            conv_id="session-1",
        )

    payload = json.loads(request.call_args.kwargs["data"])
    assert payload["session_id"] == "session-1"
    assert "conversation_id" not in payload
