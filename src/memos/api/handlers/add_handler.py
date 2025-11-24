"""
Add handler for memory addition functionality (Class-based version).

This module provides a class-based implementation of add handlers,
using dependency injection for better modularity and testability.
"""

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APIADDRequest, MemoryResponse
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.multi_mem_cube.views import MemCubeView


class AddHandler(BaseHandler):
    """
    Handler for memory addition operations.

    Handles both text and preference memory additions with sync/async support.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize add handler.

        Args:
            dependencies: HandlerDependencies instance
        """
        super().__init__(dependencies)
        self._validate_dependencies("naive_mem_cube", "mem_reader", "mem_scheduler")

    def handle_add_memories(self, add_req: APIADDRequest) -> MemoryResponse:
        """
        Main handler for add memories endpoint.

        Orchestrates the addition of both text and preference memories,
        supporting concurrent processing.

        Args:
            add_req: Add memory request (deprecated fields are converted in model validator)

        Returns:
            MemoryResponse with added memory information
        """
        self.logger.info(f"[AddHandler] Add Req is: {add_req}")

        cube_view = self._build_cube_view(add_req)

        results = cube_view.add_memories(add_req)

        self.logger.info(f"[AddHandler] Final add results count={len(results)}")

        return MemoryResponse(
            message="Memory added successfully",
            data=results,
        )

    def _resolve_cube_ids(self, add_req: APIADDRequest) -> list[str]:
        """
        Normalize target cube ids from add_req.
        Priority:
        1) writable_cube_ids (deprecated mem_cube_id is converted to this in model validator)
        2) fallback to user_id
        """
        if add_req.writable_cube_ids:
            return list(dict.fromkeys(add_req.writable_cube_ids))

        return [add_req.user_id]

    def _build_cube_view(self, add_req: APIADDRequest) -> MemCubeView:
        cube_ids = self._resolve_cube_ids(add_req)

        if len(cube_ids) == 1:
            cube_id = cube_ids[0]
            return SingleCubeView(
                cube_id=cube_id,
                naive_mem_cube=self.naive_mem_cube,
                mem_reader=self.mem_reader,
                mem_scheduler=self.mem_scheduler,
                logger=self.logger,
                searcher=None,
            )
        else:
            single_views = [
                SingleCubeView(
                    cube_id=cube_id,
                    naive_mem_cube=self.naive_mem_cube,
                    mem_reader=self.mem_reader,
                    mem_scheduler=self.mem_scheduler,
                    logger=self.logger,
                    searcher=None,
                )
                for cube_id in cube_ids
            ]
            return CompositeCubeView(
                cube_views=single_views,
                logger=self.logger,
            )
