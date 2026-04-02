"""
Integration tests for real /product/add -> /product/search behavior on Neo4j storage.

These tests intentionally avoid importing the full MemOS server stack at module import time,
because the server boot path has optional external dependencies and heavy side effects.
The server app is imported only inside the integration fixture after:
1. Neo4j availability is confirmed
2. required env vars are patched
3. non-essential external components are stubbed/patched

Goal:
- reproduce the old regression where `/product/search` could return empty results
  when a stored memory had a session id but the search request omitted session id
  (or used a different session id)
- keep real graph storage and real API routing in the loop
"""

from __future__ import annotations

import hashlib
import importlib
import math
import os
import sys
import time
import types
import uuid

from collections.abc import Iterator
from typing import Any

import pytest

from fastapi.testclient import TestClient


def _neo4j_integration_configured() -> bool:
    try:
        import fastapi  # noqa: F401
        import neo4j  # noqa: F401
        import openai  # noqa: F401
    except ImportError:
        return False

    return all(os.getenv(k) for k in ("NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD"))


def _install_ollama_stub() -> None:
    """
    `memos.embedders.factory` imports `memos.embedders.ollama` eagerly.
    The real `ollama` package is not required for this test, so install a tiny stub
    to keep module import deterministic.
    """
    if "ollama" in sys.modules:
        return

    module = types.ModuleType("ollama")

    class _DummyEmbedResponse:
        def __init__(self, embeddings: list[list[float]]):
            self.embeddings = embeddings

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        def list(self) -> dict[str, list[Any]]:
            return {"models": []}

        def pull(self, *args, **kwargs) -> None:
            return None

        def embed(self, model: str, input: list[str]):
            dim = int(os.getenv("EMBEDDING_DIMENSION", "8"))
            return _DummyEmbedResponse([[0.0] * dim for _ in input])

    module.Client = Client
    sys.modules["ollama"] = module


def _token_hash_embedding(texts: list[str]) -> list[list[float]]:
    """
    Deterministic local embedding for integration tests.

    Properties:
    - same token -> same dimension contribution
    - query containing the same unique token as the stored memory will get a positive cosine score
    - fixed dimension so Neo4j vector index config stays consistent
    """
    dim = int(os.getenv("EMBEDDING_DIMENSION", "8"))
    embeddings: list[list[float]] = []

    for text in texts:
        vector = [0.0] * dim
        tokens = [tok for tok in text.lower().replace("\n", " ").split(" ") if tok.strip()]
        if not tokens:
            tokens = [text.lower().strip() or "__empty__"]

        for token in set(tokens):
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            bucket = digest[0] % dim
            # Positive-only hashed bag-of-words keeps overlap stable and easy to reason about.
            vector[bucket] += 1.0 + (digest[1] / 255.0)

        norm = math.sqrt(sum(v * v for v in vector)) or 1.0
        embeddings.append([v / norm for v in vector])

    return embeddings


def _clear_module(module_name: str) -> None:
    sys.modules.pop(module_name, None)


def _flatten_text_memories(search_payload: dict[str, Any]) -> list[dict[str, Any]]:
    buckets = search_payload["data"].get("text_mem", [])
    return [memory for bucket in buckets for memory in bucket.get("memories", [])]


def _search_until_found(
    client: TestClient,
    payload: dict[str, Any],
    expected_token: str,
    timeout_seconds: float = 5.0,
) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_response: dict[str, Any] | None = None

    while time.time() < deadline:
        response = client.post("/product/search", json=payload)
        assert response.status_code == 200, response.text
        last_response = response.json()
        memories = _flatten_text_memories(last_response)
        if any(expected_token in (memory.get("memory") or "") for memory in memories):
            return last_response
        time.sleep(0.2)

    assert last_response is not None
    return last_response


