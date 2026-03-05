"""
Add handler for memory addition functionality (Class-based version).

This module provides a class-based implementation of add handlers,
using dependency injection for better modularity and testability.
"""

from pydantic import validate_call

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APIADDRequest, APIFeedbackRequest, MemoryResponse
from memos.memories.textual.item import (
    list_all_fields,
)
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.multi_mem_cube.views import MemCubeView
from memos.types import MessageList


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
        self._validate_dependencies(
            "naive_mem_cube", "mem_reader", "mem_scheduler", "feedback_server"
        )

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
        self.logger.info(
            f"[DIAGNOSTIC] server_router -> add_handler.handle_add_memories called (Modified at 2025-11-29 18:46). Full request: {add_req.model_dump_json(indent=2)}"
        )

        if add_req.info:
            exclude_fields = list_all_fields()
            info_len = len(add_req.info)
            add_req.info = {k: v for k, v in add_req.info.items() if k not in exclude_fields}
            if len(add_req.info) < info_len:
                self.logger.warning(f"[AddHandler] info fields can not contain {exclude_fields}.")

        cube_view = self._build_cube_view(add_req)

        @validate_call
        def _check_messages(messages: MessageList) -> None:
            pass

        if add_req.is_feedback:
            try:
                messages = add_req.messages
                _check_messages(messages)

                chat_history = add_req.chat_history if add_req.chat_history else []
                concatenate_chat = chat_history + messages

                last_user_index = max(
                    i for i, d in enumerate(concatenate_chat) if d["role"] == "user"
                )
                feedback_content = concatenate_chat[last_user_index]["content"]
                feedback_history = concatenate_chat[:last_user_index]

                feedback_req = APIFeedbackRequest(
                    user_id=add_req.user_id,
                    session_id=add_req.session_id,
                    task_id=add_req.task_id,
                    history=feedback_history,
                    feedback_content=feedback_content,
                    writable_cube_ids=add_req.writable_cube_ids,
                    async_mode=add_req.async_mode,
                    info=add_req.info,
                )
                process_record = cube_view.feedback_memories(feedback_req)

                self.logger.info(
                    f"[ADDFeedbackHandler] Final feedback results count={len(process_record)}"
                )

                return MemoryResponse(
                    message="Memory feedback successfully",
                    data=[process_record],
                )
            except Exception as e:
                self.logger.warning(f"[ADDFeedbackHandler] Running error: {e}")

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
                feedback_server=self.feedback_server,
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
                    feedback_server=self.feedback_server,
                    searcher=None,
                )
                for cube_id in cube_ids
            ]
            return CompositeCubeView(
                cube_views=single_views,
                logger=self.logger,
            )
