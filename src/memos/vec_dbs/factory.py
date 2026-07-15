from typing import Any, ClassVar

from memos.configs.vec_db import VectorDBConfigFactory
from memos.vec_dbs.base import BaseVecDB
from memos.vec_dbs.milvus import MilvusVecDB
from memos.vec_dbs.qdrant import QdrantVecDB


class VecDBFactory(BaseVecDB):
    """Factory class for creating Vector Database instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "qdrant": QdrantVecDB,
        "milvus": MilvusVecDB,
    }

    @classmethod
    def from_config(cls, config_factory: VectorDBConfigFactory) -> BaseVecDB:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        vec_db_class = cls.backend_to_class[backend]
        return vec_db_class(config_factory.config)
