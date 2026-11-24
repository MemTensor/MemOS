from typing import Any, ClassVar

from memos.configs.project_db import ProjectDBConfigFactory
from memos.project_dbs.base import BaseProjectDB
from memos.project_dbs.postgres import PostgresProjectDB


class ProjectDBFactory:
    """Factory for creating project memory storage instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "postgres": PostgresProjectDB,
    }

    @classmethod
    def from_config(cls, config_factory: ProjectDBConfigFactory) -> BaseProjectDB:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Unsupported project db backend: {backend}")
        return cls.backend_to_class[backend](config_factory.config)
