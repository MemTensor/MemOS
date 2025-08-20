import uuid

from unittest.mock import MagicMock, patch

import pytest

from memos import settings
from memos.configs.vec_db import VectorDBConfigFactory
from memos.vec_dbs.factory import VecDBFactory
from memos.vec_dbs.item import VecDBItem


@pytest.fixture
def config():
    config = VectorDBConfigFactory.model_validate(
        {
            "backend": "chroma",
            "config": {
                "collection_name": "test_collection",
                "vector_dimension": 4,
                "distance_metric": "cosine",
                "path": str(settings.MEMOS_DIR / "chroma"),
            },
        }
    )
    return config


@pytest.fixture
def mock_chroma_client():
    with patch("chromadb.PersistentClient") as mockclient:
        yield mockclient


@pytest.fixture
def vec_db(config, mock_chroma_client):
    return VecDBFactory.from_config(config)


def test_create_collection(vec_db):
    vec_db.client.create_collection("test_collection")
    vec_db.client.create_collection.assert_called_once()
    assert vec_db.config.collection_name == "test_collection"


def test_list_collections(vec_db):
    vec_db.client.list_collections.return_value = [
        type("obj", (object,), {"name": "test_collection"})()
    ]
    collections = vec_db.list_collections()
    assert collections == ["test_collection"]


def test_add_and_get_by_id(vec_db):
    id = str(uuid.uuid4())
    test_data = [
        {
            "id": id,
            "vector": [0.1, 0.2, 0.3],
            "payload": {"metadata": {"tag": "sample"}, "memory": "mem"},
        }
    ]
    mock_collection = MagicMock()
    # Patch get_collection before calling add
    vec_db.client.get_collection.return_value = mock_collection
    vec_db.add(test_data)
    # Mock get return value
    mock_collection.get.return_value = {
        "ids": [id],
        "embeddings": [[0.1, 0.2, 0.3]],
        "metadatas": [{"tag": "sample"}],
    }
    result = vec_db.get_by_id(id)
    assert isinstance(result, VecDBItem)
    assert result.vector == [0.1, 0.2, 0.3]
    assert result.payload["tag"] == "sample"


def test_update_vector(vec_db):
    id = str(uuid.uuid4())
    data = {
        "id": id,
        "vector": [0.4, 0.5, 0.6],
        "payload": {"metadata": {"new": "data"}, "memory": "mem"},
    }
    mock_collection = MagicMock()
    vec_db.client.get_collection.return_value = mock_collection
    vec_db.update(id, data)
    mock_collection.upsert.assert_called_once()


def test_update_payload_only(vec_db):
    mock_collection = MagicMock()
    vec_db.client.get_collection.return_value = mock_collection
    vec_db.update(
        str(uuid.uuid4()),
        {"id": str(uuid.uuid4()), "payload": {"metadata": {"only": "payload"}, "memory": "mem"}},
    )
    mock_collection.upsert.assert_called_once()


def test_delete(vec_db):
    mock_collection = MagicMock()
    vec_db.client.get_collection.return_value = mock_collection
    vec_db.delete(["1", "2"])
    mock_collection.delete.assert_called_once()


def test_count(vec_db):
    vec_db.get_by_filter = MagicMock(return_value=[1, 2, 3, 4, 5])
    count = vec_db.count()
    assert count == 5


def test_get_all(vec_db):
    vec_db.get_by_filter = MagicMock(
        return_value=[VecDBItem(id=str(uuid.uuid4()), vector=[0.1, 0.2, 0.3])]
    )
    results = vec_db.get_all()
    assert len(results) == 1
    assert isinstance(results[0], VecDBItem)
