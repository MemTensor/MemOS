from __future__ import annotations

import json

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import (
    LONG_TERM_MEMORY_TYPE,
    MEM_FEEDBACK_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.mem_scheduler.utils.misc_utils import is_cloud_env


logger = get_logger(__name__)

if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem


class FeedbackMessageHandler(BaseSchedulerHandler):
    @property
    def expected_task_label(self) -> str:
        return MEM_FEEDBACK_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        for message in batch:
            try:
                self.process_single_feedback(message)
            except Exception as e:
                logger.error(
                    "Error processing feedbackMemory message: %s",
                    e,
                    exc_info=True,
                )

    def process_single_feedback(self, message: ScheduleMessageItem) -> None:
        mem_cube = self.scheduler_context.get_mem_cube()

        user_id = message.user_id
        mem_cube_id = message.mem_cube_id
        content = message.content

        try:
            feedback_data = json.loads(content) if isinstance(content, str) else content
            if not isinstance(feedback_data, dict):
                logger.error(
                    "Failed to decode feedback_data or it is not a dict: %s", feedback_data
                )
                return
        except json.JSONDecodeError:
            logger.error("Invalid JSON content for feedback message: %s", content, exc_info=True)
            return

        task_id = feedback_data.get("task_id") or message.task_id
        feedback_result = self.scheduler_context.get_feedback_server().process_feedback(
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

        logger.info(
            "Successfully processed feedback for user_id=%s, mem_cube_id=%s",
            user_id,
            mem_cube_id,
        )

        cloud_env = is_cloud_env()
        if cloud_env:
            record = feedback_result.get("record") if isinstance(feedback_result, dict) else {}
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
                mem_id, mem_memory, original_content, source_doc_id = _extract_fields(mem_item)
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

            logger.info("[Feedback Scheduler] kb_log_content: %s", kb_log_content)
            if kb_log_content:
                logger.info(
                    "[DIAGNOSTIC] feedback_handler: Creating knowledgeBaseUpdate event for feedback. user_id=%s mem_cube_id=%s task_id=%s items=%s",
                    user_id,
                    mem_cube_id,
                    task_id,
                    len(kb_log_content),
                )
                event = self.scheduler_context.services.create_event_log(
                    label="knowledgeBaseUpdate",
                    from_memory_type=USER_INPUT_TYPE,
                    to_memory_type=LONG_TERM_MEMORY_TYPE,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    memcube_log_content=kb_log_content,
                    metadata=None,
                    memory_len=len(kb_log_content),
                    memcube_name=self.scheduler_context.services.map_memcube_name(mem_cube_id),
                )
                event.log_content = f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
                event.task_id = task_id
                self.scheduler_context.services.submit_web_logs([event])
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
