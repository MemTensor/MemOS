"""
Feeback handler for memory add/update functionality.
"""

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APIFeedbackRequest, MemoryResponse
from memos.log import get_logger
from memos.multi_mem_cube.composite_cube import CompositeCubeView
from memos.multi_mem_cube.single_cube import SingleCubeView
from memos.multi_mem_cube.views import MemCubeView


logger = get_logger(__name__)


class FeedbackHandler(BaseHandler):
    """
    Handler for memory feedback operations.

    Provides fast, fine-grained, and mixture-based feedback modes.
    """

    def __init__(self, dependencies: HandlerDependencies):
        """
        Initialize feedback handler.

        Args:
            dependencies: HandlerDependencies instance
        """
        super().__init__(dependencies)
        self._validate_dependencies("mem_reader", "mem_scheduler", "searcher", "reranker")

    def handle_feedback_memories(self, feedback_req: APIFeedbackRequest) -> MemoryResponse:
        """
        Main handler for feedback memories endpoint.

        Args:
            feedback_req: feedback request containing content and parameters

        Returns:
            MemoryResponse with formatted results
        """
        cube_view = self._build_cube_view(feedback_req)

        process_record = cube_view.feedback_memories(feedback_req)

        self.logger.info(f"[FeedbackHandler] Final feedback results count={len(process_record)}")

        return MemoryResponse(
            message="Memory feedback successfully",
            data=[process_record],
        )

    def _resolve_cube_ids(self, feedback_req: APIFeedbackRequest) -> list[str]:
        """
        Normalize target cube ids from feedback_req.
        """
        if feedback_req.writable_cube_ids:
            return list(dict.fromkeys(feedback_req.writable_cube_ids))

        return [feedback_req.user_id]

    def _build_cube_view(self, feedback_req: APIFeedbackRequest) -> MemCubeView:
        cube_ids = self._resolve_cube_ids(feedback_req)

        if len(cube_ids) == 1:
            cube_id = cube_ids[0]
            return SingleCubeView(
                cube_id=cube_id,
                naive_mem_cube=None,
                mem_reader=None,
                mem_scheduler=self.mem_scheduler,
                logger=self.logger,
                searcher=None,
                feedback_server=self.feedback_server,
            )
        else:
            single_views = [
                SingleCubeView(
                    cube_id=cube_id,
                    naive_mem_cube=None,
                    mem_reader=None,
                    mem_scheduler=self.mem_scheduler,
                    logger=self.logger,
                    searcher=None,
                    feedback_server=self.feedback_server,
                )
                for cube_id in cube_ids
            ]
            return CompositeCubeView(
                cube_views=single_views,
                logger=self.logger,
            )
