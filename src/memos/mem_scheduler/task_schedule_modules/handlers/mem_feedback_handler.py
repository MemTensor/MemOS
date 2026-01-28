import json

from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    LONG_TERM_MEMORY_TYPE,
    MEM_FEEDBACK_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler
from memos.mem_scheduler.utils.misc_utils import is_cloud_env


logger = get_logger(__name__)


class MemFeedbackHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = MEM_FEEDBACK_TASK_LABEL

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        try:
            for message in batch:
                mem_cube = self.context.mem_cube

                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                content = message.content

                try:
                    feedback_data = json.loads(content) if isinstance(content, str) else content
                    if not isinstance(feedback_data, dict):
                        logger.error(
                            f"Failed to decode feedback_data or it is not a dict: {feedback_data}"
                        )
                        continue
                except json.JSONDecodeError:
                    logger.error(
                        f"Invalid JSON content for feedback message: {content}", exc_info=True
                    )
                    continue

                task_id = feedback_data.get("task_id") or message.task_id

                if self.context.feedback_server:
                    feedback_result = self.context.feedback_server.process_feedback(
                        user_id=user_id,
                        user_name=mem_cube_id,
                        session_id=feedback_data.get("session_id"),
                        chat_history=feedback_data.get("history", []),
                        retrieved_memory_ids=feedback_data.get("retrieved_memory_ids", []),
                        feedback_content=feedback_data.get("feedback_content"),
                        feedback_time=feedback_data.get("feedback_time"),
                        task_id=task_id,
                        info=feedback_data.get("info", None),
                    )
                else:
                    logger.error("feedback_server not available in context")
                    continue

                logger.info(
                    f"Successfully processed feedback for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

                cloud_env = is_cloud_env()
                if cloud_env:
                    record = (
                        feedback_result.get("record") if isinstance(feedback_result, dict) else {}
                    )
                    add_records = record.get("add") if isinstance(record, dict) else []
                    update_records = record.get("update") if isinstance(record, dict) else []

                    def _extract_fields(mem_item):
                        mem_id = (
                            getattr(mem_item, "id", None)
                            if not isinstance(mem_item, dict)
                            else mem_item.get("id")
                        )
                        mem_memory = (
                            getattr(mem_item, "memory", None)
                            if not isinstance(mem_item, dict)
                            else mem_item.get("memory") or mem_item.get("text")
                        )
                        if mem_memory is None and isinstance(mem_item, dict):
                            mem_memory = mem_item.get("text")
                        original_content = (
                            getattr(mem_item, "origin_memory", None)
                            if not isinstance(mem_item, dict)
                            else mem_item.get("origin_memory")
                            or mem_item.get("old_memory")
                            or mem_item.get("original_content")
                        )
                        source_doc_id = None
                        if isinstance(mem_item, dict):
                            source_doc_id = mem_item.get("source_doc_id", None)

                        return mem_id, mem_memory, original_content, source_doc_id

                    kb_log_content: list[dict] = []

                    for mem_item in add_records or []:
                        mem_id, mem_memory, _, source_doc_id = _extract_fields(mem_item)
                        if mem_id and mem_memory:
                            kb_log_content.append(
                                {
                                    "log_source": "KNOWLEDGE_BASE_LOG",
                                    "trigger_source": "Feedback",
                                    "operation": "ADD",
                                    "memory_id": mem_id,
                                    "content": mem_memory,
                                    "original_content": None,
                                    "source_doc_id": source_doc_id,
                                }
                            )
                        else:
                            logger.warning(
                                "Skipping malformed feedback add item. user_id=%s mem_cube_id=%s task_id=%s item=%s",
                                user_id,
                                mem_cube_id,
                                task_id,
                                mem_item,
                                stack_info=True,
                            )

                    for mem_item in update_records or []:
                        mem_id, mem_memory, original_content, source_doc_id = _extract_fields(
                            mem_item
                        )
                        if mem_id and mem_memory:
                            kb_log_content.append(
                                {
                                    "log_source": "KNOWLEDGE_BASE_LOG",
                                    "trigger_source": "Feedback",
                                    "operation": "UPDATE",
                                    "memory_id": mem_id,
                                    "content": mem_memory,
                                    "original_content": original_content,
                                    "source_doc_id": source_doc_id,
                                }
                            )
                        else:
                            logger.warning(
                                "Skipping malformed feedback update item. user_id=%s mem_cube_id=%s task_id=%s item=%s",
                                user_id,
                                mem_cube_id,
                                task_id,
                                mem_item,
                                stack_info=True,
                            )

                    logger.info(f"[Feedback Scheduler] kb_log_content: {kb_log_content!s}")
                    if kb_log_content:
                        if self.context.create_event_log and self.context.submit_web_logs:
                            logger.info(
                                "[DIAGNOSTIC] general_scheduler._mem_feedback_message_consumer: Creating knowledgeBaseUpdate event for feedback. user_id=%s mem_cube_id=%s task_id=%s items=%s",
                                user_id,
                                mem_cube_id,
                                task_id,
                                len(kb_log_content),
                            )
                            event = self.context.create_event_log(
                                label="knowledgeBaseUpdate",
                                from_memory_type=USER_INPUT_TYPE,
                                to_memory_type=LONG_TERM_MEMORY_TYPE,
                                user_id=user_id,
                                mem_cube_id=mem_cube_id,
                                mem_cube=mem_cube,
                                memcube_log_content=kb_log_content,
                                metadata=None,
                                memory_len=len(kb_log_content),
                                memcube_name=self.context.map_memcube_name(mem_cube_id)
                                if self.context.map_memcube_name
                                else None,
                            )
                            event.log_content = (
                                f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
                            )
                            event.task_id = task_id
                            self.context.submit_web_logs([event])
                    else:
                        logger.warning(
                            "No valid feedback content generated for web log. user_id=%s mem_cube_id=%s task_id=%s",
                            user_id,
                            mem_cube_id,
                            task_id,
                            stack_info=True,
                        )
                else:
                    logger.info(
                        "Skipping web log for feedback. Not in a cloud environment (is_cloud_env=%s)",
                        cloud_env,
                    )

        except Exception as e:
            self.handle_exception(e, "Error processing feedbackMemory message")
