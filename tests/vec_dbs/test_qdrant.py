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
            "backend": "qdrant",
            "config": {
                "collection_name": "test_collection",
                "vector_dimension": 4,
                "distance_metric": "cosine",
                "path": str(settings.MEMOS_DIR / "qdrant"),
            },
        }
    )
    return config


@pytest.fixture
def mock_qdrant_client():
    with patch("qdrant_client.QdrantClient") as mockclient:
        yield mockclient


@pytest.fixture
def vec_db(config, mock_qdrant_client):
    mock_instance = mock_qdrant_client.return_value
    mock_instance.get_collection.side_effect = Exception(
        "Not found"
    )  # simulate collection doesn't exist
    return VecDBFactory.from_config(config)


def test_create_collection(vec_db):
    vec_db.client.create_collection.assert_called_once()
    assert vec_db.config.collection_name == "test_collection"


def test_list_collections(vec_db):
    vec_db.client.get_collections.return_value.collections = [
        type("obj", (object,), {"name": "test_collection"})
    ]
    collections = vec_db.list_collections()
    assert collections == ["test_collection"]


def test_add_and_get_by_id(vec_db):
    id = str(uuid.uuid4())
    test_data = [{"id": id, "vector": [0.1, 0.2, 0.3], "payload": {"tag": "sample"}}]
    vec_db.add(test_data)
    vec_db.client.upsert.assert_called_once()
    vec_db.client.retrieve.return_value = [
        type("obj", (object,), {"id": id, "vector": [0.1, 0.2, 0.3], "payload": {"tag": "sample"}})
    ]
    result = vec_db.get_by_id(id)
    assert isinstance(result, VecDBItem)
    assert result.vector == [0.1, 0.2, 0.3]
    assert result.payload["tag"] == "sample"


def test_search(vec_db):
    id = str(uuid.uuid4())
    vec_db.client.search.return_value = [
        type(
            "obj",
            (object,),
            {"id": id, "vector": [0.1, 0.2, 0.3], "payload": {"tag": "search"}, "score": 0.9},
        )
    ]
    results = vec_db.search([0.1, 0.2, 0.3], top_k=1)
    assert len(results) == 1
    assert isinstance(results[0], VecDBItem)
    assert results[0].score == 0.9


def test_update_vector(vec_db):
    id = str(uuid.uuid4())
    data = {"id": id, "vector": [0.4, 0.5, 0.6], "payload": {"new": "data"}}
    vec_db.update(id, data)
    vec_db.client.upsert.assert_called_once()


def test_update_payload_only(vec_db):
    vec_db.update("1", {"payload": {"only": "payload"}})
    vec_db.client.set_payload.assert_called_once()


def test_delete(vec_db):
    vec_db.delete(["1", "2"])
    vec_db.client.delete.assert_called_once()


def test_count(vec_db):
    vec_db.client.count.return_value.count = 5
    count = vec_db.count()
    assert count == 5


def test_get_all(vec_db):
    vec_db.get_by_filter = MagicMock(
        return_value=[VecDBItem(id=str(uuid.uuid4()), vector=[0.1, 0.2, 0.3])]
    )
    results = vec_db.get_all()
    assert len(results) == 1
    assert isinstance(results[0], VecDBItem)


def test_qdrant_client_cloud_init():
    config = VectorDBConfigFactory.model_validate(
        {
            "backend": "qdrant",
            "config": {
                "collection_name": "cloud_collection",
                "vector_dimension": 3,
                "distance_metric": "cosine",
                "url": "https://cloud.qdrant.example",
                "api_key": "secret-key",
            },
        }
    )

    with patch("qdrant_client.QdrantClient") as mockclient:
        mock_instance = mockclient.return_value
        mock_instance.get_collection.side_effect = Exception("Not found")

        VecDBFactory.from_config(config)

        mockclient.assert_called_once_with(url="https://cloud.qdrant.example", api_key="secret-key")
