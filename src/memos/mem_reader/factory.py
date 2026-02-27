from typing import TYPE_CHECKING, Any, ClassVar, Optional

from memos.configs.mem_reader import MemReaderConfigFactory
from memos.mem_reader.base import BaseMemReader
from memos.mem_reader.multi_modal_struct import MultiModalStructMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.mem_reader.strategy_struct import StrategyStructMemReader
from memos.memos_tools.singleton import singleton_factory


if TYPE_CHECKING:
    from memos.graph_dbs.base import BaseGraphDB
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher


class MemReaderFactory(BaseMemReader):
    """Factory class for creating MemReader instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "simple_struct": SimpleStructMemReader,
        "strategy_struct": StrategyStructMemReader,
        "multimodal_struct": MultiModalStructMemReader,
    }

    @classmethod
    @singleton_factory()
    def from_config(
        cls,
        config_factory: MemReaderConfigFactory,
        graph_db: Optional["BaseGraphDB | None"] = None,
        searcher: Optional["Searcher | None"] = None,
    ) -> BaseMemReader:
        """
        Create a MemReader instance from configuration.

        Args:
            config_factory: Configuration factory for the MemReader.
            graph_db: Optional graph database instance for recall operations
                     (deduplication, conflict detection). Can also be set later
                     via reader.set_graph_db().

        Returns:
            Configured MemReader instance.
        """
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        reader_class = cls.backend_to_class[backend]
        reader = reader_class(config_factory.config)

        # Set graph_db if provided (for recall operations)
        if graph_db is not None:
            reader.set_graph_db(graph_db)

        if searcher is not None:
            reader.set_searcher(searcher)

        return reader
