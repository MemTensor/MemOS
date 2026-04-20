"""
Add handler for memory addition functionality (Class-based version).

This module provides a class-based implementation of add handlers,
using dependency injection for better modularity and testability.
"""

from pydantic import validate_call

from fastapi import HTTPException

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.middleware.agent_auth import get_authenticated_user
from memos.api.product_models import APIADDRequest, APIFeedbackRequest, MemoryResponse
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.multi_mem_cube.views import MemCubeView
from memos.types import MessageList


# Keys MemOS internals write into metadata.info. User-supplied values for
# these keys are preserved under a "user:<key>" namespace so internal
# bookkeeping (e.g. scheduler merge tracking) is never clobbered.
_RESERVED_INFO_KEYS = frozenset({"merged_from"})


def _namespace_user_info(
    info: dict | None,
) -> tuple[dict, dict[str, str]]:
    """Return a copy of ``info`` with reserved keys renamed to ``user:<key>``.

    Returns:
        (preserved_info, renamed_map) — renamed_map is {original_key: new_key}
        for any collisions that were rewritten (empty when there were none).
    """
    if not info:
        return {}, {}
    preserved: dict = {}
    renamed: dict[str, str] = {}
    for k, v in info.items():
        if k in _RESERVED_INFO_KEYS:
            new_key = f"user:{k}"
            preserved[new_key] = v
            renamed[k] = new_key
        else:
            preserved[k] = v
    return preserved, renamed


class AddHandler(BaseHandler):
    """
    Handler for memory addition operations.

    Handles text memory additions with sync/async support.
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

        Orchestrates the addition of text memories,
        supporting concurrent processing.

        Args:
            add_req: Add memory request (deprecated fields are converted in model validator)

        Returns:
            MemoryResponse with added memory information
        """
        self.logger.info(
            f"[AddHandler] add_memories called: user_id={add_req.user_id}, cubes={add_req.writable_cube_ids}, async_mode={add_req.async_mode}"
        )

        # Auth spoof check: if a key was presented, user_id must match what the key says
        authenticated = get_authenticated_user()
        if authenticated is not None and authenticated != add_req.user_id:
            raise HTTPException(
                status_code=403,
                detail=f"Key authenticated as '{authenticated}' but request claims user_id='{add_req.user_id}'. Spoofing not allowed."
            )

        # Cube isolation: verify user has write access to all requested cubes
        user_manager = getattr(self.deps, "user_manager", None)
        if user_manager:
            cube_ids = self._resolve_cube_ids(add_req)
            for cube_id in cube_ids:
                if not user_manager.validate_user_cube_access(add_req.user_id, cube_id):
                    raise HTTPException(
                        status_code=403,
                        detail=f"Access denied: user '{add_req.user_id}' cannot write to cube '{cube_id}'"
                    )

        # Reject empty or whitespace-only content early
        if add_req.messages is not None:
            all_empty = all(
                not str(msg.get("content", "") if isinstance(msg, dict) else getattr(msg, "content", "")).strip()
                for msg in add_req.messages
            )
            if all_empty:
                raise HTTPException(status_code=400, detail="Message content must not be empty.")
        elif add_req.memory_content is not None and not str(add_req.memory_content).strip():
            raise HTTPException(status_code=400, detail="memory_content must not be empty.")

        if add_req.info:
            # metadata.info is a free-form dict. Only reserved keys written by MemOS
            # internals (see _RESERVED_INFO_KEYS) need collision handling — the prior
            # implementation over-filtered against top-level metadata field names, which
            # dropped legitimate user keys like `source_type` / `topic`.
            add_req.info, renamed = _namespace_user_info(add_req.info)
            if renamed:
                self.logger.warning(
                    f"[AddHandler] Reserved info keys renamed to preserve internal "
                    f"bookkeeping: {renamed}"
                )

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
