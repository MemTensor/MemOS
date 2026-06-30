"""Unit tests for `MemOSClient` knowledgebase list APIs (issue #1382)."""

from __future__ import annotations

import json

from unittest.mock import MagicMock, patch

import pytest
import requests


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    """Build a `MemOSClient` with a dummy api key (no real network)."""
    from memos.api.client import MemOSClient

    return MemOSClient(api_key="test_api_key", base_url="https://example.test/api/openmem/v1")


def _ok_response(payload: dict) -> MagicMock:
    """Build a mocked `requests.Response` with `payload` as JSON."""
    resp = MagicMock(spec=requests.Response)
    resp.status_code = 200
    resp.raise_for_status.return_value = None
    resp.json.return_value = payload
    return resp


# ---------------------------------------------------------------------------
# Response models — TC-1 / TC-2 baseline imports
# ---------------------------------------------------------------------------


def test_response_models_exist():
    """The two new response models must be importable from product_models."""
    from memos.api.product_models import (
        ListKnowledgebaseData,
        ListKnowledgebaseFileData,
        MemOSListKnowledgebaseFileResponse,
        MemOSListKnowledgebaseResponse,
    )

    assert MemOSListKnowledgebaseResponse is not None
    assert MemOSListKnowledgebaseFileResponse is not None
    assert ListKnowledgebaseData is not None
    assert ListKnowledgebaseFileData is not None


# ---------------------------------------------------------------------------
# TC-1: list_knowledgebases happy path
# ---------------------------------------------------------------------------


def test_list_knowledgebases_happy_path(client):
    from memos.api.product_models import MemOSListKnowledgebaseResponse

    payload = {
        "code": 200,
        "message": "ok",
        "data": {
            "knowledgebase_list": [
                {"id": "kb_1", "name": "alpha"},
                {"id": "kb_2", "name": "beta"},
            ],
            "total": 2,
            "page": 1,
            "size": 10,
        },
    }

    with patch("memos.api.client.requests.post", return_value=_ok_response(payload)) as mock_post:
        resp = client.list_knowledgebases(page=1, size=10)

    assert isinstance(resp, MemOSListKnowledgebaseResponse)
    assert len(resp.knowledgebases) == 2
    assert resp.knowledgebases[0]["id"] == "kb_1"
    assert resp.data.total == 2

    # Verify the HTTP call shape
    mock_post.assert_called_once()
    call_args, call_kwargs = mock_post.call_args
    url = call_args[0]
    assert url.endswith("/list/knowledgebase")
    body = json.loads(call_kwargs["data"])
    assert body == {"page": 1, "size": 10}
    assert call_kwargs["headers"]["Authorization"] == "Token test_api_key"


# ---------------------------------------------------------------------------
# TC-2: list_knowledgebase_documents happy path
# ---------------------------------------------------------------------------


def test_list_knowledgebase_documents_happy_path(client):
    from memos.api.product_models import MemOSListKnowledgebaseFileResponse

    payload = {
        "code": 200,
        "message": "ok",
        "data": {
            "file_detail_list": [
                {"file_id": "f_1", "filename": "a.pdf"},
            ],
            "total": 1,
            "page": 1,
            "size": 10,
        },
    }

    with patch("memos.api.client.requests.post", return_value=_ok_response(payload)) as mock_post:
        resp = client.list_knowledgebase_documents(knowledgebase_id="kb_1")

    assert isinstance(resp, MemOSListKnowledgebaseFileResponse)
    assert len(resp.files) == 1
    assert resp.files[0].model_dump()["file_id"] == "f_1"
    assert resp.data.total == 1

    mock_post.assert_called_once()
    call_args, call_kwargs = mock_post.call_args
    url = call_args[0]
    assert url.endswith("/list/knowledgebase-file")
    body = json.loads(call_kwargs["data"])
    assert body == {"knowledgebase_id": "kb_1", "page": 1, "size": 10}


# ---------------------------------------------------------------------------
# TC-3: missing knowledgebase_id rejected before HTTP
# ---------------------------------------------------------------------------


def test_list_knowledgebase_documents_rejects_empty_kb_id(client):
    with (
        patch("memos.api.client.requests.post") as mock_post,
        pytest.raises(ValueError, match="knowledgebase_id"),
    ):
        client.list_knowledgebase_documents(knowledgebase_id="")
    mock_post.assert_not_called()


# ---------------------------------------------------------------------------
# TC-4: page < 1 rejected before HTTP
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_page", [0, -1, -42])
def test_list_knowledgebases_rejects_bad_page(client, bad_page):
    with (
        patch("memos.api.client.requests.post") as mock_post,
        pytest.raises(ValueError, match="page"),
    ):
        client.list_knowledgebases(page=bad_page)
    mock_post.assert_not_called()


@pytest.mark.parametrize("bad_page", [0, -1])
def test_list_knowledgebase_documents_rejects_bad_page(client, bad_page):
    with (
        patch("memos.api.client.requests.post") as mock_post,
        pytest.raises(ValueError, match="page"),
    ):
        client.list_knowledgebase_documents(knowledgebase_id="kb_1", page=bad_page)
    mock_post.assert_not_called()


# ---------------------------------------------------------------------------
# TC-5: size out of [1, 100] rejected before HTTP
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_size", [0, -5, 101, 1000])
def test_list_knowledgebases_rejects_bad_size(client, bad_size):
    with (
        patch("memos.api.client.requests.post") as mock_post,
        pytest.raises(ValueError, match="size"),
    ):
        client.list_knowledgebases(size=bad_size)
    mock_post.assert_not_called()


@pytest.mark.parametrize("bad_size", [0, 101])
def test_list_knowledgebase_documents_rejects_bad_size(client, bad_size):
    with (
        patch("memos.api.client.requests.post") as mock_post,
        pytest.raises(ValueError, match="size"),
    ):
        client.list_knowledgebase_documents(knowledgebase_id="kb_1", size=bad_size)
    mock_post.assert_not_called()


# ---------------------------------------------------------------------------
# TC-6: retry on transient failure recovers
# ---------------------------------------------------------------------------


def test_list_knowledgebases_retries_then_succeeds(client):
    from memos.api.product_models import MemOSListKnowledgebaseResponse

    payload = {
        "code": 200,
        "message": "ok",
        "data": {
            "knowledgebase_list": [],
            "total": 0,
            "page": 1,
            "size": 10,
        },
    }

    side_effects = [
        requests.ConnectionError("boom-1"),
        requests.ConnectionError("boom-2"),
        _ok_response(payload),
    ]

    with patch("memos.api.client.requests.post", side_effect=side_effects) as mock_post:
        resp = client.list_knowledgebases()

    assert isinstance(resp, MemOSListKnowledgebaseResponse)
    assert mock_post.call_count == 3


# ---------------------------------------------------------------------------
# TC-7: retry exhaustion re-raises
# ---------------------------------------------------------------------------


def test_list_knowledgebases_retry_exhaustion_raises(client):
    with (
        patch(
            "memos.api.client.requests.post",
            side_effect=requests.ConnectionError("always fails"),
        ) as mock_post,
        pytest.raises(requests.ConnectionError),
    ):
        client.list_knowledgebases()
    assert mock_post.call_count == 3
