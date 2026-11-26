from unittest.mock import Mock

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from memos.project_memory.routes import create_router


def _client(legacy_flush):
    plugin = Mock()
    plugin.flush_episodes.return_value = {"space_id": "A", "formation": {"ran": True}}
    app = FastAPI()
    app.include_router(create_router(plugin, legacy_flush=legacy_flush))
    return TestClient(app), plugin


@pytest.fixture(autouse=True)
def _enabled(monkeypatch):
    monkeypatch.setenv("PROJECT_MEMORY_ENABLE_FLUSH", "true")


def test_episode_store_flush_settles_the_space():
    client, plugin = _client(legacy_flush=False)
    reply = client.post("/product/flush_project_memory", json={"space_id": "A", "wait_seconds": 5})
    assert reply.status_code == 200
    assert reply.json()["data"] == {"space_id": "A", "formation": {"ran": True}}
    plugin.flush_episodes.assert_called_once_with("A", None, 5.0)


def test_episode_store_flush_bounds_the_wait():
    client, plugin = _client(legacy_flush=False)
    reply = client.post(
        "/product/flush_project_memory", json={"space_id": "A", "wait_seconds": 301}
    )
    assert reply.status_code == 422
    plugin.flush_episodes.assert_not_called()


def test_legacy_store_keeps_its_own_flush():
    client, plugin = _client(legacy_flush=True)
    plugin.service.flush.return_value = Mock(
        topic_ids=[], failed_episodes=[], decision_ops=[], experience_ops=[], trace=[]
    )
    assert client.post("/product/flush_project_memory", json={"space_id": "A"}).status_code == 200
    plugin.flush_episodes.assert_not_called()


def test_episode_store_flush_is_off_unless_enabled(monkeypatch):
    monkeypatch.delenv("PROJECT_MEMORY_ENABLE_FLUSH")
    client, plugin = _client(legacy_flush=False)
    assert client.post("/product/flush_project_memory", json={"space_id": "A"}).status_code == 404
    plugin.flush_episodes.assert_not_called()
