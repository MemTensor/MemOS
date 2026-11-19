import copy
import json

import pytest
import requests

from memos.configs.reranker import RerankerConfigFactory
from memos.memories.textual.item import (
    SourceMessage,
    TextualMemoryItem,
    TreeNodeTextualMemoryMetadata,
)
from memos.reranker.factory import RerankerFactory
from memos.reranker.http_bge import HTTPBGEReranker


@pytest.fixture
def received_requests(monkeypatch):
    received = []

    def send(session, request, **kwargs):
        received.append(json.loads(request.body))
        response = requests.Response()
        response.request = request
        response.url = request.url
        response.status_code = 200
        response._content = b'{"results": [{"index": 0, "relevance_score": 0.9}]}'
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    return received


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        ({"memory": "Prefers offline mode"}, "Prefers offline mode"),
        ({"memory": "Prefers offline mode", "metadata": None}, "Prefers offline mode"),
        ({"memory": "Prefers offline mode", "metadata": {}}, "Prefers offline mode"),
        (
            {"memory": "Prefers offline mode", "metadata": {"sources": None}},
            "Prefers offline mode",
        ),
        (
            {"memory": "Prefers offline mode", "metadata": {"sources": []}},
            "Prefers offline mode\n",
        ),
        ({"memory": "[recall] Prefers offline mode", "metadata": {}}, "Prefers offline mode"),
        (
            TextualMemoryItem(
                memory="Prefers offline mode",
                metadata=TreeNodeTextualMemoryMetadata(sources=None),
            ),
            "Prefers offline mode",
        ),
        (
            TextualMemoryItem(
                memory="Prefers offline mode",
                metadata=TreeNodeTextualMemoryMetadata(sources=[]),
            ),
            "Prefers offline mode\n",
        ),
    ],
)
@pytest.mark.parametrize("backend", ["http_bge", "bge"])
def test_factory_reranks_primary_text_without_sources(received_requests, item, expected, backend):
    original = copy.deepcopy(item)
    reranker = RerankerFactory.from_config(
        RerankerConfigFactory(
            backend=backend,
            config={
                "reranker_url": "https://reranker.example.test/rerank",
                "rerank_source": "sources",
            },
        )
    )

    ranked = reranker.rerank("offline preference", [item], top_k=1)

    assert received_requests[0]["documents"] == [expected]
    assert ranked == [(item, 0.9)]
    assert ranked[0][0] is item
    assert item == original


@pytest.mark.parametrize("response_format", ["results", "data"])
def test_mixed_candidates_keep_document_index_alignment(monkeypatch, response_format):
    source = SourceMessage(role="user", content="Synthetic conversation")
    candidates = [
        {"memory": "First memory", "metadata": {}},
        {"memory": "Second memory", "metadata": {"sources": [source]}},
        {"memory": "Third memory", "metadata": {"sources": None}},
    ]
    original = copy.deepcopy(candidates)
    received = []

    def send(session, request, **kwargs):
        received.append(json.loads(request.body))
        response = requests.Response()
        response.request = request
        response.url = request.url
        response.status_code = 200
        payload = (
            {
                "results": [
                    {"index": 2, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.8},
                    {"index": 1, "relevance_score": 0.1},
                ]
            }
            if response_format == "results"
            else {"data": [{"score": 0.8}, {"score": 0.1}, {"score": 0.9}]}
        )
        response._content = json.dumps(payload).encode()
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    reranker = HTTPBGEReranker(
        "https://reranker.example.test/rerank", rerank_source="sources,missing"
    )

    ranked = reranker.rerank("query", candidates, top_k=2)

    assert received[0]["documents"] == [
        "First memory",
        "Second memory\n[None]: Synthetic conversation\n",
        "Third memory",
    ]
    assert ranked == [(candidates[2], 0.9), (candidates[0], 0.8)]
    assert ranked[0][0] is candidates[2]
    assert ranked[1][0] is candidates[0]
    assert candidates == original


def test_unavailable_selected_field_falls_back_to_primary_text(received_requests):
    item = {
        "memory": "Primary memory",
        "metadata": {"sources": [SourceMessage(content="Unselected source")]},
    }
    reranker = HTTPBGEReranker(
        "https://reranker.example.test/rerank", rerank_source="missing,also_missing"
    )

    assert reranker.rerank("query", [item], top_k=1) == [(item, 0.9)]
    assert received_requests[0]["documents"] == ["Primary memory"]
