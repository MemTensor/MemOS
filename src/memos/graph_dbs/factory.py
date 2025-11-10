from typing import Any, ClassVar

from memos.configs.graph_db import GraphDBConfigFactory
from memos.graph_dbs.base import BaseGraphDB
from memos.graph_dbs.nebular import NebulaGraphDB
from memos.graph_dbs.neo4j import Neo4jGraphDB
from memos.graph_dbs.neo4j_community import Neo4jCommunityGraphDB
from memos.graph_dbs.polardb import PolarDBGraphDB


class GraphStoreFactory(BaseGraphDB):
    """Factory for creating graph store instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "neo4j": Neo4jGraphDB,
        "neo4j-community": Neo4jCommunityGraphDB,
        "nebular": NebulaGraphDB,
        "polardb": PolarDBGraphDB,
    }

    @classmethod
    def from_config(cls, config_factory: GraphDBConfigFactory) -> BaseGraphDB:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Unsupported graph database backend: {backend}")
        graph_class = cls.backend_to_class[backend]
        return graph_class(config_factory.config)
