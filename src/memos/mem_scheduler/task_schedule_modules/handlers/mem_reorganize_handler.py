import contextlib
import hashlib
import json

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.general_modules.scheduler_context import SchedulerContext
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.task_schemas import (
    LONG_TERM_MEMORY_TYPE,
    MEM_ORGANIZE_TASK_LABEL,
)
from memos.mem_scheduler.task_schedule_modules.base_handler import BaseHandler
from memos.mem_scheduler.utils.filter_utils import transform_name_to_key
from memos.memories.textual.tree import TreeTextMemory


if TYPE_CHECKING:
    from memos.memories.textual.item import TextualMemoryItem


logger = get_logger(__name__)


class MemReorganizeHandler(BaseHandler):
    def __init__(self, context: SchedulerContext):
        super().__init__(context)
        self.expected_task_label = MEM_ORGANIZE_TASK_LABEL

    def batch_handler(self, user_id: str, mem_cube_id: str, batch: list[ScheduleMessageItem]):
        for message in batch:
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = self.context.mem_cube
                if mem_cube is None:
                    logger.warning(
                        f"mem_cube is None for user_id={user_id}, mem_cube_id={mem_cube_id}, skipping processing"
                    )
                    continue
                content = message.content
                user_name = message.user_name

                # Parse the memory IDs from content
                mem_ids = json.loads(content) if isinstance(content, str) else content
                if not mem_ids:
                    continue

                logger.info(
                    f"Processing mem_reorganize for user_id={user_id}, mem_cube_id={mem_cube_id}, mem_ids={mem_ids}"
                )

                # Get the text memory from the mem_cube
                text_mem = mem_cube.text_mem
                if not isinstance(text_mem, TreeTextMemory):
                    logger.error(f"Expected TreeTextMemory but got {type(text_mem).__name__}")
                    continue

                # Use mem_reader to process the memories
                if self.context.process_memories_with_reorganize:
                    self.context.process_memories_with_reorganize(
                        mem_ids=mem_ids,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        text_mem=text_mem,
                        user_name=user_name,
                    )
                else:
                    logger.error("process_memories_with_reorganize not available in context")

                with contextlib.suppress(Exception):
                    mem_items: list[TextualMemoryItem] = []
                    for mid in mem_ids:
                        with contextlib.suppress(Exception):
                            mem_items.append(text_mem.get(mid, user_name=user_name))
                    if len(mem_items) > 1:
                        keys: list[str] = []
                        memcube_content: list[dict] = []
                        meta: list[dict] = []
                        merged_target_ids: set[str] = set()
                        with contextlib.suppress(Exception):
                            if hasattr(text_mem, "graph_store"):
                                for mid in mem_ids:
                                    edges = text_mem.graph_store.get_edges(
                                        mid, type="MERGED_TO", direction="OUT"
                                    )
                                    for edge in edges:
                                        target = (
                                            edge.get("to") or edge.get("dst") or edge.get("target")
                                        )
                                        if target:
                                            merged_target_ids.add(target)
                        for item in mem_items:
                            key = getattr(
                                getattr(item, "metadata", {}), "key", None
                            ) or transform_name_to_key(getattr(item, "memory", ""))
                            keys.append(key)
                            memcube_content.append(
                                {"content": key or "(no key)", "ref_id": item.id, "type": "merged"}
                            )
                            meta.append(
                                {
                                    "ref_id": item.id,
                                    "id": item.id,
                                    "key": key,
                                    "memory": item.memory,
                                    "memory_type": item.metadata.memory_type,
                                    "status": item.metadata.status,
                                    "confidence": item.metadata.confidence,
                                    "tags": item.metadata.tags,
                                    "updated_at": getattr(item.metadata, "updated_at", None)
                                    or getattr(item.metadata, "update_at", None),
                                }
                            )
                        combined_key = keys[0] if keys else ""
                        post_ref_id = None
                        post_meta = {
                            "ref_id": None,
                            "id": None,
                            "key": None,
                            "memory": None,
                            "memory_type": None,
                            "status": None,
                            "confidence": None,
                            "tags": None,
                            "updated_at": None,
                        }
                        if merged_target_ids:
                            post_ref_id = next(iter(merged_target_ids))
                            with contextlib.suppress(Exception):
                                merged_item = text_mem.get(post_ref_id, user_name=user_name)
                                combined_key = (
                                    getattr(getattr(merged_item, "metadata", {}), "key", None)
                                    or combined_key
                                )
                                post_meta = {
                                    "ref_id": post_ref_id,
                                    "id": post_ref_id,
                                    "key": getattr(
                                        getattr(merged_item, "metadata", {}), "key", None
                                    ),
                                    "memory": getattr(merged_item, "memory", None),
                                    "memory_type": getattr(
                                        getattr(merged_item, "metadata", {}), "memory_type", None
                                    ),
                                    "status": getattr(
                                        getattr(merged_item, "metadata", {}), "status", None
                                    ),
                                    "confidence": getattr(
                                        getattr(merged_item, "metadata", {}), "confidence", None
                                    ),
                                    "tags": getattr(
                                        getattr(merged_item, "metadata", {}), "tags", None
                                    ),
                                    "updated_at": getattr(
                                        getattr(merged_item, "metadata", {}), "updated_at", None
                                    )
                                    or getattr(
                                        getattr(merged_item, "metadata", {}), "update_at", None
                                    ),
                                }
                        if not post_ref_id:
                            post_ref_id = f"merge-{hashlib.md5(''.join(sorted(mem_ids)).encode()).hexdigest()}"
                            post_meta["ref_id"] = post_ref_id
                            post_meta["id"] = post_ref_id
                        if not post_meta.get("key"):
                            post_meta["key"] = combined_key
                        if not keys:
                            keys = [item.id for item in mem_items]
                        memcube_content.append(
                            {
                                "content": combined_key if combined_key else "(no key)",
                                "ref_id": post_ref_id,
                                "type": "postMerge",
                            }
                        )
                        meta.append(post_meta)

                        if self.context.create_event_log and self.context.submit_web_logs:
                            event = self.context.create_event_log(
                                label="mergeMemory",
                                from_memory_type=LONG_TERM_MEMORY_TYPE,
                                to_memory_type=LONG_TERM_MEMORY_TYPE,
                                user_id=user_id,
                                mem_cube_id=mem_cube_id,
                                mem_cube=mem_cube,
                                memcube_log_content=memcube_content,
                                metadata=meta,
                                memory_len=len(keys),
                                memcube_name=self.context.map_memcube_name(mem_cube_id)
                                if self.context.map_memcube_name
                                else None,
                            )
                            self.context.submit_web_logs([event])

                logger.info(
                    f"Successfully processed mem_reorganize for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_reorganize message: {e}", exc_info=True)
