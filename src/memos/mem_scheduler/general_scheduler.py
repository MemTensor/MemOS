import concurrent.futures
import contextlib
import json
import traceback

from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.monitor_schemas import QueryMonitorItem
from memos.mem_scheduler.schemas.task_schemas import (
    ADD_TASK_LABEL,
    ANSWER_TASK_LABEL,
    DEFAULT_MAX_QUERY_KEY_WORDS,
    LONG_TERM_MEMORY_TYPE,
    MEM_FEEDBACK_TASK_LABEL,
    MEM_ORGANIZE_TASK_LABEL,
    MEM_READ_TASK_LABEL,
    MEM_UPDATE_TASK_LABEL,
    NOT_APPLICABLE_TYPE,
    PREF_ADD_TASK_LABEL,
    QUERY_TASK_LABEL,
    USER_INPUT_TYPE,
)
from memos.mem_scheduler.utils.filter_utils import (
    is_all_chinese,
    is_all_english,
    transform_name_to_key,
)
from memos.mem_scheduler.utils.misc_utils import (
    group_messages_by_user_and_mem_cube,
    is_cloud_env,
)
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.preference import PreferenceTextMemory
from memos.memories.textual.tree import TreeTextMemory
from memos.types import (
    MemCubeID,
    UserID,
)


logger = get_logger(__name__)


