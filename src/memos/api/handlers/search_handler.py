"""
Search handler for memory search functionality (Class-based version).

This module provides a class-based implementation of search handlers,
using dependency injection for better modularity and testability.
"""

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APISearchRequest, SearchResponse
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.multi_mem_cube.views import MemCubeView


class SearchHandler(BaseHandler):
    """
    Handler for memory search operations.

    Provides fast, fine-grained, and mixture-based search modes.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize search handler.

        Args:
            dependencies: HandlerDependencies instance
        """
        super().__init__(dependencies)
        self._validate_dependencies("naive_mem_cube", "mem_scheduler")

    def handle_search_memories(self, search_req: APISearchRequest) -> SearchResponse:
        """
        Main handler for search memories endpoint.

        Orchestrates the search process based on the requested search mode,
        supporting both text and preference memory searches.

        Args:
            search_req: Search request containing query and parameters

        Returns:
            SearchResponse with formatted results
        """
        self.logger.info(f"[SearchHandler] Search Req is: {search_req}")

        cube_view = self._build_cube_view(search_req)

        results = cube_view.search_memories(search_req)

        self.logger.info(f"[AddHandler] Final add results count={len(results)}")

        return SearchResponse(
            message="Memory searched successfully",
            data=results,
        )

    def _resolve_cube_ids(self, search_req: APISearchRequest) -> list[str]:
        """
        Normalize target cube ids from search_req.
        Priority:
        1) readable_cube_ids
        2) mem_cube_id
        3) fallback to user_id
        """
        if getattr(search_req, "readable_cube_ids", None):
            return list(dict.fromkeys(search_req.readable_cube_ids))

        if search_req.mem_cube_id:
            return [search_req.mem_cube_id]

        return [search_req.user_id]

    def _build_cube_view(self, search_req: APISearchRequest) -> MemCubeView:
        cube_ids = self._resolve_cube_ids(search_req)

        if len(cube_ids) == 1:
            cube_id = cube_ids[0]
            return SingleCubeView(
                cube_id=cube_id,
                naive_mem_cube=self.naive_mem_cube,
                mem_reader=self.mem_reader,
                mem_scheduler=self.mem_scheduler,
                logger=self.logger,
            )
        else:
            single_views = [
                SingleCubeView(
                    cube_id=cube_id,
                    naive_mem_cube=self.naive_mem_cube,
                    mem_reader=self.mem_reader,
                    mem_scheduler=self.mem_scheduler,
                    logger=self.logger,
                )
                for cube_id in cube_ids
            ]
            return CompositeCubeView(cube_views=single_views, logger=self.logger)
