import concurrent.futures
import json
import traceback

from memos.configs.mem_scheduler import GeneralSchedulerConfig
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.base_scheduler import BaseScheduler
from memos.mem_scheduler.schemas.general_schemas import (
    ADD_LABEL,
    ANSWER_LABEL,
    DEFAULT_MAX_QUERY_KEY_WORDS,
    MEM_READ_LABEL,
    QUERY_LABEL,
    WORKING_MEMORY_TYPE,
    MemCubeID,
    UserID,
)
from memos.mem_scheduler.schemas.message_schemas import ScheduleMessageItem
from memos.mem_scheduler.schemas.monitor_schemas import QueryMonitorItem
from memos.mem_scheduler.utils.filter_utils import is_all_chinese, is_all_english
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory


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
        }
        self.dispatcher.register_handlers(handlers)

    def _query_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle query trigger messages from the queue.

        Args:
            messages: List of query messages to process
        """
        logger.info(f"Messages {messages} assigned to {QUERY_LABEL} handler.")

        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=QUERY_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                mem_cube = messages[0].mem_cube

                # for status update
                self._set_current_context_from_message(msg=messages[0])

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
                        mem_cube=messages[0].mem_cube,
                    )

    def _answer_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        """
        Process and handle answer trigger messages from the queue.

        Args:
          messages: List of answer messages to process
        """
        logger.info(f"Messages {messages} assigned to {ANSWER_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ANSWER_LABEL)

        for user_id in grouped_messages:
            for mem_cube_id in grouped_messages[user_id]:
                messages = grouped_messages[user_id][mem_cube_id]
                if len(messages) == 0:
                    return

                # for status update
                self._set_current_context_from_message(msg=messages[0])

    def _add_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {ADD_LABEL} handler.")
        # Process the query in a session turn
        grouped_messages = self.dispatcher.group_messages_by_user_and_cube(messages=messages)

        self.validate_schedule_messages(messages=messages, label=ADD_LABEL)
        try:
            for user_id in grouped_messages:
                for mem_cube_id in grouped_messages[user_id]:
                    messages = grouped_messages[user_id][mem_cube_id]
                    if len(messages) == 0:
                        return

                    # for status update
                    self._set_current_context_from_message(msg=messages[0])

                    # submit logs
                    for msg in messages:
                        try:
                            userinput_memory_ids = json.loads(msg.content)
                        except Exception as e:
                            logger.error(f"Error: {e}. Content: {msg.content}", exc_info=True)
                            userinput_memory_ids = []

                        mem_cube = msg.mem_cube
                        for memory_id in userinput_memory_ids:
                            try:
                                mem_item: TextualMemoryItem = mem_cube.text_mem.get(
                                    memory_id=memory_id
                                )
                            except Exception:
                                logger.warning(
                                    f"This MemoryItem {memory_id} has already been deleted."
                                )
                                continue
                            mem_type = mem_item.metadata.memory_type
                            mem_content = mem_item.memory

                            if mem_type == WORKING_MEMORY_TYPE:
                                continue

                            self.log_adding_memory(
                                memory=mem_content,
                                memory_type=mem_type,
                                user_id=msg.user_id,
                                mem_cube_id=msg.mem_cube_id,
                                mem_cube=msg.mem_cube,
                                log_func_callback=self._submit_web_logs,
                            )

        except Exception as e:
            logger.error(f"Error: {e}", exc_info=True)

    def _mem_read_message_consumer(self, messages: list[ScheduleMessageItem]) -> None:
        logger.info(f"Messages {messages} assigned to {MEM_READ_LABEL} handler.")

        def process_message(message: ScheduleMessageItem):
            try:
                user_id = message.user_id
                mem_cube_id = message.mem_cube_id
                mem_cube = message.mem_cube
                content = message.content

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
                    mem_cube=mem_cube,
                    text_mem=text_mem,
                )

                logger.info(
                    f"Successfully processed mem_read for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

            except Exception as e:
                logger.error(f"Error processing mem_read message: {e}", exc_info=True)

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(messages))) as executor:
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
        mem_cube: GeneralMemCube,
        text_mem: TreeTextMemory,
    ) -> None:
        """
        Process memories using mem_reader for enhanced memory processing.

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
                    logger.warning(f"Failed to get memory {mem_id}: {e}")
                    continue

            if not memory_items:
                logger.warning("No valid memory items found for processing")
                return

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
                    enhanced_mem_ids = text_mem.add(flattened_memories)
                    logger.info(
                        f"Added {len(enhanced_mem_ids)} enhanced memories: {enhanced_mem_ids}"
                    )

                    # Trigger memory reorganization if needed
                    self._trigger_memory_reorganization(
                        text_mem=text_mem, user_id=user_id, mem_cube_id=mem_cube_id
                    )
                else:
                    logger.info("No enhanced memories generated by mem_reader")
            else:
                logger.info("mem_reader returned no processed memories")

            text_mem.delete(mem_ids)
            logger.info("Delete raw mem_ids")
            text_mem.memory_manager.remove_and_refresh_memory()
            logger.info("Remove and Refresh Memories")

        except Exception:
            logger.error(
                f"Error in _process_memories_with_reader: {traceback.format_exc()}", exc_info=True
            )

    def _trigger_memory_reorganization(
        self,
        text_mem: TreeTextMemory,
        user_id: str,
        mem_cube_id: str,
    ) -> None:
        """
        Trigger memory reorganization after enhanced processing.

        Args:
            text_mem: Text memory instance
            user_id: User ID
            mem_cube_id: Memory cube ID
        """
        try:
            # Check if reorganization is enabled
            if hasattr(text_mem, "is_reorganize") and text_mem.is_reorganize:
                logger.info(
                    f"Triggering memory reorganization for user_id={user_id}, mem_cube_id={mem_cube_id}"
                )

                # Get current working memory size
                current_sizes = text_mem.get_current_memory_size()
                logger.info(f"Current memory sizes: {current_sizes}")

                # The reorganization will be handled by the memory manager
                # This is just a trigger point for logging and monitoring
                logger.info("Memory reorganization triggered successfully")
            else:
                logger.info("Memory reorganization is disabled, skipping reorganization trigger")

        except Exception as e:
            logger.error(f"Error in _trigger_memory_reorganization: {e}", exc_info=True)

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