@pytest.fixture(scope="module")
def integration_stack(tmp_path_factory) -> Iterator[dict[str, Any]]:
    if not _neo4j_integration_configured():
        pytest.skip("Neo4j integration not configured (need NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD)")

    monkeypatch = pytest.MonkeyPatch()
    static_dir = tmp_path_factory.mktemp("memos-server-static")

    env_updates = {
        "FILE_LOCAL_PATH": str(static_dir),
        "GRAPH_DB_BACKEND": "neo4j",
        "MOS_NEO4J_SHARED_DB": "true",
        "EMBEDDING_DIMENSION": "8",
        "ENABLE_INTERNET": "false",
        "MEM_READER_BACKEND": "simple_struct",
        "MOS_RERANKER_BACKEND": "cosine_local",
        "MOS_FEEDBACK_RERANKER_BACKEND": "cosine_local",
        "MOS_EMBEDDER_BACKEND": "universal_api",
        "MOS_EMBEDDER_PROVIDER": "openai",
        "MOS_EMBEDDER_API_KEY": "integration-test-key",
        "MOS_EMBEDDER_API_BASE": "https://example.invalid/v1",
        "MOS_EMBEDDER_MODEL": "integration-test-embedder",
        "OPENAI_API_KEY": "integration-test-key",
        "OPENAI_API_BASE": "https://example.invalid/v1",
        "MEMRADER_API_KEY": "integration-test-key",
        "MEMRADER_API_BASE": "https://example.invalid/v1",
        "MEMREADER_GENERAL_API_KEY": "integration-test-key",
        "MEMREADER_GENERAL_API_BASE": "https://example.invalid/v1",
    }
    for key, value in env_updates.items():
        monkeypatch.setenv(key, value)

    _install_ollama_stub()

    from memos.memos_tools.singleton import _factory_singleton

    _factory_singleton.clear_cache()

    from memos.embedders.universal_api import UniversalAPIEmbedder
    from memos.memories.textual.tree_text_memory.retrieve.internet_retriever_factory import (
        InternetRetrieverFactory,
    )

    monkeypatch.setattr(
        UniversalAPIEmbedder,
        "embed",
        lambda self, texts: _token_hash_embedding([texts] if isinstance(texts, str) else list(texts)),
        raising=True,
    )
    monkeypatch.setattr(InternetRetrieverFactory, "from_config", lambda *args, **kwargs: None)

    # Import the server only after env + patches are in place.
    _clear_module("memos.api.handlers.component_init")
    _clear_module("memos.api.handlers.config_builders")
    _clear_module("memos.api.handlers")
    _clear_module("memos.api.routers.server_router")
    _clear_module("memos.api.server_api")

    server_api = importlib.import_module("memos.api.server_api")
    server_router = importlib.import_module("memos.api.routers.server_router")

    client = TestClient(server_api.app)
    graph_db = server_router.components["graph_db"]

    try:
        yield {
            "client": client,
            "graph_db": graph_db,
        }
    finally:
        client.close()
        try:
            graph_db.driver.close()
        except Exception:
            pass
        _factory_singleton.clear_cache()
        monkeypatch.undo()


@pytest.fixture
def isolated_cube(integration_stack) -> Iterator[dict[str, Any]]:
    cube_id = f"it_cube_{uuid.uuid4().hex[:10]}"
    user_id = f"it_user_{uuid.uuid4().hex[:10]}"
    graph_db = integration_stack["graph_db"]

    graph_db.clear(user_name=cube_id)
    try:
        yield {
            **integration_stack,
            "cube_id": cube_id,
            "user_id": user_id,
        }
    finally:
        graph_db.clear(user_name=cube_id)


def _add_memory(
    client: TestClient,
    *,
    user_id: str,
    cube_id: str,
    session_id: str,
    unique_token: str,
) -> dict[str, Any]:
    add_payload = {
        "user_id": user_id,
        "mem_cube_id": cube_id,
        "session_id": session_id,
        "async_mode": "sync",
        "mode": "fast",
        "messages": [
            {
                "role": "user",
                "content": (
                    f"Integration regression memory for token {unique_token}. "
                    "This fact must remain searchable across session-scoping variations."
                ),
            }
        ],
    }

    response = client.post("/product/add", json=add_payload)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["data"], payload
    return payload


def _build_search_payload(
    *,
    user_id: str,
    cube_id: str,
    unique_token: str,
    session_id: str | None,
) -> dict[str, Any]:
    payload = {
        "user_id": user_id,
        "mem_cube_id": cube_id,
        "query": unique_token,
        "mode": "fast",
        "top_k": 5,
        "relativity": 0,
        "dedup": "no",
        "include_preference": False,
        "pref_top_k": 0,
        "search_tool_memory": False,
        "tool_mem_top_k": 0,
        "include_skill_memory": False,
        "skill_mem_top_k": 0,
    }
    if session_id is not None:
        payload["session_id"] = session_id
    return payload


class TestServerRouterAddSearchIntegration:
    def test_search_without_session_id_finds_memory_added_with_real_session(self, isolated_cube):
        client = isolated_cube["client"]
        cube_id = isolated_cube["cube_id"]
        user_id = isolated_cube["user_id"]
        stored_session_id = "session-alpha"
        unique_token = f"sessionless-regression-{uuid.uuid4().hex[:8]}"

        _add_memory(
            client,
            user_id=user_id,
            cube_id=cube_id,
            session_id=stored_session_id,
            unique_token=unique_token,
        )

        search_payload = _build_search_payload(
            user_id=user_id,
            cube_id=cube_id,
            unique_token=unique_token,
            session_id=None,
        )
        result = _search_until_found(client, search_payload, unique_token)

        memories = _flatten_text_memories(result)
        assert memories, result
        assert any(unique_token in memory["memory"] for memory in memories), result
        assert any(
            bucket["cube_id"] == cube_id and bucket.get("memories")
            for bucket in result["data"]["text_mem"]
        ), result

    def test_search_with_different_session_id_still_returns_memory(self, isolated_cube):
        client = isolated_cube["client"]
        cube_id = isolated_cube["cube_id"]
        user_id = isolated_cube["user_id"]
        stored_session_id = "session-alpha"
        searched_session_id = "session-beta"
        unique_token = f"cross-session-regression-{uuid.uuid4().hex[:8]}"

        _add_memory(
            client,
            user_id=user_id,
            cube_id=cube_id,
            session_id=stored_session_id,
            unique_token=unique_token,
        )

        search_payload = _build_search_payload(
            user_id=user_id,
            cube_id=cube_id,
            unique_token=unique_token,
            session_id=searched_session_id,
        )
        result = _search_until_found(client, search_payload, unique_token)

        memories = _flatten_text_memories(result)
        assert memories, result
        assert any(unique_token in memory["memory"] for memory in memories), result
