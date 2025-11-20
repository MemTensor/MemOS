"""
Feeback handler for memory add/update functionality.
"""

from memos.api.handlers.base_handler import BaseHandler, HandlerDependencies
from memos.api.product_models import APIFeedbackRequest, MemoryResponse
from memos.log import get_logger


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
        self._validate_dependencies("feedback_server", "mem_reader")

    def handle_feedback_memories(self, feedback_req: APIFeedbackRequest) -> MemoryResponse:
        """
        Main handler for feedback memories endpoint.

        Args:
            feedback_req: feedback request containing content and parameters

        Returns:
            MemoryResponse with formatted results
        """
        process_record = self.feedback_server.process_feedback(
            user_name=feedback_req.mem_cube_id,
            session_id=feedback_req.session_id,
            chat_history=feedback_req.history,
            retrieved_memory_ids=feedback_req.retrieved_memory_ids,
            feedback_content=feedback_req.feedback_content,
            feedback_time=feedback_req.feedback_time,
            allow_knowledgebase_write=feedback_req.allow_knowledgebase_write,
            sync_mode=feedback_req.sync_mode,
            corrected_answer=feedback_req.corrected_answer,
        )

        return MemoryResponse(message="Feedback process successfully", data=[process_record])
