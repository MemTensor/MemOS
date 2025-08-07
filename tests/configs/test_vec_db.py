from memos.configs.vec_db import (
    BaseVecDBConfig,
    ChromaVecDBConfig,
    QdrantVecDBConfig,
    VectorDBConfigFactory,
)
from tests.utils import (
    check_config_base_class,
    check_config_instantiation_invalid,
    check_config_instantiation_valid,
)


def test_base_vec_db_config():
    check_config_base_class(
        BaseVecDBConfig,
        required_fields=[
            "collection_name",
        ],
        optional_fields=[
            "vector_dimension",
            "distance_metric",
        ],
    )

    check_config_instantiation_valid(
        BaseVecDBConfig,
        {
            "collection_name": "test_collection",
            "vector_dimension": 768,
            "distance_metric": "cosine",
        },
    )

    check_config_instantiation_invalid(BaseVecDBConfig)


def test_qdrant_vec_db_config():
    check_config_base_class(
        QdrantVecDBConfig,
        required_fields=[
            "collection_name",
        ],
        optional_fields=["vector_dimension", "distance_metric", "host", "port", "path"],
    )

    check_config_instantiation_valid(
        QdrantVecDBConfig,
        {
            "collection_name": "test_collection",
            "vector_dimension": 768,
            "distance_metric": "cosine",
            "path": "/custom/path",
        },
    )

    check_config_instantiation_invalid(QdrantVecDBConfig)


def test_chroma_vec_db_config():
    check_config_base_class(
        ChromaVecDBConfig,
        required_fields=[
            "collection_name",
        ],
        optional_fields=[
            "vector_dimension",
            "distance_metric",
            "host",
            "port",
            "path",
            "username",
            "password",
            "database",
            "tenant",
            "ssl",
        ],
    )

    check_config_instantiation_valid(
        ChromaVecDBConfig,
        {
            "collection_name": "test_collection",
            "vector_dimension": 768,
            "distance_metric": "cosine",
            "path": "/custom/path",
            "database": "test_db",
            "tenant": "test_tenant",
        },
    )

    check_config_instantiation_invalid(ChromaVecDBConfig)


def test_vector_db_config_factory():
    check_config_base_class(
        VectorDBConfigFactory,
        required_fields=[
            "backend",
            "config",
        ],
        optional_fields=[],
    )

    check_config_instantiation_valid(
        VectorDBConfigFactory,
        {
            "backend": "qdrant",
            "config": {
                "collection_name": "test_collection",
                "vector_dimension": 768,
                "distance_metric": "cosine",
            },
        },
    )

    check_config_instantiation_invalid(VectorDBConfigFactory)
