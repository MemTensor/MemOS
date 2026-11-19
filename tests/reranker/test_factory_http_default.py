import json

import pytest
import requests

from memos.configs.reranker import RerankerConfigFactory
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.reranker.factory import RerankerFactory


@pytest.mark.parametrize("backend", ["http_bge_strategy", "bge_strategy"])
@pytest.mark.parametrize("explicit_strategy", [False, True])
def test_factory_strategy_default_can_rerank(monkeypatch, backend, explicit_strategy):
    received = []

    def send(session, request, **kwargs):
        received.append(request)
        response = requests.Response()
        response.request = request
        response.url = request.url
        response.status_code = 200
        response._content = b'{"results": [{"index": 0, "relevance_score": 0.9}]}'
        return response

    monkeypatch.setattr(requests.Session, "send", send)
    options = {"reranker_url": "https://reranker.example.test/rerank"}
    if explicit_strategy:
        options["reranker_strategy"] = "single_turn"
    reranker = RerankerFactory.from_config(RerankerConfigFactory(backend=backend, config=options))
    assert reranker is not None
    item = TextualMemoryItem(
        id="00000000-0000-0000-0000-000000000001",
        memory="remembered preference",
        metadata=TreeNodeTextualMemoryMetadata(
            sources=[
                {"role": "user", "content": "question"},
                {"role": "assistant", "content": "answer"},
            ],
        ),
    )

    ranked = reranker.rerank("preference", [item], top_k=1)

    assert len(ranked) == 1
    assert ranked[0][1] == 0.9
    assert "remembered preference" in ranked[0][0].memory
    assert len(received) == 1
    payload = json.loads(received[0].body)
    assert payload["query"] == "preference"
    assert payload["documents"] == [
        "remembered preference\n\n[None]: \nuser: question\nassistant: answer"
    ]


@pytest.mark.parametrize("backend", ["http_bge_strategy", "bge_strategy"])
def test_factory_still_rejects_unknown_explicit_strategy(backend):
    config = RerankerConfigFactory(
        backend=backend,
        config={
            "reranker_url": "https://reranker.example.test/rerank",
            "reranker_strategy": "unknown",
        },
    )
    with pytest.raises(ValueError, match="Invalid backend: unknown"):
        RerankerFactory.from_config(config)
