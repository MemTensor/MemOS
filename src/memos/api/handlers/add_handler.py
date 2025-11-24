"""
Add handler for memory addition functionality (Class-based version).

This module provides a class-based implementation of add handlers,
using dependency injection for better modularity and testability.
"""

from datetime import datetime

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APIADDRequest, MemoryResponse
from memos.memories.textual.item import (
    list_all_fields,
)
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
            add_req: Add memory request

        Returns:
            MemoryResponse with added memory information
        """
        self.logger.info(f"[AddHandler] Add Req is: {add_req}")

        if (not add_req.messages) and getattr(add_req, "memory_content", None):
            add_req.messages = self._convert_content_messsage(add_req.memory_content)
            self.logger.info(f"[AddHandler] Converted content to messages: {add_req.messages}")

        if add_req.info:
            exclude_fields = list_all_fields()
            info_len = len(add_req.info)
            add_req.info = {k: v for k, v in add_req.info.items() if k not in exclude_fields}
            if len(add_req.info) < info_len:
                self.logger.warning(f"[AddHandler] info fields can not contain {exclude_fields}.")

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
        1) writable_cube_ids
        2) mem_cube_id
        3) fallback to user_id
        """
        if getattr(add_req, "writable_cube_ids", None):
            return list(dict.fromkeys(add_req.writable_cube_ids))

        if add_req.mem_cube_id:
            return [add_req.mem_cube_id]

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

    def _convert_content_messsage(self, memory_content: str) -> list[dict[str, str]]:
        """
        Convert content string to list of message dictionaries.

        Args:
            content: add content string

        Returns:
            List of message dictionaries
        """
        messages_list = [
            {
                "role": "user",
                "content": memory_content,
                "chat_time": str(datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            }
        ]
        # for only user-str input and convert message
        return messages_list
