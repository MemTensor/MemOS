import time

from concurrent.futures import as_completed

from memos.configs.mem_scheduler import BaseSchedulerConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.general_modules.base import BaseSchedulerModule
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE,
    DEFAULT_SCHEDULER_RETRIEVER_RETRIES,
    TreeTextMemory_FINE_SEARCH_METHOD,
    TreeTextMemory_SEARCH_METHOD,
)
from memos.mem_scheduler.utils.filter_utils import (
    filter_too_short_memories,
    filter_vector_based_similar_memories,
    transform_name_to_key,
)
from memos.mem_scheduler.utils.misc_utils import extract_json_obj, extract_list_items_in_answer
from memos.memories.textual.item import TextualMemoryMetadata
from memos.memories.textual.tree import TextualMemoryItem, TreeTextMemory
from memos.types.general_types import (
    FINE_STRATEGY,
    FineStrategy,
    SearchMode,
)

# Extract JSON response
from .memory_filter import MemoryFilter


logger = get_logger(__name__)


class SchedulerRetriever(BaseSchedulerModule):
    def __init__(self, process_llm: BaseLLM, config: BaseSchedulerConfig):
        super().__init__()

        # hyper-parameters
        self.filter_similarity_threshold = 0.75
        self.filter_min_length_threshold = 6
        self.memory_filter = MemoryFilter(process_llm=process_llm, config=config)
        self.process_llm = process_llm
        self.config = config

        # Configure enhancement batching & retries from config with safe defaults
        self.batch_size: int | None = getattr(
            config, "scheduler_retriever_batch_size", DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE
        )
        self.retries: int = getattr(
            config, "scheduler_retriever_enhance_retries", DEFAULT_SCHEDULER_RETRIEVER_RETRIES
        )

    def evaluate_memory_answer_ability(
        self, query: str, memory_texts: list[str], top_k: int | None = None
    ) -> bool:
        limited_memories = memory_texts[:top_k] if top_k is not None else memory_texts
        # Build prompt using the template
        prompt = self.build_prompt(
            template_name="memory_answer_ability_evaluation",
            query=query,
            memory_list="\n".join([f"- {memory}" for memory in limited_memories])
            if limited_memories
            else "No memories available",
        )

        # Use the process LLM to generate response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])

        try:
            result = extract_json_obj(response)

            # Validate response structure
            if "result" in result:
                logger.info(
                    f"Answerability: result={result['result']}; reason={result.get('reason', 'n/a')}; evaluated={len(limited_memories)}"
                )
                return result["result"]
            else:
                logger.warning(f"Answerability: invalid LLM JSON structure; payload={result}")
                return False

        except Exception as e:
            logger.error(f"Answerability: parse failed; err={e}; raw={str(response)[:200]}...")
            # Fallback: return False if we can't determine answer ability
            return False

    # ---------------------- Enhancement helpers ----------------------
    def _build_enhancement_prompt(self, query_history: list[str], batch_texts: list[str]) -> str:
        if len(query_history) == 1:
            query_history = query_history[0]
        else:
            query_history = (
                [f"[{i}] {query}" for i, query in enumerate(query_history)]
                if len(query_history) > 1
                else query_history[0]
            )
        # Include numbering for rewrite mode to help LLM reference original memory IDs
        if FINE_STRATEGY == FineStrategy.REWRITE:
            text_memories = "\n".join([f"- [{i}] {mem}" for i, mem in enumerate(batch_texts)])
            prompt_name = "memory_rewrite_enhancement"
        else:
            text_memories = "\n".join([f"- {mem}" for i, mem in enumerate(batch_texts)])
            prompt_name = "memory_recreate_enhancement"
        return self.build_prompt(
            prompt_name,
            query_history=query_history,
            memories=text_memories,
        )

    def _process_enhancement_batch(
        self,
        batch_index: int,
        query_history: list[str],
        memories: list[TextualMemoryItem],
        retries: int,
    ) -> tuple[list[TextualMemoryItem], bool]:
        attempt = 0
        text_memories = [one.memory for one in memories]

        prompt = self._build_enhancement_prompt(
            query_history=query_history, batch_texts=text_memories
        )

        llm_response = None
        while attempt <= max(0, retries) + 1:
            try:
                llm_response = self.process_llm.generate([{"role": "user", "content": prompt}])
                processed_text_memories = extract_list_items_in_answer(llm_response)
                if len(processed_text_memories) > 0:
                    # create new
                    enhanced_memories = []
                    user_id = memories[0].metadata.user_id
                    if FINE_STRATEGY == FineStrategy.RECREATE:
                        for new_mem in processed_text_memories:
                            enhanced_memories.append(
                                TextualMemoryItem(
                                    memory=new_mem,
                                    metadata=TextualMemoryMetadata(
                                        user_id=user_id, memory_type="LongTermMemory"
                                    ),  # TODO add memory_type
                                )
                            )
                    elif FINE_STRATEGY == FineStrategy.REWRITE:
                        # Parse index from each processed line and rewrite corresponding original memory
                        def _parse_index_and_text(s: str) -> tuple[int | None, str]:
                            import re

                            s = (s or "").strip()
                            # Preferred: [index] text
                            m = re.match(r"^\s*\[(\d+)\]\s*(.+)$", s)
                            if m:
                                return int(m.group(1)), m.group(2).strip()
                            # Fallback: index: text or index - text
                            m = re.match(r"^\s*(\d+)\s*[:\-\)]\s*(.+)$", s)
                            if m:
                                return int(m.group(1)), m.group(2).strip()
                            return None, s

                        idx_to_original = dict(enumerate(memories))
                        for j, item in enumerate(processed_text_memories):
                            idx, new_text = _parse_index_and_text(item)
                            if idx is not None and idx in idx_to_original:
                                orig = idx_to_original[idx]
                            else:
                                # Fallback: align by order if index missing/invalid
                                orig = memories[j] if j < len(memories) else None
                            if not orig:
                                continue
                            enhanced_memories.append(
                                TextualMemoryItem(
                                    id=orig.id,
                                    memory=new_text,
                                    metadata=orig.metadata,
                                )
                            )
                    else:
                        logger.error(f"Fine search strategy {FINE_STRATEGY} not exists")

                    logger.info(
                        f"[enhance_memories_with_query] ✅ done | Strategy={FINE_STRATEGY} | prompt={prompt} | llm_response={llm_response}"
                    )
                    return enhanced_memories, True
                else:
                    raise ValueError(
                        f"Fail to run memory enhancement; retry {attempt}/{max(1, retries) + 1}; processed_text_memories: {processed_text_memories}"
                    )
            except Exception as e:
                attempt += 1
                time.sleep(1)
                logger.debug(
                    f"[enhance_memories_with_query][batch={batch_index}] 🔁 retry {attempt}/{max(1, retries) + 1} failed: {e}"
                )
        logger.error(
            f"Fail to run memory enhancement; prompt: {prompt};\n llm_response: {llm_response}",
            exc_info=True,
        )
        return memories, False

    @staticmethod
    def _split_batches(
        memories: list[TextualMemoryItem], batch_size: int
    ) -> list[tuple[int, int, list[TextualMemoryItem]]]:
        batches: list[tuple[int, int, list[TextualMemoryItem]]] = []
        start = 0
        n = len(memories)
        while start < n:
            end = min(start + batch_size, n)
            batches.append((start, end, memories[start:end]))
            start = end
        return batches

    def recall_for_missing_memories(
        self,
        query: str,
        memories: list[str],
    ) -> tuple[str, bool]:
        text_memories = "\n".join([f"- {mem}" for i, mem in enumerate(memories)])

        prompt = self.build_prompt(
            template_name="enlarge_recall",
            query=query,
            memories_inline=text_memories,
        )
        llm_response = self.process_llm.generate([{"role": "user", "content": prompt}])

        json_result: dict = extract_json_obj(llm_response)

        logger.info(
            f"[recall_for_missing_memories] ✅ done | prompt={prompt} | llm_response={llm_response}"
        )

        hint = json_result.get("hint", "")
        if len(hint) == 0:
            return hint, False
        return hint, json_result.get("trigger_recall", False)

    def search(
        self,
        query: str,
        user_id: str,
        mem_cube_id: str,
        mem_cube: GeneralMemCube,
        top_k: int,
        method: str = TreeTextMemory_SEARCH_METHOD,
        search_args: dict | None = None,
    ) -> list[TextualMemoryItem]:
        """Search in text memory with the given query.

        Args:
            query: The search query string
            top_k: Number of top results to return
            method: Search method to use

        Returns:
            Search results or None if not implemented
        """
        text_mem_base = mem_cube.text_mem
        # Normalize default for mutable argument
        search_args = search_args or {}
        try:
            if method in [TreeTextMemory_SEARCH_METHOD, TreeTextMemory_FINE_SEARCH_METHOD]:
                assert isinstance(text_mem_base, TreeTextMemory)
                session_id = search_args.get("session_id", "default_session")
                target_session_id = session_id
                search_priority = (
                    {"session_id": target_session_id} if "session_id" in search_args else None
                )
                search_filter = search_args.get("filter")
                search_source = search_args.get("source")
                plugin = bool(search_source is not None and search_source == "plugin")
                user_name = search_args.get("user_name", mem_cube_id)
                internet_search = search_args.get("internet_search", False)
                chat_history = search_args.get("chat_history")
                search_tool_memory = search_args.get("search_tool_memory", False)
                tool_mem_top_k = search_args.get("tool_mem_top_k", 6)
                playground_search_goal_parser = search_args.get(
                    "playground_search_goal_parser", False
                )

                info = search_args.get(
                    "info",
                    {
                        "user_id": user_id,
                        "session_id": target_session_id,
                        "chat_history": chat_history,
                    },
                )

                results_long_term = mem_cube.text_mem.search(
                    query=query,
                    user_name=user_name,
                    top_k=top_k,
                    mode=SearchMode.FAST,
                    manual_close_internet=not internet_search,
                    memory_type="LongTermMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    info=info,
                    plugin=plugin,
                    search_tool_memory=search_tool_memory,
                    tool_mem_top_k=tool_mem_top_k,
                    playground_search_goal_parser=playground_search_goal_parser,
                )

                results_user = mem_cube.text_mem.search(
                    query=query,
                    user_name=user_name,
                    top_k=top_k,
                    mode=SearchMode.FAST,
                    manual_close_internet=not internet_search,
                    memory_type="UserMemory",
                    search_filter=search_filter,
                    search_priority=search_priority,
                    info=info,
                    plugin=plugin,
                    search_tool_memory=search_tool_memory,
                    tool_mem_top_k=tool_mem_top_k,
                    playground_search_goal_parser=playground_search_goal_parser,
                )
                results = results_long_term + results_user
            else:
                raise NotImplementedError(str(type(text_mem_base)))
        except Exception as e:
            logger.error(f"Fail to search. The exeption is {e}.", exc_info=True)
            results = []
        return results

    def enhance_memories_with_query(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        """
        Enhance memories by adding context and making connections to better answer queries.

        Args:
            query_history: List of user queries in chronological order
            memories: List of memory items to enhance

        Returns:
            Tuple of (enhanced_memories, success_flag)
        """
        if not memories:
            logger.warning("[Enhance] ⚠️ skipped (no memories to process)")
            return memories, True

        batch_size = self.batch_size
        retries = self.retries
        num_of_memories = len(memories)
        try:
            # no parallel
            if batch_size is None or num_of_memories <= batch_size:
                # Single batch path with retry
                enhanced_memories, success_flag = self._process_enhancement_batch(
                    batch_index=0,
                    query_history=query_history,
                    memories=memories,
                    retries=retries,
                )

                all_success = success_flag
            else:
                # parallel running batches
                # Split into batches preserving order
                batches = self._split_batches(memories=memories, batch_size=batch_size)

                # Process batches concurrently
                all_success = True
                failed_batches = 0
                with ContextThreadPoolExecutor(max_workers=len(batches)) as executor:
                    future_map = {
                        executor.submit(
                            self._process_enhancement_batch, bi, query_history, texts, retries
                        ): (bi, s, e)
                        for bi, (s, e, texts) in enumerate(batches)
                    }
                    enhanced_memories = []
                    for fut in as_completed(future_map):
                        bi, s, e = future_map[fut]

                        batch_memories, ok = fut.result()
                        enhanced_memories.extend(batch_memories)
                        if not ok:
                            all_success = False
                            failed_batches += 1
                logger.info(
                    f"[Enhance] ✅ multi-batch done | batches={len(batches)} | enhanced={len(enhanced_memories)} |"
                    f" failed_batches={failed_batches} | success={all_success}"
                )

        except Exception as e:
            logger.error(f"[Enhance] ❌ fatal error: {e}", exc_info=True)
            all_success = False
            enhanced_memories = memories

        if len(enhanced_memories) == 0:
            enhanced_memories = []
            logger.error("[Enhance] ❌ fatal error: enhanced_memories is empty", exc_info=True)
        return enhanced_memories, all_success

    def rerank_memories(
        self, queries: list[str], original_memories: list[str], top_k: int
    ) -> (list[str], bool):
        """
        Rerank memories based on relevance to given queries using LLM.

        Args:
            queries: List of query strings to determine relevance
            original_memories: List of memory strings to be reranked
            top_k: Number of top memories to return after reranking

        Returns:
            List of reranked memory strings (length <= top_k)

        Note:
            If LLM reranking fails, falls back to original order (truncated to top_k)
        """

        logger.info(f"Starting memory reranking for {len(original_memories)} memories")

        # Build LLM prompt for memory reranking
        prompt = self.build_prompt(
            "memory_reranking",
            queries=[f"[0] {queries[0]}"],
            current_order=[f"[{i}] {mem}" for i, mem in enumerate(original_memories)],
        )
        logger.debug(f"Generated reranking prompt: {prompt[:200]}...")  # Log first 200 chars

        # Get LLM response
        response = self.process_llm.generate([{"role": "user", "content": prompt}])
        logger.debug(f"Received LLM response: {response[:200]}...")  # Log first 200 chars

        try:
            # Parse JSON response
            response = extract_json_obj(response)
            new_order = response["new_order"][:top_k]
            text_memories_with_new_order = [original_memories[idx] for idx in new_order]
            logger.info(
                f"Successfully reranked memories. Returning top {len(text_memories_with_new_order)} items;"
                f"Ranking reasoning: {response['reasoning']}"
            )
            success_flag = True
        except Exception as e:
            logger.error(
                f"Failed to rerank memories with LLM. Exception: {e}. Raw response: {response} ",
                exc_info=True,
            )
            text_memories_with_new_order = original_memories[:top_k]
            success_flag = False
        return text_memories_with_new_order, success_flag

    def process_and_rerank_memories(
        self,
        queries: list[str],
        original_memory: list[TextualMemoryItem],
        new_memory: list[TextualMemoryItem],
        top_k: int = 10,
    ) -> list[TextualMemoryItem] | None:
        """
        Process and rerank memory items by combining original and new memories,
        applying filters, and then reranking based on relevance to queries.

        Args:
            queries: List of query strings to rerank memories against
            original_memory: List of original TextualMemoryItem objects
            new_memory: List of new TextualMemoryItem objects to merge
            top_k: Maximum number of memories to return after reranking

        Returns:
            List of reranked TextualMemoryItem objects, or None if processing fails
        """
        # Combine original and new memories into a single list
        combined_memory = original_memory + new_memory

        # Create a mapping from normalized text to memory objects
        memory_map = {
            transform_name_to_key(name=mem_obj.memory): mem_obj for mem_obj in combined_memory
        }

        # Extract normalized text representations from all memory items
        combined_text_memory = [m.memory for m in combined_memory]

        # Apply similarity filter to remove overly similar memories
        filtered_combined_text_memory = filter_vector_based_similar_memories(
            text_memories=combined_text_memory,
            similarity_threshold=self.filter_similarity_threshold,
        )

        # Apply length filter to remove memories that are too short
        filtered_combined_text_memory = filter_too_short_memories(
            text_memories=filtered_combined_text_memory,
            min_length_threshold=self.filter_min_length_threshold,
        )

        # Ensure uniqueness of memory texts using dictionary keys (preserves order)
        unique_memory = list(dict.fromkeys(filtered_combined_text_memory))

        # Rerank the filtered memories based on relevance to the queries
        text_memories_with_new_order, success_flag = self.rerank_memories(
            queries=queries,
            original_memories=unique_memory,
            top_k=top_k,
        )

        # Map reranked text entries back to their original memory objects
        memories_with_new_order = []
        for text in text_memories_with_new_order:
            normalized_text = transform_name_to_key(name=text)
            if normalized_text in memory_map:  # Ensure correct key matching
                memories_with_new_order.append(memory_map[normalized_text])
            else:
                logger.warning(
                    f"Memory text not found in memory map. text: {text};\n"
                    f"Keys of memory_map: {memory_map.keys()}"
                )

        return memories_with_new_order, success_flag

    def filter_unrelated_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        return self.memory_filter.filter_unrelated_memories(query_history, memories)

    def filter_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        return self.memory_filter.filter_redundant_memories(query_history, memories)

    def filter_unrelated_and_redundant_memories(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> (list[TextualMemoryItem], bool):
        """
        Filter out both unrelated and redundant memories using LLM analysis.

        This method delegates to the MemoryFilter class.
        """
        return self.memory_filter.filter_unrelated_and_redundant_memories(query_history, memories)
