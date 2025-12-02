"""
Base handler for MemOS API handlers.

This module provides the base class for all API handlers, implementing
dependency injection and common functionality.
"""

from typing import Any

from memos.log import get_logger
from memos.mem_scheduler.optimized_scheduler import OptimizedScheduler
from memos.memories.textual.tree_text_memory.retrieve.advanced_searcher import AdvancedSearcher


logger = get_logger(__name__)


class HandlerDependencies:
    """
    Container for handler dependencies.

    This class acts as a dependency injection container, holding all
    shared resources needed by handlers.
    """

    def __init__(
        self,
        llm: Any | None = None,
        naive_mem_cube: Any | None = None,
        mem_reader: Any | None = None,
        mem_scheduler: Any | None = None,
        searcher: Any | None = None,
        embedder: Any | None = None,
        reranker: Any | None = None,
        graph_db: Any | None = None,
        vector_db: Any | None = None,
        internet_retriever: Any | None = None,
        memory_manager: Any | None = None,
        mos_server: Any | None = None,
        feedback_server: Any | None = None,
        **kwargs,
    ):
        """
        Initialize handler dependencies.

        Args:
            llm: Language model instance
            naive_mem_cube: Memory cube instance
            mem_reader: Memory reader instance
            mem_scheduler: Scheduler instance
            embedder: Embedder instance
            reranker: Reranker instance
            graph_db: Graph database instance
            vector_db: Vector database instance
            internet_retriever: Internet retriever instance
            memory_manager: Memory manager instance
            mos_server: MOS server instance
            **kwargs: Additional dependencies
        """
        self.llm = llm
        self.naive_mem_cube = naive_mem_cube
        self.mem_reader = mem_reader
        self.mem_scheduler = mem_scheduler
        self.searcher = searcher
        self.embedder = embedder
        self.reranker = reranker
        self.graph_db = graph_db
        self.vector_db = vector_db
        self.internet_retriever = internet_retriever
        self.memory_manager = memory_manager
        self.mos_server = mos_server
        self.feedback_server = feedback_server

        # Store any additional dependencies
        for key, value in kwargs.items():
            setattr(self, key, value)

    @classmethod
    def from_init_server(cls, components: dict[str, Any]):
        """
        Create dependencies from init_server() return values.

        Args:
            components: Dictionary of components returned by init_server().
                       All components will be automatically unpacked as dependencies.

        Returns:
            HandlerDependencies instance

        Note:
            This method uses **kwargs unpacking, so any new components added to
            init_server() will automatically become available as dependencies
            without modifying this code.
        """
        return cls(**components)


class BaseHandler:
    """
    Base class for all API handlers.

    Provides common functionality and dependency injection for handlers.
    All specific handlers should inherit from this class.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize base handler.

        Args:
            dependencies: HandlerDependencies instance containing all shared resources
        """
        self.deps = dependencies
        self.logger = get_logger(self.__class__.__name__)

    @property
    def llm(self):
        """Get LLM instance."""
        return self.deps.llm

    @property
    def naive_mem_cube(self):
        """Get memory cube instance."""
        return self.deps.naive_mem_cube

    @property
    def mem_reader(self):
        """Get memory reader instance."""
        return self.deps.mem_reader

    @property
    def mem_scheduler(self) -> OptimizedScheduler:
        """Get scheduler instance."""
        return self.deps.mem_scheduler

    @property
    def searcher(self) -> AdvancedSearcher:
        """Get scheduler instance."""
        return self.deps.searcher

    @property
    def embedder(self):
        """Get embedder instance."""
        return self.deps.embedder

    @property
    def reranker(self):
        """Get reranker instance."""
        return self.deps.reranker

    @property
    def graph_db(self):
        """Get graph database instance."""
        return self.deps.graph_db

    @property
    def vector_db(self):
        """Get vector database instance."""
        return self.deps.vector_db

    @property
    def mos_server(self):
        """Get MOS server instance."""
        return self.deps.mos_server

    @property
    def deepsearch_agent(self):
        """Get deepsearch agent instance."""
        return self.deps.deepsearch_agent

    @property
    def feedback_server(self):
        """Get feedback server instance."""
        return self.deps.feedback_server

    def _validate_dependencies(self, *required_deps: str) -> None:
        """
        Validate that required dependencies are available.

        Args:
            *required_deps: Names of required dependency attributes

        Raises:
            ValueError: If any required dependency is None
        """
        missing = []
        for dep_name in required_deps:
            if not hasattr(self.deps, dep_name) or getattr(self.deps, dep_name) is None:
                missing.append(dep_name)

        if missing:
            raise ValueError(
                f"{self.__class__.__name__} requires the following dependencies: {', '.join(missing)}"
            )
