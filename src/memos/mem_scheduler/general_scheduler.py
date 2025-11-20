import concurrent.futures
import contextlib
import json
import traceback

from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    ANSWER_LABEL,
    DEFAULT_MAX_QUERY_KEY_WORDS,
    MEM_ORGANIZE_LABEL,
    MEM_READ_LABEL,
    PREF_ADD_LABEL,
    QUERY_LABEL,
    WORKING_MEMORY_TYPE,
    USER_INPUT_TYPE,
    NOT_APPLICABLE_TYPE,
    LONG_TERM_MEMORY_TYPE,
    MemCubeID,
    UserID,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.monitor_schemas import QueryMonitorItem
from memos.mem_scheduler.utils.filter_utils import (
    is_all_chinese,
    is_all_english,
    transform_name_to_key,
)
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.preference import PreferenceTextMemory
from memos.memories.textual.tree import TreeTextMemory


logger = get_logger(__name__)


class GeneralScheduler(BaseScheduler):
    def __init__(self, config: GeneralSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__(config)

        self.query_key_words_limit = self.config.get("query_key_words_limit", 20)

        # register handlers
        handlers = {
            QUERY_LABEL: self._query_message_consumer,
            ANSWER_LABEL: self._answer_message_consumer,
            ADD_LABEL: self._add_message_consumer,
            MEM_READ_LABEL: self._mem_read_message_consumer,
            MEM_ORGANIZE_LABEL: self._mem_reorganize_message_consumer,
            PREF_ADD_LABEL: self._pref_add_message_consumer,
        }
        self.dispatcher.register_handlers(handlers)

    def long_memory_update_process(
        self, user_id: str, mem_cube_id: str, messages: list[ScheduleMessageItem]
    ):
        mem_cube = self.current_mem_cube

        # update query monitors
        for msg in messages:
            self.monitor.register_query_monitor_if_not_exists(
                user_id=user_id, mem_cube_id=mem_cube_id
            )

            query = msg.content
            query_keywords = self.monitor.extract_query_keywords(query=query)
            logger.info(
                f'Extracted keywords "{query_keywords}" from query "{query}" for user_id={user_id}'
            )

            if len(query_keywords) == 0:
                stripped_query = query.strip()
                # Determine measurement method based on language
                if is_all_english(stripped_query):
                    words = stripped_query.split()  # Word count for English
                elif is_all_chinese(stripped_query):
                    words = stripped_query  # Character count for Chinese
                else:
                    logger.debug(
                        f"Mixed-language memory, using character count: {stripped_query[:50]}..."
                    )
                    words = stripped_query  # Default to character count

                query_keywords = list(set(words[: self.query_key_words_limit]))
                logger.error(
                    f"Keyword extraction failed for query '{query}' (user_id={user_id}). Using fallback keywords: {query_keywords[:10]}... (truncated)",
                    exc_info=True,
                )

            item = QueryMonitorItem(
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                query_text=query,
                keywords=query_keywords,
                max_keywords=DEFAULT_MAX_QUERY_KEY_WORDS,
            )

            query_db_manager = self.monitor.query_monitors[user_id][mem_cube_id]
            query_db_manager.obj.put(item=item)
            # Sync with database after adding new item
            query_db_manager.sync_with_orm()
        logger.debug(
            f"Queries in monitor for user_id={user_id}, mem_cube_id={mem_cube_id}: {query_db_manager.obj.get_queries_with_timesort()}"
        )

        queries = [msg.content for msg in messages]

        # recall
        cur_working_memory, new_candidates = self.process_session_turn(
            queries=queries,
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            top_k=self.top_k,
        )
        logger.info(
            f"Processed {len(queries)} queries {queries} and retrieved {len(new_candidates)} new candidate memories for user_id={user_id}"
        )

        # rerank
        new_order_working_memory = self.replace_working_memory(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            original_memory=cur_working_memory,
            new_memory=new_candidates,
        )
        logger.info(
            f"Final working memory size: {len(new_order_working_memory)} memories for user_id={user_id}"
        )

        # update activation memories
        logger.info(
            f"Activation memory update {'enabled' if self.enable_activation_memory else 'disabled'} "
            f"(interval: {self.monitor.act_mem_update_interval}s)"
        )
        if self.enable_activation_memory:
            self.update_activation_memory_periodically(
                interval_seconds=self.monitor.act_mem_update_interval,
                label=QUERY_LABEL,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=self.current_mem_cube,
            )

    def _query_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        logger.info(f"Messages {messages} assigned to {QUERY_LABEL} handler.")

        grouped_messages = self.dispatcher._group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=QUERY_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                batch = grouped_messages[user_id][mem_cube_id]
                if not batch:
                    continue
                try:
                    for msg in batch:
                        event = self.create_event_log(
                            label="addMessage",
                            from_memory_type=USER_INPUT_TYPE,
                            to_memory_type=NOT_APPLICABLE_TYPE,
                            user_id=msg.user_id,
                            mem_cube_id=msg.mem_cube_id,
                            mem_cube=self.current_mem_cube,
                            memcube_log_content=[
                                {
                                    "content": f"[User] {msg.content}",
                                    "ref_id": msg.item_id,
                                    "role": "user",
                                }
                            ],
                            metadata=[],
                            memory_len=1,
                            memcube_name=self._map_memcube_name(msg.mem_cube_id),
                        )
                        self._submit_web_logs([event])
                except Exception:
                    logger.exception("Failed to record addMessage log for query")
                self.long_memory_update_process(
                    user_id=user_id, mem_cube_id=mem_cube_id, messages=batch
                )

    def _answer_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        logger.info(f"Messages {messages} assigned to {ANSWER_LABEL} handler.")
        grouped_messages = self.dispatcher._group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ANSWER_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                batch = grouped_messages[user_id][mem_cube_id]
                if not batch:
                    continue
                try:
                    for msg in batch:
                        event = self.create_event_log(
                            label="addMessage",
                            from_memory_type=USER_INPUT_TYPE,
                            to_memory_type=NOT_APPLICABLE_TYPE,
                            user_id=msg.user_id,
                            mem_cube_id=msg.mem_cube_id,
                            mem_cube=self.current_mem_cube,
                            memcube_log_content=[
                                {
                                    "content": f"[Assistant] {msg.content}",
                                    "ref_id": msg.item_id,
                                    "role": "assistant",
                                }
                            ],
                            metadata=[],
                            memory_len=1,
                            memcube_name=self._map_memcube_name(msg.mem_cube_id),
                        )
                        self._submit_web_logs([event])
                except Exception:
                    logger.exception("Failed to record addMessage log for answer")

    def _add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {ADD_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher._group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ADD_LABEL)
        try:
            for user_id in grouped_messages:
                for mem_cube_id in grouped_messages[user_id]:
                    batch = grouped_messages[user_id][mem_cube_id]
                    if not batch:
                        continue

                    for msg in batch:
                        try:
                            userinput_memory_ids = json.loads(msg.content)
                        except Exception as e:
                            logger.error(f"Error: {e}. Content: {msg.content}", exc_info=True)
                            userinput_memory_ids = []

                        mem_items: list[TextualMemoryItem] = []
                        for memory_id in userinput_memory_ids:
                            try:
                                mem_item: TextualMemoryItem = self.current_mem_cube.text_mem.get(
                                    memory_id=memory_id
                                )
                                mem_items.append(mem_item)
                            except Exception:
                                logger.warning(
                                    f"This MemoryItem {memory_id} has already been deleted."
                                )
                                continue
                        add_content: list[dict] = []
                        add_meta: list[dict] = []
                        update_content: list[dict] = []
                        update_meta: list[dict] = []
                        for mem_item in mem_items:
                            if mem_item.metadata.memory_type == WORKING_MEMORY_TYPE:
                                continue
                            key = getattr(mem_item.metadata, "key", None) or transform_name_to_key(
                                name=mem_item.memory
                            )
                            exists = False
                            try:
                                text_mem = self.current_mem_cube.text_mem
                                if key and hasattr(text_mem, "graph_store"):
                                    candidates = text_mem.graph_store.get_by_metadata(
                                        [
                                            {"field": "memory", "op": "=", "value": key},
                                            {
                                                "field": "memory_type",
                                                "op": "=",
                                                "value": mem_item.metadata.memory_type,
                                            },
                                        ]
                                    )
                                    exists = bool(candidates)
                            except Exception:
                                exists = False

                            payload = {"content": f"{key}: {mem_item.memory}", "ref_id": mem_item.id}
                            meta_dict = {
                                "ref_id": mem_item.id,
                                "id": mem_item.id,
                                "key": mem_item.metadata.key,
                                "memory": mem_item.memory,
                                "memory_type": mem_item.metadata.memory_type,
                                "status": mem_item.metadata.status,
                                "confidence": mem_item.metadata.confidence,
                                "tags": mem_item.metadata.tags,
                                "updated_at": getattr(mem_item.metadata, "updated_at", None)
                                or getattr(mem_item.metadata, "update_at", None),
                            }
                            if exists:
                                update_content.append(payload)
                                update_meta.append(meta_dict)
                            else:
                                add_content.append(payload)
                                add_meta.append(meta_dict)

                        events = []
                        if add_content:
                            events.append(
                                self.create_event_log(
                                    label="addMemory",
                                    from_memory_type=USER_INPUT_TYPE,
                                    to_memory_type=LONG_TERM_MEMORY_TYPE,
                                    user_id=msg.user_id,
                                    mem_cube_id=msg.mem_cube_id,
                                    mem_cube=self.current_mem_cube,
                                    memcube_log_content=add_content,
                                    metadata=add_meta,
                                    memory_len=len(add_content),
                                    memcube_name=self._map_memcube_name(msg.mem_cube_id),
                                )
                            )
                        if update_content:
                            events.append(
                                self.create_event_log(
                                    label="updateMemory",
                                    from_memory_type=LONG_TERM_MEMORY_TYPE,
                                    to_memory_type=LONG_TERM_MEMORY_TYPE,
                                    user_id=msg.user_id,
                                    mem_cube_id=msg.mem_cube_id,
                                    mem_cube=self.current_mem_cube,
                                    memcube_log_content=update_content,
                                    metadata=update_meta,
                                    memory_len=len(update_content),
                                    memcube_name=self._map_memcube_name(msg.mem_cube_id),
                                )
                            )
                        if events:
                            self._submit_web_logs(events)

        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)

    def _mem_read_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {MEM_READ_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = self.current_mem_cube
                content = message.content
                user_name = message.user_name

                # Parse the memory IDs from content
                mem_ids = json.loads(content) if isinstance(content, str) else content
                if not mem_ids:
                    return

                logger.info(
                    f"Processing mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}, mem_ids={mem_ids}"
                )

                # Get the text memory from the mem_cube
                text_mem = mem_cube.text_mem
                if not isinstance(text_mem, TreeTextMemory):
                    logger.error(f"Expected TreeTextMemory but got {type(text_mem).__name__}")
                    return

                # Use mem_reader to process the memories
                self._process_memories_with_reader(
                    mem_ids=mem_ids,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    text_mem=text_mem,
                    user_name=user_name,
                )

                logger.info(
                    f"Successfully processed mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_read message: {e}", exc_info=True)

        with ContextThreadPoolExecutor(max_workers=min(8, len(messages))) as executor:
            futures = [executor.submit(process_message, msg) for msg in messages]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"Thread task failed: {e}", exc_info=True)

    def _process_memories_with_reader(
        self,
        mem_ids: list[str],
        user_id: str,
        mem_cube_id: str,
        text_mem: TreeTextMemory,
        user_name: str,
    ) -> None:
        """
        Process memories using mem_reader for enhanced memory processing.

        Args:
            mem_ids: List of memory IDs to process
            user_id: User ID
            mem_cube_id: Memory cube ID
            text_mem: Text memory instance
        """
        try:
            # Get the mem_reader from the parent MOSCore
            if not hasattr(self, "mem_reader") or self.mem_reader is None:
                logger.warning(
                    "mem_reader not available in scheduler, skipping enhanced processing"
                )
                return

            # Get the original memory items
            memory_items = []
            for mem_id in mem_ids:
                try:
                    memory_item = text_mem.get(mem_id)
                    memory_items.append(memory_item)
                except Exception as e:
                    logger.warning(f"Failed to get memory {mem_id}: {e}")
                    continue

            if not memory_items:
                logger.warning("No valid memory items found for processing")
                return

            # parse working_binding ids from the *original* memory_items (the raw items created in /add)
            # these still carry metadata.background with "[working_binding:...]" so we can know
            # which WorkingMemory clones should be cleaned up later.
            from memos.memories.textual.tree_text_memory.organize.manager import (
                extract_working_binding_ids,
            )

            bindings_to_delete = extract_working_binding_ids(memory_items)
            logger.info(
                f"Extracted {len(bindings_to_delete)} working_binding ids to cleanup: {list(bindings_to_delete)}"
            )

            # Use mem_reader to process the memories
            logger.info(f"Processing {len(memory_items)} memories with mem_reader")

            # Extract memories using mem_reader
            try:
                processed_memories = self.mem_reader.fine_transfer_simple_mem(
                    memory_items,
                    type="chat",
                )
            except Exception as e:
                logger.warning(f"{e}: Fail to transfer mem: {memory_items}")
                processed_memories = []

            if processed_memories and len(processed_memories) > 0:
                # Flatten the results (mem_reader returns list of lists)
                flattened_memories = []
                for memory_list in processed_memories:
                    flattened_memories.extend(memory_list)

                logger.info(f"mem_reader processed {len(flattened_memories)} enhanced memories")

                # Add the enhanced memories back to the memory system
                if flattened_memories:
                    enhanced_mem_ids = text_mem.add(flattened_memories, user_name=user_name)
                    logger.info(
                        f"Added {len(enhanced_mem_ids)} enhanced memories: {enhanced_mem_ids}"
                    )
                else:
                    logger.info("No enhanced memories generated by mem_reader")
            else:
                logger.info("mem_reader returned no processed memories")

            # build full delete list:
            # - original raw mem_ids (temporary fast memories)
            # - any bound working memories referenced by the enhanced memories
            delete_ids = list(mem_ids)
            if bindings_to_delete:
                delete_ids.extend(list(bindings_to_delete))
            # deduplicate
            delete_ids = list(dict.fromkeys(delete_ids))
            if delete_ids:
                try:
                    text_mem.delete(delete_ids, user_name=user_name)
                    logger.info(
                        f"Delete raw/working mem_ids: {delete_ids} for user_name: {user_name}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to delete some mem_ids {delete_ids}: {e}")
            else:
                logger.info("No mem_ids to delete (nothing to cleanup)")

            text_mem.memory_manager.remove_and_refresh_memory(user_name=user_name)
            logger.info("Remove and Refresh Memories")
            logger.debug(f"Finished add {user_id} memory: {mem_ids}")

        except Exception:
            logger.error(
                f"Error in _process_memories_with_reader: {traceback.format_exc()}", exc_info=True
            )

    def _mem_reorganize_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {MEM_READ_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = self.current_mem_cube
                content = message.content
                user_name = message.user_name

                # Parse the memory IDs from content
                mem_ids = json.loads(content) if isinstance(content, str) else content
                if not mem_ids:
                    return

                logger.info(
                    f"Processing mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}, mem_ids={mem_ids}"
                )

                # Get the text memory from the mem_cube
                text_mem = mem_cube.text_mem
                if not isinstance(text_mem, TreeTextMemory):
                    logger.error(f"Expected TreeTextMemory but got {type(text_mem).__name__}")
                    return

                # Use mem_reader to process the memories
                self._process_memories_with_reorganize(
                    mem_ids=mem_ids,
                    user_id=user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    text_mem=text_mem,
                    user_name=user_name,
                )

                with contextlib.suppress(Exception):
                    mem_items: list[TextualMemoryItem] = []
                    for mid in mem_ids:
                        with contextlib.suppress(Exception):
                            mem_items.append(text_mem.get(mid))
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
                                        target = edge.get("to") or edge.get("dst") or edge.get("target")
                                        if target:
                                            merged_target_ids.add(target)
                        for item in mem_items:
                            key = getattr(getattr(item, "metadata", {}), "key", None) or transform_name_to_key(
                                getattr(item, "memory", "")
                            )
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
                            post_ref_id = list(merged_target_ids)[0]
                            with contextlib.suppress(Exception):
                                merged_item = text_mem.get(post_ref_id)
                                combined_key = getattr(
                                    getattr(merged_item, "metadata", {}), "key", None
                                ) or combined_key
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
                                    "tags": getattr(getattr(merged_item, "metadata", {}), "tags", None),
                                    "updated_at": getattr(
                                        getattr(merged_item, "metadata", {}), "updated_at", None
                                    )
                                    or getattr(
                                        getattr(merged_item, "metadata", {}), "update_at", None
                                    ),
                                }
                        if not post_ref_id:
                            import hashlib

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
                        event = self.create_event_log(
                            label="mergeMemory",
                            from_memory_type=LONG_TERM_MEMORY_TYPE,
                            to_memory_type=LONG_TERM_MEMORY_TYPE,
                            user_id=user_id,
                            mem_cube_id=mem_cube_id,
                            mem_cube=mem_cube,
                            memcube_log_content=memcube_content,
                            metadata=meta,
                            memory_len=len(keys),
                            memcube_name=self._map_memcube_name(mem_cube_id),
                        )
                        self._submit_web_logs([event])

                logger.info(
                    f"Successfully processed mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_read message: {e}", exc_info=True)

        with ContextThreadPoolExecutor(max_workers=min(8, len(messages))) as executor:
            futures = [executor.submit(process_message, msg) for msg in messages]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"Thread task failed: {e}", exc_info=True)

    def _process_memories_with_reorganize(
        self,
        mem_ids: list[str],
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        text_mem: TreeTextMemory,
        user_name: str,
    ) -> None:
        """
        Process memories using mem_reorganize for enhanced memory processing.

        Args:
            mem_ids: List of memory IDs to process
            user_id: User ID
            mem_cube_id: Memory cube ID
            mem_cube: Memory cube instance
            text_mem: Text memory instance
        """
        try:
            # Get the mem_reader from the parent MOSCore
            if not hasattr(self, "mem_reader") or self.mem_reader is None:
                logger.warning(
                    "mem_reader not available in scheduler, skipping enhanced processing"
                )
                return

            # Get the original memory items
            memory_items = []
            for mem_id in mem_ids:
                try:
                    memory_item = text_mem.get(mem_id)
                    memory_items.append(memory_item)
                except Exception as e:
                    logger.warning(f"Failed to get memory {mem_id}: {e}|{traceback.format_exc()}")
                    continue

            if not memory_items:
                logger.warning("No valid memory items found for processing")
                return

            # Use mem_reader to process the memories
            logger.info(f"Processing {len(memory_items)} memories with mem_reader")
            text_mem.memory_manager.remove_and_refresh_memory(user_name=user_name)
            logger.info("Remove and Refresh Memories")
            logger.debug(f"Finished add {user_id} memory: {mem_ids}")

        except Exception:
            logger.error(
                f"Error in _process_memories_with_reader: {traceback.format_exc()}", exc_info=True
            )

    def _pref_add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {PREF_ADD_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                mem_cube = self.current_mem_cube

                user_id = message.user_id
                session_id = message.session_id
                mem_cube_id = message.mem_cube_id
                content = message.content
                messages_list = json.loads(content)

                logger.info(f"Processing pref_add for user_id={user_id}, mem_cube_id={mem_cube_id}")

                # Get the preference memory from the mem_cube
                pref_mem = mem_cube.pref_mem
                if not isinstance(pref_mem, PreferenceTextMemory):
                    logger.error(f"Expected PreferenceTextMemory but got {type(pref_mem).__name__}")
                    return

                # Use pref_mem.get_memory to process the memories
                pref_memories = pref_mem.get_memory(
                    messages_list,
                    type="chat",
                    info={"user_id": user_id, "session_id": session_id, "mem_cube_id": mem_cube_id},
                )
                # Add pref_mem to vector db
                pref_ids = pref_mem.add(pref_memories)

                logger.info(
                    f"Successfully processed and add preferences for user_id={user_id}, mem_cube_id={mem_cube_id}, pref_ids={pref_ids}"
                )

            except Exception as e:
                logger.error(f"Error processing pref_add message: {e}", exc_info=True)

        with ContextThreadPoolExecutor(max_workers=min(8, len(messages))) as executor:
            futures = [executor.submit(process_message, msg) for msg in messages]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"Thread task failed: {e}", exc_info=True)

    def process_session_turn(
        self,
        queries: str | list[str],
        user_id: UserID | str,
        mem_cube_id: MemCubeID | str,
        mem_cube: GeneralMemCube,
        top_k: int = 10,
    ) -> tuple[list[TextualMemoryItem], list[TextualMemoryItem]] | None:
        """
        Process a dialog turn:
        - If q_list reaches window size, trigger retrieval;
        - Immediately switch to the new memory if retrieval is triggered.
        """

        text_mem_base = mem_cube.text_mem
        if not isinstance(text_mem_base, TreeTextMemory):
            logger.error(
                f"Not implemented! Expected TreeTextMemory but got {type(text_mem_base).__name__} "
                f"for mem_cube_id={mem_cube_id}, user_id={user_id}. "
                f"text_mem_base value: {text_mem_base}",
                exc_info=True,
            )
            return

        logger.info(
            f"Processing {len(queries)} queries for user_id={user_id}, mem_cube_id={mem_cube_id}"
        )

        cur_working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory()
        text_working_memory: list[str] = [w_m.memory for w_m in cur_working_memory]
        intent_result = self.monitor.detect_intent(
            q_list=queries, text_working_memory=text_working_memory
        )

        time_trigger_flag = False
        if self.monitor.timed_trigger(
            last_time=self.monitor.last_query_consume_time,
            interval_seconds=self.monitor.query_trigger_interval,
        ):
            time_trigger_flag = True

        if (not intent_result["trigger_retrieval"]) and (not time_trigger_flag):
            logger.info(
                f"Query schedule not triggered for user_id={user_id}, mem_cube_id={mem_cube_id}. Intent_result: {intent_result}"
            )
            return
        elif (not intent_result["trigger_retrieval"]) and time_trigger_flag:
            logger.info(
                f"Query schedule forced to trigger due to time ticker for user_id={user_id}, mem_cube_id={mem_cube_id}"
            )
            intent_result["trigger_retrieval"] = True
            intent_result["missing_evidences"] = queries
        else:
            logger.info(
                f"Query schedule triggered for user_id={user_id}, mem_cube_id={mem_cube_id}. "
                f"Missing evidences: {intent_result['missing_evidences']}"
            )

        missing_evidences = intent_result["missing_evidences"]
        num_evidence = len(missing_evidences)
        k_per_evidence = max(1, top_k // max(1, num_evidence))
        new_candidates = []
        for item in missing_evidences:
            logger.info(
                f"Searching for missing evidence: '{item}' with top_k={k_per_evidence} for user_id={user_id}"
            )
            info = {
                "user_id": user_id,
                "session_id": "",
            }

            results: list[TextualMemoryItem] = self.retriever.search(
                query=item,
                mem_cube=mem_cube,
                top_k=k_per_evidence,
                method=self.search_method,
                info=info,
            )
            logger.info(
                f"Search results for missing evidence '{item}': {[one.memory for one in results]}"
            )
            new_candidates.extend(results)
        return cur_working_memory, new_candidates
