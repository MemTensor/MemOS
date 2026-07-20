import sys
import types
import uuid

from unittest.mock import MagicMock

import pytest

from memos.configs.vec_db import VectorDBConfigFactory
from memos.vec_dbs.factory import VecDBFactory
from memos.vec_dbs.item import VecDBItem


@pytest.fixture
def fake_pyseekdb():
    """Inject a fake ``pyseekdb`` module so the provider can be constructed."""
    module = types.ModuleType("pyseekdb")
    module.Client = MagicMock(name="Client")
    module.HNSWConfiguration = MagicMock(name="HNSWConfiguration")
    sys.modules["pyseekdb"] = module
    try:
        yield module
    finally:
        sys.modules.pop("pyseekdb", None)


@pytest.fixture
def config():
    return VectorDBConfigFactory.model_validate(
        {
            "backend": "oceanbase",
            "config": {
                "collection_name": "test_collection",
                "vector_dimension": 3,
                "distance_metric": "cosine",
                "host": "127.0.0.1",
                "port": 2881,
                "user": "root",
                "password": "",
                "database": "memos",
            },
        }
    )


@pytest.fixture
def collection():
    return MagicMock(name="collection")


@pytest.fixture
def vec_db(config, fake_pyseekdb, collection):
    client = fake_pyseekdb.Client.return_value
    client.has_collection.return_value = False
    client.create_collection.return_value = collection
    client.get_collection.return_value = collection
    return VecDBFactory.from_config(config)


def test_backend_registered():
    for backend in ("oceanbase", "seekdb"):
        assert backend in VecDBFactory.backend_to_class


def test_create_collection(vec_db, collection):
    vec_db.client.create_collection.assert_called_once()
    assert vec_db.collection is collection
    assert vec_db.config.collection_name == "test_collection"


def test_add(vec_db, collection):
    item_id = str(uuid.uuid4())
    vec_db.add(
        [
            {
                "id": item_id,
                "vector": [0.1, 0.2, 0.3],
                "payload": {"memory": "hi", "status": "activated"},
            }
        ]
    )
    collection.add.assert_called_once()
    kwargs = collection.add.call_args.kwargs
    assert kwargs["ids"] == [item_id]
    assert kwargs["embeddings"] == [[0.1, 0.2, 0.3]]
    assert kwargs["documents"] == ["hi"]
    # payload is stored directly in the JSON metadata column (nested included)
    meta = kwargs["metadatas"][0]
    assert meta == {"memory": "hi", "status": "activated"}


def test_search_scores_and_payload(vec_db, collection):
    item_id = str(uuid.uuid4())
    collection.query.return_value = {
        "ids": [[item_id]],
        "metadatas": [[{"memory": "hello", "metadata": {"status": "activated"}}]],
        "embeddings": [[[0.1, 0.2, 0.3]]],
        "distances": [[0.1]],
    }
    results = vec_db.search([0.1, 0.2, 0.3], top_k=1)
    assert len(results) == 1
    assert isinstance(results[0], VecDBItem)
    # cosine distance 0.1 -> similarity 0.9 (higher is more similar)
    assert results[0].score == pytest.approx(0.9)
    # nested payload is returned verbatim
    assert results[0].payload == {"memory": "hello", "metadata": {"status": "activated"}}


def test_get_by_id(vec_db, collection):
    item_id = str(uuid.uuid4())
    collection.get.return_value = {
        "ids": [item_id],
        "metadatas": [{"memory": "x"}],
        "embeddings": [[0.1, 0.2, 0.3]],
    }
    result = vec_db.get_by_id(item_id)
    assert isinstance(result, VecDBItem)
    assert result.vector == [0.1, 0.2, 0.3]
    assert result.payload == {"memory": "x"}


def test_get_by_id_missing(vec_db, collection):
    collection.get.return_value = {"ids": [], "metadatas": [], "embeddings": []}
    assert vec_db.get_by_id(str(uuid.uuid4())) is None


def test_get_all_paginates(vec_db, collection):
    first = str(uuid.uuid4())
    second = str(uuid.uuid4())
    collection.get.side_effect = [
        {"ids": [first], "metadatas": [{"memory": "a"}], "embeddings": [[0.1, 0.2, 0.3]]},
        {"ids": [second], "metadatas": [{"memory": "b"}], "embeddings": [[0.4, 0.5, 0.6]]},
        {"ids": [], "metadatas": [], "embeddings": []},
    ]
    results = vec_db.get_all(scroll_limit=1)
    assert [r.id for r in results] == [first, second]


def test_count_no_filter(vec_db, collection):
    collection.count.return_value = 7
    assert vec_db.count() == 7


def test_count_with_filter(vec_db, collection):
    collection.get.return_value = {
        "ids": [str(uuid.uuid4())],
        "metadatas": [{"status": "activated"}],
        "embeddings": [[0.1, 0.2, 0.3]],
    }
    assert vec_db.count({"status": "activated"}) == 1


def test_update_vector(vec_db, collection):
    item_id = str(uuid.uuid4())
    vec_db.update(item_id, {"id": item_id, "vector": [0.4, 0.5, 0.6], "payload": {"memory": "y"}})
    collection.update.assert_called_once()
    kwargs = collection.update.call_args.kwargs
    assert kwargs["embeddings"] == [0.4, 0.5, 0.6]


def test_update_metadata_only(vec_db, collection):
    item_id = str(uuid.uuid4())
    vec_db.update(item_id, {"id": item_id, "payload": {"status": "archived"}})
    collection.update.assert_called_once()
    kwargs = collection.update.call_args.kwargs
    assert "embeddings" not in kwargs
    assert kwargs["metadatas"]["status"] == "archived"


def test_delete(vec_db, collection):
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    vec_db.delete(ids)
    collection.delete.assert_called_once_with(ids=ids)


def test_delete_collection(vec_db):
    vec_db.delete_collection("some_collection")
    vec_db.client.delete_collection.assert_called_once_with("some_collection")


def test_euclidean_score_ordering(config, fake_pyseekdb, collection):
    config.config.distance_metric = "euclidean"
    client = fake_pyseekdb.Client.return_value
    client.has_collection.return_value = False
    client.create_collection.return_value = collection
    db = VecDBFactory.from_config(config)
    # For l2, smaller distance must yield a higher score.
    assert db._distance_to_score(0.2) > db._distance_to_score(0.5)
