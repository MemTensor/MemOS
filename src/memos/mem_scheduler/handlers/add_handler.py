from __future__ import annotations

import json

from memos.log import get_logger
from memos.mem_scheduler.handlers.base import BaseSchedulerHandler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    LONG_TERM_MEMORY_TYPE,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.utils.filter_utils import transform_name_to_key
from memos.mem_scheduler.utils.misc_utils import group_messages_by_user_and_mem_cube, is_cloud_env
from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


class AddMessageHandler(BaseSchedulerHandler):
    def handle(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {ADD_TASK_LABEL} handler.")
        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)

        self.ctx.services.validate_messages(messages=messages, label=ADD_TASK_LABEL)
        try:
            for user_id in grouped_messages:
                for mem_cube_id in grouped_messages[user_id]:
                    batch = grouped_messages[user_id][mem_cube_id]
                    if not batch:
                        continue

                    for msg in batch:
                        prepared_add_items, prepared_update_items_with_original = (
                            self.log_add_messages(msg=msg)
                        )
                        logger.info(
                            "prepared_add_items: %s;\n prepared_update_items_with_original: %s",
                            prepared_add_items,
                            prepared_update_items_with_original,
                        )
                        cloud_env = is_cloud_env()

                        if cloud_env:
                            self.send_add_log_messages_to_cloud_env(
                                msg, prepared_add_items, prepared_update_items_with_original
                            )
                        else:
                            self.send_add_log_messages_to_local_env(
                                msg, prepared_add_items, prepared_update_items_with_original
                            )

        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)

    def log_add_messages(self, msg: ScheduleMessageItem):
        try:
            userinput_memory_ids = json.loads(msg.content)
        except Exception as e:
            logger.error(f"Error: {e}. Content: {msg.content}", exc_info=True)
            userinput_memory_ids = []

        prepared_add_items = []
        prepared_update_items_with_original = []
        missing_ids: list[str] = []

        mem_cube = self.ctx.get_mem_cube()

        for memory_id in userinput_memory_ids:
            try:
                mem_item: TextualMemoryItem | None = None
                mem_item = mem_cube.text_mem.get(memory_id=memory_id, user_name=msg.mem_cube_id)
                if mem_item is None:
                    raise ValueError(f"Memory {memory_id} not found after retries")
                key = getattr(mem_item.metadata, "key", None) or transform_name_to_key(
                    name=mem_item.memory
                )
                exists = False
                original_content = None
                original_item_id = None

                if key and hasattr(mem_cube.text_mem, "graph_store"):
                    candidates = mem_cube.text_mem.graph_store.get_by_metadata(
                        [
                            {"field": "key", "op": "=", "value": key},
                            {
                                "field": "memory_type",
                                "op": "=",
                                "value": mem_item.metadata.memory_type,
                            },
                        ]
                    )
                    if candidates:
                        exists = True
                        original_item_id = candidates[0]
                        original_mem_item = mem_cube.text_mem.get(
                            memory_id=original_item_id, user_name=msg.mem_cube_id
                        )
                        original_content = original_mem_item.memory

                if exists:
                    prepared_update_items_with_original.append(
                        {
                            "new_item": mem_item,
                            "original_content": original_content,
                            "original_item_id": original_item_id,
                        }
                    )
                else:
                    prepared_add_items.append(mem_item)

            except Exception:
                missing_ids.append(memory_id)
                logger.debug(
                    "This MemoryItem %s has already been deleted or an error occurred during preparation.",
                    memory_id,
                )

        if missing_ids:
            content_preview = (
                msg.content[:200] + "..."
                if isinstance(msg.content, str) and len(msg.content) > 200
                else msg.content
            )
            logger.warning(
                "Missing TextualMemoryItem(s) during add log preparation. "
                "memory_ids=%s user_id=%s mem_cube_id=%s task_id=%s item_id=%s redis_msg_id=%s label=%s stream_key=%s content_preview=%s",
                missing_ids,
                msg.user_id,
                msg.mem_cube_id,
                msg.task_id,
                msg.item_id,
                getattr(msg, "redis_message_id", ""),
                msg.label,
                getattr(msg, "stream_key", ""),
                content_preview,
            )

        if not prepared_add_items and not prepared_update_items_with_original:
            logger.warning(
                "No add/update items prepared; skipping addMemory/knowledgeBaseUpdate logs. "
                "user_id=%s mem_cube_id=%s task_id=%s item_id=%s redis_msg_id=%s label=%s stream_key=%s missing_ids=%s",
                msg.user_id,
                msg.mem_cube_id,
                msg.task_id,
                msg.item_id,
                getattr(msg, "redis_message_id", ""),
                msg.label,
                getattr(msg, "stream_key", ""),
                missing_ids,
            )
        return prepared_add_items, prepared_update_items_with_original

    def send_add_log_messages_to_local_env(
        self,
        msg: ScheduleMessageItem,
        prepared_add_items,
        prepared_update_items_with_original,
    ) -> None:
        add_content_legacy: list[dict] = []
        add_meta_legacy: list[dict] = []
        update_content_legacy: list[dict] = []
        update_meta_legacy: list[dict] = []

        for item in prepared_add_items:
            key = getattr(item.metadata, "key", None) or transform_name_to_key(name=item.memory)
            add_content_legacy.append({"content": f"{key}: {item.memory}", "ref_id": item.id})
            add_meta_legacy.append(
                {
                    "ref_id": item.id,
                    "id": item.id,
                    "key": item.metadata.key,
                    "memory": item.memory,
                    "memory_type": item.metadata.memory_type,
                    "status": item.metadata.status,
                    "confidence": item.metadata.confidence,
                    "tags": item.metadata.tags,
                    "updated_at": getattr(item.metadata, "updated_at", None)
                    or getattr(item.metadata, "update_at", None),
                }
            )

        for item_data in prepared_update_items_with_original:
            item = item_data["new_item"]
            key = getattr(item.metadata, "key", None) or transform_name_to_key(name=item.memory)
            update_content_legacy.append({"content": f"{key}: {item.memory}", "ref_id": item.id})
            update_meta_legacy.append(
                {
                    "ref_id": item.id,
                    "id": item.id,
                    "key": item.metadata.key,
                    "memory": item.memory,
                    "memory_type": item.metadata.memory_type,
                    "status": item.metadata.status,
                    "confidence": item.metadata.confidence,
                    "tags": item.metadata.tags,
                    "updated_at": getattr(item.metadata, "updated_at", None)
                    or getattr(item.metadata, "update_at", None),
                }
            )

        events = []
        if add_content_legacy:
            event = self.ctx.services.create_event_log(
                label="addMemory",
                from_memory_type=USER_INPUT_TYPE,
                to_memory_type=LONG_TERM_MEMORY_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.ctx.get_mem_cube(),
                memcube_log_content=add_content_legacy,
                metadata=add_meta_legacy,
                memory_len=len(add_content_legacy),
                memcube_name=self.ctx.services.map_memcube_name(msg.mem_cube_id),
            )
            event.task_id = msg.task_id
            events.append(event)
        if update_content_legacy:
            event = self.ctx.services.create_event_log(
                label="updateMemory",
                from_memory_type=LONG_TERM_MEMORY_TYPE,
                to_memory_type=LONG_TERM_MEMORY_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.ctx.get_mem_cube(),
                memcube_log_content=update_content_legacy,
                metadata=update_meta_legacy,
                memory_len=len(update_content_legacy),
                memcube_name=self.ctx.services.map_memcube_name(msg.mem_cube_id),
            )
            event.task_id = msg.task_id
            events.append(event)
        logger.info("send_add_log_messages_to_local_env: %s", len(events))
        if events:
            self.ctx.services.submit_web_logs(events, additional_log_info="send_add_log_messages_to_cloud_env")

    def send_add_log_messages_to_cloud_env(
        self,
        msg: ScheduleMessageItem,
        prepared_add_items,
        prepared_update_items_with_original,
    ) -> None:
        kb_log_content: list[dict] = []
        info = msg.info or {}

        for item in prepared_add_items:
            metadata = getattr(item, "metadata", None)
            file_ids = getattr(metadata, "file_ids", None) if metadata else None
            source_doc_id = file_ids[0] if isinstance(file_ids, list) and file_ids else None
            kb_log_content.append(
                {
                    "log_source": "KNOWLEDGE_BASE_LOG",
                    "trigger_source": info.get("trigger_source", "Messages"),
                    "operation": "ADD",
                    "memory_id": item.id,
                    "content": item.memory,
                    "original_content": None,
                    "source_doc_id": source_doc_id,
                }
            )

        for item_data in prepared_update_items_with_original:
            item = item_data["new_item"]
            metadata = getattr(item, "metadata", None)
            file_ids = getattr(metadata, "file_ids", None) if metadata else None
            source_doc_id = file_ids[0] if isinstance(file_ids, list) and file_ids else None
            kb_log_content.append(
                {
                    "log_source": "KNOWLEDGE_BASE_LOG",
                    "trigger_source": info.get("trigger_source", "Messages"),
                    "operation": "UPDATE",
                    "memory_id": item.id,
                    "content": item.memory,
                    "original_content": item_data.get("original_content"),
                    "source_doc_id": source_doc_id,
                }
            )

        if kb_log_content:
            logger.info(
                "[DIAGNOSTIC] add_handler.send_add_log_messages_to_cloud_env: Creating event log for KB update. Label: knowledgeBaseUpdate, user_id: %s, mem_cube_id: %s, task_id: %s. KB content: %s",
                msg.user_id,
                msg.mem_cube_id,
                msg.task_id,
                json.dumps(kb_log_content, indent=2),
            )
            event = self.ctx.services.create_event_log(
                label="knowledgeBaseUpdate",
                from_memory_type=USER_INPUT_TYPE,
                to_memory_type=LONG_TERM_MEMORY_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.ctx.get_mem_cube(),
                memcube_log_content=kb_log_content,
                metadata=None,
                memory_len=len(kb_log_content),
                memcube_name=self.ctx.services.map_memcube_name(msg.mem_cube_id),
            )
            event.log_content = f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
            event.task_id = msg.task_id
            self.ctx.services.submit_web_logs([event])
