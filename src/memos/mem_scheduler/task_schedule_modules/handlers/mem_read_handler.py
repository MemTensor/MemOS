from __future__ import annotations

import concurrent.futures
import contextlib
import json
import traceback

from typing import TYPE_CHECKING

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_scheduler.schemas.task_schemas import (
    LONG_TERM_MEMORY_TYPE,
    MEM_READ_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseSchedulerHandler
from memos.mem_scheduler.utils.filter_utils import transform_name_to_key
from memos.mem_scheduler.utils.misc_utils import is_cloud_env
from memos.memories.textual.tree import TreeTextMemory


logger = get_logger(__name__)

if TYPE_CHECKING:
    from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
    from memos.types.general_types import UserContext


class MemReadMessageHandler(BaseSchedulerHandler):
    @property
    def expected_task_label(self) -> str:
        return MEM_READ_TASK_LABEL

    def batch_handler(
        self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]
    ) -> None:
        logger.info(
            "[DIAGNOSTIC] mem_read_handler batch_handler called. Batch size: %s", len(batch)
        )

        with ContextThreadPoolExecutor(max_workers=min(8, len(batch))) as executor:
            futures = [executor.submit(self.process_message, msg) for msg in batch]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error("Thread task failed: %s", e, stack_info=True)

    def process_message(self, message: ScheduleMessageItem):
        try:
            user_id = message.user_id
            mem_cube_id = message.mem_cube_id
            mem_cube = self.scheduler_context.get_mem_cube()
            if mem_cube is None:
                logger.error(
                    "mem_cube is None for user_id=%s, mem_cube_id=%s, skipping processing",
                    user_id,
                    mem_cube_id,
                    stack_info=True,
                )
                return

            content = message.content
            user_name = message.user_name
            info = message.info or {}
            chat_history = message.chat_history
            user_context = message.user_context

            mem_ids = json.loads(content) if isinstance(content, str) else content
            if not mem_ids:
                return

            logger.info(
                "Processing mem_read for user_id=%s, mem_cube_id=%s, mem_ids=%s",
                user_id,
                mem_cube_id,
                mem_ids,
            )

            text_mem = mem_cube.text_mem
            if not isinstance(text_mem, TreeTextMemory):
                logger.error("Expected TreeTextMemory but got %s", type(text_mem).__name__)
                return

            self._process_memories_with_reader(
                mem_ids=mem_ids,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                text_mem=text_mem,
                user_name=user_name,
                custom_tags=info.get("custom_tags", None),
                task_id=message.task_id,
                info=info,
                chat_history=chat_history,
                user_context=user_context,
            )

            logger.info(
                "Successfully processed mem_read for user_id=%s, mem_cube_id=%s",
                user_id,
                mem_cube_id,
            )

        except Exception as e:
            logger.error("Error processing mem_read message: %s", e, stack_info=True)

    def _process_memories_with_reader(
        self,
        mem_ids: list[str],
        user_id: str,
        mem_cube_id: str,
        text_mem: TreeTextMemory,
        user_name: str,
        custom_tags: list[str] | None = None,
        task_id: str | None = None,
        info: dict | None = None,
        chat_history: list | None = None,
        user_context: UserContext | None = None,
    ) -> None:
        logger.info(
            "[DIAGNOSTIC] mem_read_handler._process_memories_with_reader called. mem_ids: %s, user_id: %s, mem_cube_id: %s, task_id: %s",
            mem_ids,
            user_id,
            mem_cube_id,
            task_id,
        )
        kb_log_content: list[dict] = []
        try:
            mem_reader = self.scheduler_context.get_mem_reader()
            if mem_reader is None:
                logger.warning(
                    "mem_reader not available in scheduler, skipping enhanced processing"
                )
                return

            # Get the original fast memory (raw chunk) items
            memory_items = []
            for mem_id in mem_ids:
                try:
                    memory_item = text_mem.get(mem_id, user_name=user_name)
                    memory_items.append(memory_item)
                except Exception as e:
                    logger.warning(
                        "[_process_memories_with_reader] Failed to get memory %s: %s", mem_id, e
                    )
                    continue

            if not memory_items:
                logger.warning("No valid memory items found for processing")
                return

            from memos.memories.textual.tree_text_memory.organize.manager import (
                extract_working_binding_ids,
            )

            bindings_to_delete = extract_working_binding_ids(memory_items)
            logger.info(
                "Extracted %s working_binding ids to cleanup: %s",
                len(bindings_to_delete),
                list(bindings_to_delete),
            )

            logger.info("Processing %s memories with mem_reader", len(memory_items))

            try:
                processed_memories = mem_reader.fine_transfer_simple_mem(
                    memory_items,
                    type="chat",
                    custom_tags=custom_tags,
                    user_name=user_name,
                    chat_history=chat_history,
                    user_context=user_context,
                )
            except Exception as e:
                logger.warning("%s: Fail to transfer mem: %s", e, memory_items)
                processed_memories = []

            if processed_memories and len(processed_memories) > 0:
                flattened_memories = []
                for memory_list in processed_memories:
                    flattened_memories.extend(memory_list)

                logger.info("mem_reader processed %s enhanced memories", len(flattened_memories))

                if flattened_memories:
                    mem_group = [
                        memory
                        for memory in flattened_memories
                        if memory.metadata.memory_type != "RawFileMemory"
                    ]
                    enhanced_mem_ids = text_mem.add(mem_group, user_name=user_name)
                    logger.info(
                        "Added %s enhanced memories: %s",
                        len(enhanced_mem_ids),
                        enhanced_mem_ids,
                    )

                    # add raw file nodes and edges
                    if self.mem_reader.save_rawfile:
                        raw_file_mem_group = [
                            memory
                            for memory in flattened_memories
                            if memory.metadata.memory_type == "RawFileMemory"
                        ]
                        text_mem.add_rawfile_nodes_n_edges(
                            raw_file_mem_group,
                            enhanced_mem_ids,
                            user_id=user_id,
                            user_name=user_name,
                        )
                        logger.info(f"Added {len(raw_file_mem_group)} Rawfile memories.")

                    # Mark merged_from memories as archived when provided in memory metadata
                    summary_memories = [
                        memory
                        for memory in flattened_memories
                        if memory.metadata.memory_type != "RawFileMemory"
                    ]
                    if mem_reader.graph_db:
                        for memory in flattened_memories:
                            merged_from = (memory.metadata.info or {}).get("merged_from")
                            if merged_from:
                                old_ids = (
                                    merged_from
                                    if isinstance(merged_from, (list | tuple | set))
                                    else [merged_from]
                                )
                                for old_id in old_ids:
                                    try:
                                        mem_reader.graph_db.update_node(
                                            str(old_id), {"status": "archived"}, user_name=user_name
                                        )
                                        logger.info(
                                            "[Scheduler] Archived merged_from memory: %s",
                                            old_id,
                                        )
                                    except Exception as e:
                                        logger.warning(
                                            "[Scheduler] Failed to archive merged_from memory %s: %s",
                                            old_id,
                                            e,
                                        )
                    else:
                        has_merged_from = any(
                            (m.metadata.info or {}).get("merged_from") for m in summary_memories
                        )
                        if has_merged_from:
                            logger.warning(
                                "[Scheduler] merged_from provided but graph_db is unavailable; skip archiving."
                            )

                    cloud_env = is_cloud_env()
                    if cloud_env:
                        kb_log_content = []
                        for item in flattened_memories:
                            metadata = getattr(item, "metadata", None)
                            file_ids = getattr(metadata, "file_ids", None) if metadata else None
                            source_doc_id = (
                                file_ids[0] if isinstance(file_ids, list) and file_ids else None
                            )
                            kb_log_content.append(
                                {
                                    "log_source": "KNOWLEDGE_BASE_LOG",
                                    "trigger_source": info.get("trigger_source", "Messages")
                                    if info
                                    else "Messages",
                                    "operation": "ADD",
                                    "memory_id": item.id,
                                    "content": item.memory,
                                    "original_content": None,
                                    "source_doc_id": source_doc_id,
                                }
                            )
                        if kb_log_content:
                            logger.info(
                                "[DIAGNOSTIC] mem_read_handler: Creating event log for KB update. Label: knowledgeBaseUpdate, user_id: %s, mem_cube_id: %s, task_id: %s. KB content: %s",
                                user_id,
                                mem_cube_id,
                                task_id,
                                json.dumps(kb_log_content, indent=2),
                            )
                            event = self.scheduler_context.services.create_event_log(
                                label="knowledgeBaseUpdate",
                                from_memory_type=USER_INPUT_TYPE,
                                to_memory_type=LONG_TERM_MEMORY_TYPE,
                                user_id=user_id,
                                mem_cube_id=mem_cube_id,
                                mem_cube=self.scheduler_context.get_mem_cube(),
                                memcube_log_content=kb_log_content,
                                metadata=None,
                                memory_len=len(kb_log_content),
                                memcube_name=self.scheduler_context.services.map_memcube_name(
                                    mem_cube_id
                                ),
                            )
                            event.log_content = (
                                f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
                            )
                            event.task_id = task_id
                            self.scheduler_context.services.submit_web_logs([event])
                    else:
                        add_content_legacy: list[dict] = []
                        add_meta_legacy: list[dict] = []
                        for item_id, item in zip(
                            enhanced_mem_ids, flattened_memories, strict=False
                        ):
                            key = getattr(item.metadata, "key", None) or transform_name_to_key(
                                name=item.memory
                            )
                            add_content_legacy.append(
                                {"content": f"{key}: {item.memory}", "ref_id": item_id}
                            )
                            add_meta_legacy.append(
                                {
                                    "ref_id": item_id,
                                    "id": item_id,
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
                        if add_content_legacy:
                            event = self.scheduler_context.services.create_event_log(
                                label="addMemory",
                                from_memory_type=USER_INPUT_TYPE,
                                to_memory_type=LONG_TERM_MEMORY_TYPE,
                                user_id=user_id,
                                mem_cube_id=mem_cube_id,
                                mem_cube=self.scheduler_context.get_mem_cube(),
                                memcube_log_content=add_content_legacy,
                                metadata=add_meta_legacy,
                                memory_len=len(add_content_legacy),
                                memcube_name=self.scheduler_context.services.map_memcube_name(
                                    mem_cube_id
                                ),
                            )
                            event.task_id = task_id
                            self.scheduler_context.services.submit_web_logs([event])
                else:
                    logger.info("No enhanced memories generated by mem_reader")
            else:
                logger.info("mem_reader returned no processed memories")

            delete_ids = list(mem_ids)
            if bindings_to_delete:
                delete_ids.extend(list(bindings_to_delete))
            delete_ids = list(dict.fromkeys(delete_ids))
            if delete_ids:
                try:
                    text_mem.delete(delete_ids, user_name=user_name)
                    logger.info(
                        "Delete raw/working mem_ids: %s for user_name: %s", delete_ids, user_name
                    )
                except Exception as e:
                    logger.warning("Failed to delete some mem_ids %s: %s", delete_ids, e)
            else:
                logger.info("No mem_ids to delete (nothing to cleanup)")

            text_mem.memory_manager.remove_and_refresh_memory(user_name=user_name)
            logger.info("Remove and Refresh Memories")
            logger.debug("Finished add %s memory: %s", user_id, mem_ids)

        except Exception as exc:
            logger.error(
                "Error in _process_memories_with_reader: %s",
                traceback.format_exc(),
                exc_info=True,
            )
            with contextlib.suppress(Exception):
                cloud_env = is_cloud_env()
                if cloud_env:
                    if not kb_log_content:
                        trigger_source = (
                            info.get("trigger_source", "Messages") if info else "Messages"
                        )
                        kb_log_content = [
                            {
                                "log_source": "KNOWLEDGE_BASE_LOG",
                                "trigger_source": trigger_source,
                                "operation": "ADD",
                                "memory_id": mem_id,
                                "content": None,
                                "original_content": None,
                                "source_doc_id": None,
                            }
                            for mem_id in mem_ids
                        ]
                    event = self.scheduler_context.services.create_event_log(
                        label="knowledgeBaseUpdate",
                        from_memory_type=USER_INPUT_TYPE,
                        to_memory_type=LONG_TERM_MEMORY_TYPE,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=self.scheduler_context.get_mem_cube(),
                        memcube_log_content=kb_log_content,
                        metadata=None,
                        memory_len=len(kb_log_content),
                        memcube_name=self.scheduler_context.services.map_memcube_name(mem_cube_id),
                    )
                    event.log_content = f"Knowledge Base Memory Update failed: {exc!s}"
                    event.task_id = task_id
                    event.status = "failed"
                    self.scheduler_context.services.submit_web_logs([event])
