from unittest.mock import MagicMock, patch

from memos.memories.textual.tree_text_memory.retrieve.bochasearch import BochaAISearchAPI
from memos.memories.textual.tree_text_memory.retrieve.internet_retriever import (
    GoogleCustomSearchAPI,
)


@patch("memos.memories.textual.tree_text_memory.retrieve.bochasearch.requests.post")
def test_bocha_search_uses_bounded_request_timeout(mock_post):
    response = MagicMock()
    response.json.return_value = {"data": {"webPages": {"value": []}}}
    mock_post.return_value = response

    BochaAISearchAPI("api-key").search_web("query")

    mock_post.assert_called_once_with(
        "https://api.bochaai.com/v1/web-search",
        headers={
            "Authorization": "Bearer api-key",
            "Content-Type": "application/json",
        },
        json={
            "query": "query",
            "summary": True,
            "freshness": "noLimit",
            "count": 20,
        },
        timeout=30,
    )


@patch("memos.memories.textual.tree_text_memory.retrieve.internet_retriever.requests.get")
def test_google_search_uses_bounded_request_timeout(mock_get):
    response = MagicMock()
    response.json.return_value = {"items": []}
    mock_get.return_value = response

    GoogleCustomSearchAPI("api-key", "engine-id").search("query")

    mock_get.assert_called_once_with(
        "https://www.googleapis.com/customsearch/v1",
        params={
            "key": "api-key",
            "cx": "engine-id",
            "q": "query",
            "num": 10,
            "start": 1,
        },
        timeout=30,
    )
