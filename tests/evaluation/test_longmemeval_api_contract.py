import importlib.util
import json

from pathlib import Path
from unittest.mock import Mock, patch

from memos.api.product_models import APISearchRequest
from memos.search.search_service import build_search_context


_CLIENT_PATH = Path(__file__).parents[2] / "evaluation" / "scripts" / "utils" / "client.py"
_CLIENT_SPEC = importlib.util.spec_from_file_location("longmemeval_client", _CLIENT_PATH)
_CLIENT_MODULE = importlib.util.module_from_spec(_CLIENT_SPEC)
assert _CLIENT_SPEC.loader is not None
_CLIENT_SPEC.loader.exec_module(_CLIENT_MODULE)

MemosApiClient = _CLIENT_MODULE.MemosApiClient
MemosApiOnlineClient = _CLIENT_MODULE.MemosApiOnlineClient


def _response(payload: dict) -> Mock:
    response = Mock(status_code=200)
    response.text = json.dumps(payload)
    return response


def test_memos_api_search_forwards_reference_time(monkeypatch):
    monkeypatch.setenv("MEMOS_URL", "http://memos.test")
    client = MemosApiClient()
    reference_time = "2023-04-01T00:00:00Z"

    with patch.object(
        _CLIENT_MODULE.requests,
        "request",
        return_value=_response({"message": "Search completed successfully", "data": {}}),
    ) as request:
        client.search("What happened yesterday?", "user-1", 5, reference_time=reference_time)

    payload = json.loads(request.call_args.kwargs["data"])
    assert payload["reference_time"] == reference_time


def test_online_search_accepts_but_does_not_send_reference_time(monkeypatch):
    monkeypatch.setenv("MEMOS_ONLINE_URL", "http://memos-online.test")
    client = MemosApiOnlineClient()
    reference_time = "2023-04-01T00:00:00Z"
    response_payload = {
        "message": "ok",
        "data": {
            "memory_detail_list": [],
            "preference_detail_list": [],
            "preference_note": "",
        },
    }

    with patch.object(
        _CLIENT_MODULE.requests,
        "request",
        return_value=_response(response_payload),
    ) as request:
        client.search("What happened yesterday?", "user-1", 5, reference_time=reference_time)

    payload = json.loads(request.call_args.kwargs["data"])
    assert "reference_time" not in payload


def test_search_context_preserves_reference_time():
    reference_time = "2023-04-01T00:00:00Z"
    search_request = APISearchRequest(
        query="What happened yesterday?",
        user_id="user-1",
        reference_time=reference_time,
    )

    context = build_search_context(search_request)

    assert context.info["reference_time"] == reference_time
