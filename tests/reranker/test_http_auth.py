import json

import pytest
import requests

from memos.configs.reranker import RerankerConfigFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.reranker.factory import RerankerFactory
from memos.reranker.http_bge import HTTPBGEReranker
from memos.reranker.http_bge_strategy import HTTPBGERerankerStrategy


@pytest.mark.parametrize("backend", ["http_bge", "http_bge_strategy"])
@pytest.mark.parametrize("use_factory", [False, True])
@pytest.mark.parametrize(
    ("token", "extra", "expected_auth"),
    [
        ("test-token", {}, "Bearer test-token"),
        ("", {}, None),
        ("test-token", {"authorization": "Bearer custom-token"}, "Bearer custom-token"),
    ],
)
def test_http_reranker_authenticates_prepared_request(
    monkeypatch, backend, use_factory, token, extra, expected_auth
):
    """Keep request preparation and ranking real; replace only the HTTP service."""
    headers_extra = {"X-Test-Header": "preserved", **extra}
    original_headers = headers_extra.copy()
    received = []

    def send(session, request, **kwargs):
        received.append(request)
        response = requests.Response()
        response.request = request
        response.url = request.url
        response.status_code = 200 if request.headers.get("Authorization") == expected_auth else 401
        response._content = json.dumps(
            {
                "results": [
                    {"index": 1, "relevance_score": 0.9},
                    {"index": 0, "relevance_score": 0.1},
                ]
            }
        ).encode()
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    options = {
        "reranker_url": "https://reranker.example.test/rerank",
        "token": token,
        "headers_extra": headers_extra,
        "reranker_strategy": "singleturn_outmem",
    }
    if use_factory:
        reranker = RerankerFactory.from_config(
            RerankerConfigFactory(backend=backend, config=options)
        )
    else:
        cls = HTTPBGEReranker if backend == "http_bge" else HTTPBGERerankerStrategy
        reranker = cls(**options)
    items = [
        TextualMemoryItem(
            id=f"00000000-0000-0000-0000-{i:012d}",
            memory=f"memory {i}",
            metadata=TreeNodeTextualMemoryMetadata(
                sources=[
                    {"role": "user", "content": "question"},
                    {"role": "assistant", "content": "answer"},
                ],
            ),
        )
        for i in (1, 2)
    ]

    ranked = reranker.rerank("query", items, top_k=2)

    assert ranked == [(items[1], 0.9), (items[0], 0.1)]
    assert len(received) == 1
    request = received[0]
    assert request.headers.get("Authorization") == expected_auth
    assert request.headers["X-Test-Header"] == "preserved"
    assert request.headers["Content-Type"] == "application/json"
    payload = json.loads(request.body)
    assert payload["query"] == "query"
    assert len(payload["documents"]) == 2
    assert headers_extra == original_headers