class GeneralScheduler(BaseScheduler):
    def __init__(self, config: GeneralSchedulerConfig):
        """Initialize the scheduler with the given configuration."""
        super().__init__(config)

        self.query_key_words_limit = self.config.get("query_key_words_limit", 20)

        # register handlers
        handlers = {
            QUERY_TASK_LABEL: self._query_message_consumer,
            ANSWER_TASK_LABEL: self._answer_message_consumer,
            MEM_UPDATE_TASK_LABEL: self._memory_update_consumer,
            ADD_TASK_LABEL: self._add_message_consumer,
            MEM_READ_TASK_LABEL: self._mem_read_message_consumer,
            MEM_ORGANIZE_TASK_LABEL: self._mem_reorganize_message_consumer,
            PREF_ADD_TASK_LABEL: self._pref_add_message_consumer,
            MEM_FEEDBACK_TASK_LABEL: self._mem_feedback_message_consumer,
        }
        self.dispatcher.register_handlers(handlers)

    def long_memory_update_process(
        self, user_id: str, mem_cube_id: str, messages: list[ScheduleMessageItem]
    ):
        mem_cube = self.mem_cube

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
            # Build the candidate preview string outside the f-string to avoid backslashes in expression
            f"[long_memory_update_process] Processed {len(queries)} queries {queries} and retrieved {len(new_candidates)} "
            f"new candidate memories for user_id={user_id}: "
            + ("\n- " + "\n- ".join([f"{one.id}: {one.memory}" for one in new_candidates]))
        )

        # rerank
        new_order_working_memory = self.replace_working_memory(
            user_id=user_id,
            mem_cube_id=mem_cube_id,
            mem_cube=mem_cube,
            original_memory=cur_working_memory,
            new_memory=new_candidates,
        )
        logger.debug(
            f"[long_memory_update_process] Final working memory size: {len(new_order_working_memory)} memories for user_id={user_id}"
        )

        old_memory_texts = "\n- " + "\n- ".join(
            [f"{one.id}: {one.memory}" for one in cur_working_memory]
        )
        new_memory_texts = "\n- " + "\n- ".join(
            [f"{one.id}: {one.memory}" for one in new_order_working_memory]
        )

        logger.info(
            f"[long_memory_update_process] For user_id='{user_id}', mem_cube_id='{mem_cube_id}': "
            f"Scheduler replaced working memory based on query history {queries}. "
            f"Old working memory ({len(cur_working_memory)} items): {old_memory_texts}. "
            f"New working memory ({len(new_order_working_memory)} items): {new_memory_texts}."
        )

        # update activation memories
        logger.debug(
            f"Activation memory update {'enabled' if self.enable_activation_memory else 'disabled'} "
            f"(interval: {self.monitor.act_mem_update_interval}s)"
        )
        if self.enable_activation_memory:
            self.update_activation_memory_periodically(
                interval_seconds=self.monitor.act_mem_update_interval,
                label=QUERY_TASK_LABEL,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=self.mem_cube,
            )

    def _add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {ADD_TASK_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ADD_TASK_LABEL)
        try:
            for user_id in grouped_messages:
                for mem_cube_id in grouped_messages[user_id]:
                    batch = grouped_messages[user_id][mem_cube_id]
                    if not batch:
                        continue

                    # Process each message in the batch
                    for msg in batch:
                        prepared_add_items, prepared_update_items_with_original = (
                            self.log_add_messages(msg=msg)
                        )
                        logger.info(
                            f"prepared_add_items: {prepared_add_items};\n prepared_update_items_with_original: {prepared_update_items_with_original}"
                        )
                        # Conditional Logging: Knowledge Base (Cloud Service) vs. Playground/Default
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

    def _memory_update_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {MEM_UPDATE_TASK_LABEL} handler.")

        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=MEM_UPDATE_TASK_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                batch = grouped_messages[user_id][mem_cube_id]
                if not batch:
                    continue
                # Process the whole batch once; no need to iterate per message
                self.long_memory_update_process(
                    user_id=user_id, mem_cube_id=mem_cube_id, messages=batch
                )

    def _query_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        logger.info(f"Messages {messages} assigned to {QUERY_TASK_LABEL} handler.")

        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=QUERY_TASK_LABEL)

        mem_update_messages = []
        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                batch = grouped_messages[user_id][mem_cube_id]
                if not batch:
                    continue

                for msg in batch:
                    try:
                        event = self.create_event_log(
                            label="addMessage",
                            from_memory_type=USER_INPUT_TYPE,
                            to_memory_type=NOT_APPLICABLE_TYPE,
                            user_id=msg.user_id,
                            mem_cube_id=msg.mem_cube_id,
                            mem_cube=self.mem_cube,
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
                        event.task_id = msg.task_id
                        self._submit_web_logs([event])
                    except Exception:
                        logger.exception("Failed to record addMessage log for query")
                    # Re-submit the message with label changed to mem_update
                    update_msg = ScheduleMessageItem(
                        user_id=msg.user_id,
                        mem_cube_id=msg.mem_cube_id,
                        label=MEM_UPDATE_TASK_LABEL,
                        content=msg.content,
                        session_id=msg.session_id,
                        user_name=msg.user_name,
                        info=msg.info,
                        task_id=msg.task_id,
                    )
                    mem_update_messages.append(update_msg)

        self.submit_messages(messages=mem_update_messages)

    def _answer_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        logger.info(f"Messages {messages} assigned to {ANSWER_TASK_LABEL} handler.")
        grouped_messages = group_messages_by_user_and_mem_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ANSWER_TASK_LABEL)

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
                            mem_cube=self.mem_cube,
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
                        event.task_id = msg.task_id
                        self._submit_web_logs([event])
                except Exception:
                    logger.exception("Failed to record addMessage log for answer")

    def log_add_messages(self, msg: ScheduleMessageItem):
        try:
            userinput_memory_ids = json.loads(msg.content)
        except Exception as e:
            logger.error(f"Error: {e}. Content: {msg.content}", exc_info=True)
            userinput_memory_ids = []

        # Prepare data for both logging paths, fetching original content for updates
        prepared_add_items = []
        prepared_update_items_with_original = []
        missing_ids: list[str] = []

        for memory_id in userinput_memory_ids:
            try:
                # This mem_item represents the NEW content that was just added/processed
                mem_item: TextualMemoryItem | None = None
                mem_item = self.mem_cube.text_mem.get(
                    memory_id=memory_id, user_name=msg.mem_cube_id
                )
                if mem_item is None:
                    raise ValueError(f"Memory {memory_id} not found after retries")
                # Check if a memory with the same key already exists (determining if it's an update)
                key = getattr(mem_item.metadata, "key", None) or transform_name_to_key(
                    name=mem_item.memory
                )
                exists = False
                original_content = None
                original_item_id = None

                # Only check graph_store if a key exists and the text_mem has a graph_store
                if key and hasattr(self.mem_cube.text_mem, "graph_store"):
                    candidates = self.mem_cube.text_mem.graph_store.get_by_metadata(
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
                        # Crucial step: Fetch the original content for updates
                        # This `get` is for the *existing* memory that will be updated
                        original_mem_item = self.mem_cube.text_mem.get(
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
                    f"This MemoryItem {memory_id} has already been deleted or an error occurred during preparation."
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
        self, msg: ScheduleMessageItem, prepared_add_items, prepared_update_items_with_original
    ):
        # Existing: Playground/Default Logging
        # Reconstruct add_content/add_meta/update_content/update_meta from prepared_items
        # This ensures existing logging path continues to work with pre-existing data structures
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
            event = self.create_event_log(
                label="addMemory",
                from_memory_type=USER_INPUT_TYPE,
                to_memory_type=LONG_TERM_MEMORY_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.mem_cube,
                memcube_log_content=add_content_legacy,
                metadata=add_meta_legacy,
                memory_len=len(add_content_legacy),
                memcube_name=self._map_memcube_name(msg.mem_cube_id),
            )
            event.task_id = msg.task_id
            events.append(event)
        if update_content_legacy:
            event = self.create_event_log(
                label="updateMemory",
                from_memory_type=LONG_TERM_MEMORY_TYPE,
                to_memory_type=LONG_TERM_MEMORY_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.mem_cube,
                memcube_log_content=update_content_legacy,
                metadata=update_meta_legacy,
                memory_len=len(update_content_legacy),
                memcube_name=self._map_memcube_name(msg.mem_cube_id),
            )
            event.task_id = msg.task_id
            events.append(event)
        logger.info(f"send_add_log_messages_to_local_env: {len(events)}")
        if events:
            self._submit_web_logs(events, additional_log_info="send_add_log_messages_to_cloud_env")

    def send_add_log_messages_to_cloud_env(
        self, msg: ScheduleMessageItem, prepared_add_items, prepared_update_items_with_original
    ):
        """
        Cloud logging path for add/update events.
        """
        kb_log_content: list[dict] = []
        info = msg.info or {}

        # Process added items
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

        # Process updated items
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
                f"[DIAGNOSTIC] general_scheduler.send_add_log_messages_to_cloud_env: Creating event log for KB update. Label: knowledgeBaseUpdate, user_id: {msg.user_id}, mem_cube_id: {msg.mem_cube_id}, task_id: {msg.task_id}. KB content: {json.dumps(kb_log_content, indent=2)}"
            )
            event = self.create_event_log(
                label="knowledgeBaseUpdate",
                from_memory_type=USER_INPUT_TYPE,
                to_memory_type=LONG_TERM_MEMORY_TYPE,
                user_id=msg.user_id,
                mem_cube_id=msg.mem_cube_id,
                mem_cube=self.mem_cube,
                memcube_log_content=kb_log_content,
                metadata=None,
                memory_len=len(kb_log_content),
                memcube_name=self._map_memcube_name(msg.mem_cube_id),
            )
            event.log_content = f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
            event.task_id = msg.task_id
            self._submit_web_logs([event])

    def _mem_feedback_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        try:
            if not messages:
                return
            message = messages[0]
            mem_cube = self.mem_cube

            user_id = message.user_id
            mem_cube_id = message.mem_cube_id
            content = message.content

            try:
                feedback_data = json.loads(content) if isinstance(content, str) else content
                if not isinstance(feedback_data, dict):
                    logger.error(
                        f"Failed to decode feedback_data or it is not a dict: {feedback_data}"
                    )
                    return
            except json.JSONDecodeError:
                logger.error(f"Invalid JSON content for feedback message: {content}", exc_info=True)
                return

            task_id = feedback_data.get("task_id") or message.task_id
            feedback_result = self.feedback_server.process_feedback(
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
                f"Successfully processed feedback for user_id={user_id}, mem_cube_id={mem_cube_id}"
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

                logger.info(f"[Feedback Scheduler] kb_log_content: {kb_log_content!s}")
                if kb_log_content:
                    logger.info(
                        "[DIAGNOSTIC] general_scheduler._mem_feedback_message_consumer: Creating knowledgeBaseUpdate event for feedback. user_id=%s mem_cube_id=%s task_id=%s items=%s",
                        user_id,
                        mem_cube_id,
                        task_id,
                        len(kb_log_content),
                    )
                    event = self.create_event_log(
                        label="knowledgeBaseUpdate",
                        from_memory_type=USER_INPUT_TYPE,
                        to_memory_type=LONG_TERM_MEMORY_TYPE,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        memcube_log_content=kb_log_content,
                        metadata=None,
                        memory_len=len(kb_log_content),
                        memcube_name=self._map_memcube_name(mem_cube_id),
                    )
                    event.log_content = (
                        f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
                    )
                    event.task_id = task_id
                    self._submit_web_logs([event])
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
            logger.error(f"Error processing feedbackMemory message: {e}", exc_info=True)

    def _mem_read_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(
            f"[DIAGNOSTIC] general_scheduler._mem_read_message_consumer called. Received messages: {[msg.model_dump_json(indent=2) for msg in messages]}"
        )
        logger.info(f"Messages {messages} assigned to {MEM_READ_TASK_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = self.mem_cube
                if mem_cube is None:
                    logger.error(
                        f"mem_cube is None for user_id={user_id}, mem_cube_id={mem_cube_id}, skipping processing",
                        stack_info=True,
                    )
                    return

                content = message.content
                user_name = message.user_name
                info = message.info or {}

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
                    custom_tags=info.get("custom_tags", None),
                    task_id=message.task_id,
                    info=info,
                )

                logger.info(
                    f"Successfully processed mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_read message: {e}", stack_info=True)

        with ContextThreadPoolExecutor(max_workers=min(8, len(messages))) as executor:
            futures = [executor.submit(process_message, msg) for msg in messages]
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                except Exception as e:
                    logger.error(f"Thread task failed: {e}", stack_info=True)

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
    ) -> None:
        logger.info(
            f"[DIAGNOSTIC] general_scheduler._process_memories_with_reader called. mem_ids: {mem_ids}, user_id: {user_id}, mem_cube_id: {mem_cube_id}, task_id: {task_id}"
        )
        """
        Process memories using mem_reader for enhanced memory processing.

        Args:
            mem_ids: List of memory IDs to process
            user_id: User ID
            mem_cube_id: Memory cube ID
            text_mem: Text memory instance
            custom_tags: Optional list of custom tags for memory processing
        """
        kb_log_content: list[dict] = []
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
                    memory_item = text_mem.get(mem_id, user_name=user_name)
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
                    custom_tags=custom_tags,
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

                    # LOGGING BLOCK START
                    # This block is replicated from _add_message_consumer to ensure consistent logging
                    cloud_env = is_cloud_env()
                    if cloud_env:
                        # New: Knowledge Base Logging (Cloud Service)
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
                                f"[DIAGNOSTIC] general_scheduler._process_memories_with_reader: Creating event log for KB update. Label: knowledgeBaseUpdate, user_id: {user_id}, mem_cube_id: {mem_cube_id}, task_id: {task_id}. KB content: {json.dumps(kb_log_content, indent=2)}"
                            )
                            event = self.create_event_log(
                                label="knowledgeBaseUpdate",
                                from_memory_type=USER_INPUT_TYPE,
                                to_memory_type=LONG_TERM_MEMORY_TYPE,
                                user_id=user_id,
                                mem_cube_id=mem_cube_id,
                                mem_cube=self.mem_cube,
                                memcube_log_content=kb_log_content,
                                metadata=None,
                                memory_len=len(kb_log_content),
                                memcube_name=self._map_memcube_name(mem_cube_id),
                            )
                            event.log_content = (
                                f"Knowledge Base Memory Update: {len(kb_log_content)} changes."
                            )
                            event.task_id = task_id
                            self._submit_web_logs([event])
                    else:
                        # Existing: Playground/Default Logging
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
                            event = self.create_event_log(
                                label="addMemory",
                                from_memory_type=USER_INPUT_TYPE,
                                to_memory_type=LONG_TERM_MEMORY_TYPE,
                                user_id=user_id,
                                mem_cube_id=mem_cube_id,
                                mem_cube=self.mem_cube,
                                memcube_log_content=add_content_legacy,
                                metadata=add_meta_legacy,
                                memory_len=len(add_content_legacy),
                                memcube_name=self._map_memcube_name(mem_cube_id),
                            )
                            event.task_id = task_id
                            self._submit_web_logs([event])
                    # LOGGING BLOCK END
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

        except Exception as exc:
            logger.error(
                f"Error in _process_memories_with_reader: {traceback.format_exc()}", exc_info=True
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
                    event = self.create_event_log(
                        label="knowledgeBaseUpdate",
                        from_memory_type=USER_INPUT_TYPE,
                        to_memory_type=LONG_TERM_MEMORY_TYPE,
                        user_id=user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=self.mem_cube,
                        memcube_log_content=kb_log_content,
                        metadata=None,
                        memory_len=len(kb_log_content),
                        memcube_name=self._map_memcube_name(mem_cube_id),
                    )
                    event.log_content = f"Knowledge Base Memory Update failed: {exc!s}"
                    event.task_id = task_id
                    event.status = "failed"
                    self._submit_web_logs([event])

    def _mem_reorganize_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {MEM_ORGANIZE_TASK_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = self.mem_cube
                if mem_cube is None:
                    logger.warning(
                        f"mem_cube is None for user_id={user_id}, mem_cube_id={mem_cube_id}, skipping processing"
                    )
                    return
                content = message.content
                user_name = message.user_name

                # Parse the memory IDs from content
                mem_ids = json.loads(content) if isinstance(content, str) else content
                if not mem_ids:
                    return

                logger.info(
                    f"Processing mem_reorganize for user_id={user_id}, mem_cube_id={mem_cube_id}, mem_ids={mem_ids}"
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
                    f"Successfully processed mem_reorganize for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_reorganize message: {e}", exc_info=True)

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
                    memory_item = text_mem.get(mem_id, user_name=user_name)
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
                f"Error in _process_memories_with_reorganize: {traceback.format_exc()}",
                exc_info=True,
            )

    def _pref_add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {PREF_ADD_TASK_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                mem_cube = self.mem_cube
                if mem_cube is None:
                    logger.warning(
                        f"mem_cube is None for user_id={message.user_id}, mem_cube_id={message.mem_cube_id}, skipping processing"
                    )
                    return

                user_id = message.user_id
                session_id = message.session_id
                mem_cube_id = message.mem_cube_id
                content = message.content
                messages_list = json.loads(content)
                info = message.info or {}

                logger.info(f"Processing pref_add for user_id={user_id}, mem_cube_id={mem_cube_id}")

                # Get the preference memory from the mem_cube
                pref_mem = mem_cube.pref_mem
                if pref_mem is None:
                    logger.warning(
                        f"Preference memory not initialized for mem_cube_id={mem_cube_id}, "
                        f"skipping pref_add processing"
                    )
                    return
                if not isinstance(pref_mem, PreferenceTextMemory):
                    logger.error(
                        f"Expected PreferenceTextMemory but got {type(pref_mem).__name__} "
                        f"for mem_cube_id={mem_cube_id}"
                    )
                    return

                # Use pref_mem.get_memory to process the memories
                pref_memories = pref_mem.get_memory(
                    messages_list,
                    type="chat",
                    info={
                        **info,
                        "user_id": user_id,
                        "session_id": session_id,
                        "mem_cube_id": mem_cube_id,
                    },
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
            f"[process_session_turn] Processing {len(queries)} queries for user_id={user_id}, mem_cube_id={mem_cube_id}"
        )

        cur_working_memory: list[TextualMemoryItem] = text_mem_base.get_working_memory(
            user_name=mem_cube_id
        )
        cur_working_memory = cur_working_memory[:top_k]
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
                f"[process_session_turn] Query schedule not triggered for user_id={user_id}, mem_cube_id={mem_cube_id}. Intent_result: {intent_result}"
            )
            return
        elif (not intent_result["trigger_retrieval"]) and time_trigger_flag:
            logger.info(
                f"[process_session_turn] Query schedule forced to trigger due to time ticker for user_id={user_id}, mem_cube_id={mem_cube_id}"
            )
            intent_result["trigger_retrieval"] = True
            intent_result["missing_evidences"] = queries
        else:
            logger.info(
                f"[process_session_turn] Query schedule triggered for user_id={user_id}, mem_cube_id={mem_cube_id}. "
                f"Missing evidences: {intent_result['missing_evidences']}"
            )

        missing_evidences = intent_result["missing_evidences"]
        num_evidence = len(missing_evidences)
        k_per_evidence = max(1, top_k // max(1, num_evidence))
        new_candidates = []
        for item in missing_evidences:
            logger.info(
                f"[process_session_turn] Searching for missing evidence: '{item}' with top_k={k_per_evidence} for user_id={user_id}"
            )

            search_args = {}
            results: list[TextualMemoryItem] = self.retriever.search(
                query=item,
                user_id=user_id,
                mem_cube_id=mem_cube_id,
                mem_cube=mem_cube,
                top_k=k_per_evidence,
                method=self.search_method,
                search_args=search_args,
            )

            logger.info(
                f"[process_session_turn] Search results for missing evidence '{item}': "
                + ("\n- " + "\n- ".join([f"{one.id}: {one.memory}" for one in results]))
            )
            new_candidates.extend(results)
        return cur_working_memory, new_candidates
