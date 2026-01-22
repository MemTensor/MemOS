import copy
import time

from concurrent.futures import as_completed
from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.mem_scheduler.utils.misc_utils import extract_json_obj, extract_list_items_in_answer
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.bm25_util import EnhancedBM25
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import (
    FastTokenizer,
    parse_structured_output,
)
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.base import BaseReranker
from memos.templates.advanced_search_prompts import PROMPT_MAPPING
from memos.types.general_types import FINE_STRATEGY, FineStrategy, SearchMode


logger = get_logger(__name__)


class AdvancedSearcher(Searcher):
    def __init__(
        self,
        dispatcher_llm: OpenAILLM | OllamaLLM | AzureLLM,
        graph_store: Neo4jGraphDB,
        embedder: OllamaEmbedder,
        reranker: BaseReranker,
        bm25_retriever: EnhancedBM25 | None = None,
        internet_retriever: None = None,
        search_strategy: dict | None = None,
        manual_close_internet: bool = True,
        process_llm: Any | None = None,
        tokenizer: FastTokenizer | None = None,
        include_embedding: bool = False,
    ):
        super().__init__(
            dispatcher_llm=dispatcher_llm,
            graph_store=graph_store,
            embedder=embedder,
            reranker=reranker,
            bm25_retriever=bm25_retriever,
            internet_retriever=internet_retriever,
            search_strategy=search_strategy,
            manual_close_internet=manual_close_internet,
            tokenizer=tokenizer,
            include_embedding=include_embedding,
        )

        self.stage_retrieve_top = 3
        self.process_llm = process_llm
        self.thinking_stages = 3
        self.max_retry_times = 2
        self.deep_search_top_k_bar = 2

    def load_template(self, template_name: str) -> str:
        if template_name not in PROMPT_MAPPING:
            logger.error("Prompt template is not found!")
        prompt = PROMPT_MAPPING[template_name]
        return prompt

    def build_prompt(self, template_name: str, **kwargs) -> str:
        template = self.load_template(template_name)
        if not template:
            raise FileNotFoundError(f"Prompt template `{template_name}` not found.")
        return template.format(**kwargs)

    def stage_retrieve(
        self,
        stage_id: int,
        query: str,
        previous_retrieval_phrases: list[str],
        text_memories: str,
    ) -> tuple[bool, str, list[str]]:
        """Run a retrieval-expansion stage and parse structured LLM output.

        Returns a tuple of:
        - can_answer: whether current memories suffice to answer
        - reason: brief reasoning or hypotheses
        - context: synthesized context summary
        - retrieval_phrases: list of phrases to retrieve next
        """

        # Format previous phrases as bullet list to align with prompt expectations
        prev_phrases_text = (
            "- " + "\n- ".join(previous_retrieval_phrases) if previous_retrieval_phrases else ""
        )

        args = {
            "template_name": f"stage{stage_id}_expand_retrieve",
            "query": query,
            "previous_retrieval_phrases": prev_phrases_text,
            "memories": text_memories,
        }
        prompt = self.build_prompt(**args)

        max_attempts = max(0, self.max_retry_times) + 1
        for attempt in range(1, max_attempts + 1):
            try:
                llm_response = self.process_llm.generate(
                    [{"role": "user", "content": prompt}]
                ).strip()
                result = parse_structured_output(content=llm_response)

                # Parse booleans and fallbacks robustly
                can_answer_str = str(result.get("can_answer", "")).strip().lower()
                can_answer = can_answer_str in {"true", "yes", "y", "1"}

                reason = result.get("reason", "")

                phrases_val = result.get("retrieval_phrases", result.get("retrival_phrases", []))
                if isinstance(phrases_val, list):
                    retrieval_phrases = [str(p).strip() for p in phrases_val if str(p).strip()]
                elif isinstance(phrases_val, str) and phrases_val.strip():
                    retrieval_phrases = [p.strip() for p in phrases_val.splitlines() if p.strip()]
                else:
                    retrieval_phrases = []

                return can_answer, reason, retrieval_phrases

            except Exception as e:
                if attempt < max_attempts:
                    logger.debug(f"[stage_retrieve]🔁 retry {attempt}/{max_attempts} failed: {e!s}")
                    time.sleep(1)
                else:
                    logger.error(
                        f"[stage_retrieve]❌ all {max_attempts} attempts failed: {e!s}; \nprompt: {prompt}",
                        exc_info=True,
                    )
                    raise e

    def judge_memories(self, query: str, text_memories: str):
        args = {
            "template_name": "memory_judgement",
            "query": query,
            "memories": text_memories,
        }

        prompt = self.build_prompt(**args)

        max_attempts = max(0, self.max_retry_times) + 1
        for attempt in range(1, max_attempts + 1):
            try:
                llm_response = self.process_llm.generate([{"role": "user", "content": prompt}])
                result = parse_structured_output(content=llm_response)
                reason, can_answer = (
                    result["reason"],
                    result["can_answer"],
                )

                return reason, can_answer
            except Exception as e:
                if attempt < max_attempts:
                    logger.debug(
                        f"[summarize_and_eval]🔁 retry {attempt}/{max_attempts} failed: {e!s}"
                    )
                    time.sleep(1)
                else:
                    logger.error(
                        f"[summarize_and_eval]❌ all {max_attempts} attempts failed: {e!s}; \nprompt: {prompt}",
                        exc_info=True,
                    )
                    raise e

    def tree_memories_to_text_memories(self, memories: list[TextualMemoryItem]):
        mem_list = []
        source_documents = []
        for mem in memories:
            source_documents.extend(
                [f"({one.chat_time}) {one.content}" for one in mem.metadata.sources]
            )
            mem_list.append(mem.memory)
        mem_list = list(set(mem_list))
        source_documents = list(set(source_documents))
        return mem_list, source_documents

    def get_final_memories(self, user_id: str, top_k: int, mem_list: list[str]):
        enhanced_memories = []
        for new_mem in mem_list:
            enhanced_memories.append(
                TextualMemoryItem(memory=new_mem, metadata=TextualMemoryMetadata(user_id=user_id))
            )
        if len(enhanced_memories) > top_k:
            logger.info(
                f"Result count {len(enhanced_memories)} exceeds requested top_k {top_k}, truncating to top {top_k} memories"
            )
        result_memories = enhanced_memories[:top_k]
        return result_memories

    def memory_recreate_enhancement(
        self,
        query: str,
        top_k: int,
        text_memories: list[str],
        retries: int,
    ) -> list:
        attempt = 0
        text_memories = "\n".join([f"- [{i}] {mem}" for i, mem in enumerate(text_memories)])
        prompt_name = "memory_recreate_enhancement"
        prompt = self.build_prompt(
            template_name=prompt_name, query=query, top_k=top_k, memories=text_memories
        )

        llm_response = None
        while attempt <= max(0, retries) + 1:
            try:
                llm_response = self.process_llm.generate([{"role": "user", "content": prompt}])
                processed_text_memories = parse_structured_output(content=llm_response)
                logger.debug(
                    f"[memory_recreate_enhancement]\n "
                    f"- original memories: \n"
                    f"{text_memories}\n"
                    f"- final memories: \n"
                    f"{processed_text_memories['answer']}"
                )
                return processed_text_memories["answer"]
            except Exception as e:
                attempt += 1
                time.sleep(1)
                logger.debug(
                    f"[memory_recreate_enhancement] 🔁 retry {attempt}/{max(1, retries) + 1} failed: {e}"
                )
        logger.error(
            f"Fail to run memory enhancement; prompt: {prompt};\n llm_response: {llm_response}",
            exc_info=True,
        )
        raise ValueError("Fail to run memory enhancement")

    def deep_search(
        self,
        query: str,
        top_k: int,
        info=None,
        memory_type="All",
        search_filter: dict | None = None,
        user_name: str | None = None,
        **kwargs,
    ):
        previous_retrieval_phrases = [query]
        retrieved_memories = self.retrieve(
            query=query,
            user_name=user_name,
            top_k=top_k,
            mode=SearchMode.FAST,
            memory_type=memory_type,
            search_filter=search_filter,
            info=info,
        )
        memories = self.post_retrieve(
            retrieved_results=retrieved_memories,
            top_k=top_k,
            user_name=user_name,
            info=info,
        )
        if len(memories) == 0:
            logger.warning("Requirements not met; returning memories as-is.")
            return memories

        user_id = memories[0].metadata.user_id

        mem_list, _ = self.tree_memories_to_text_memories(memories=memories)
        retrieved_memories = copy.deepcopy(retrieved_memories)
        rewritten_flag = False
        for current_stage_id in range(self.thinking_stages + 1):
            try:
                # at last
                if current_stage_id == self.thinking_stages:
                    # eval to finish
                    reason, can_answer = self.judge_memories(
                        query=query,
                        text_memories="- " + "\n- ".join(mem_list) + "\n",
                    )

                    logger.info(
                        f"Final Stage: Stage {current_stage_id}; "
                        f"previous retrieval phrases have been tried: {previous_retrieval_phrases}; "
                        f"final can_answer: {can_answer}; reason: {reason}"
                    )
                    if rewritten_flag:
                        enhanced_memories = self.get_final_memories(
                            user_id=user_id, top_k=top_k, mem_list=mem_list
                        )
                    else:
                        enhanced_memories = memories
                    return enhanced_memories[:top_k]

                can_answer, reason, retrieval_phrases = self.stage_retrieve(
                    stage_id=current_stage_id + 1,
                    query=query,
                    previous_retrieval_phrases=previous_retrieval_phrases,
                    text_memories="- " + "\n- ".join(mem_list) + "\n",
                )
                if can_answer:
                    logger.info(
                        f"Stage {current_stage_id}: determined answer can be provided, creating enhanced memories; reason: {reason}",
                    )
                    if rewritten_flag:
                        enhanced_memories = self.get_final_memories(
                            user_id=user_id, top_k=top_k, mem_list=mem_list
                        )
                    else:
                        enhanced_memories = memories
                    return enhanced_memories[:top_k]
                else:
                    previous_retrieval_phrases.extend(retrieval_phrases)
                    logger.info(
                        f"Start complementary retrieval for Stage {current_stage_id}; "
                        f"previous retrieval phrases have been tried: {previous_retrieval_phrases}; "
                        f"can_answer: {can_answer}; reason: {reason}"
                    )
                    logger.info(
                        "Stage %d - Found %d new retrieval phrases",
                        current_stage_id,
                        len(retrieval_phrases),
                    )
                    # Search for additional memories based on retrieval phrases
                    additional_retrieved_memories = []
                    for phrase in retrieval_phrases:
                        _retrieved_memories = self.retrieve(
                            query=phrase,
                            user_name=user_name,
                            top_k=self.stage_retrieve_top,
                            mode=SearchMode.FAST,
                            memory_type=memory_type,
                            search_filter=search_filter,
                            info=info,
                        )
                        logger.info(
                            "Found %d additional memories for phrase: '%s'",
                            len(_retrieved_memories),
                            phrase[:30] + "..." if len(phrase) > 30 else phrase,
                        )
                        additional_retrieved_memories.extend(_retrieved_memories)
                    merged_memories = self.post_retrieve(
                        retrieved_results=retrieved_memories + additional_retrieved_memories,
                        top_k=top_k * 2,
                        user_name=user_name,
                        info=info,
                    )
                    rewritten_flag = True
                    _mem_list, _ = self.tree_memories_to_text_memories(memories=merged_memories)
                    mem_list = _mem_list
                    mem_list = list(set(mem_list))
                    mem_list = self.memory_recreate_enhancement(
                        query=query,
                        top_k=top_k,
                        text_memories=mem_list,
                        retries=self.max_retry_times,
                    )
                    logger.info(
                        "After stage %d, total memories in list: %d",
                        current_stage_id,
                        len(mem_list),
                    )

            except Exception as e:
                logger.error("Error in stage %d: %s", current_stage_id, str(e), exc_info=True)
                # Continue to next stage instead of failing completely
                continue
        logger.error("Deep search failed, returning original memories")
        return memories

    def enhance_memories_with_query(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
        batch_size: int | None = None,
        retries: int = 2,
    ) -> tuple[list[TextualMemoryItem], bool]:
        """
        Enhance memories by adding context and making connections to queries.
        
        This method uses LLM to rewrite or recreate memories to better align
        with the given query history, making them more relevant and contextual.
        
        Args:
            query_history: List of user queries in chronological order
            memories: List of memory items to enhance
            batch_size: Optional batch size for parallel processing
            retries: Number of retries for LLM calls
            
        Returns:
            Tuple of (enhanced_memories, success_flag)
            - enhanced_memories: Enhanced memory items
            - success_flag: True if all batches processed successfully
        """
        if not memories:
            logger.warning("[Enhance] ⚠️ skipped (no memories to process)")
            return memories, True

        num_of_memories = len(memories)

        try:
            # Single batch path (no parallelization)
            if batch_size is None or num_of_memories <= batch_size:
                enhanced_memories, success_flag = self._process_enhancement_batch(
                    batch_index=0,
                    query_history=query_history,
                    memories=memories,
                    retries=retries,
                )
                all_success = success_flag
            else:
                # Parallel batch processing
                batches = self._split_batches(memories=memories, batch_size=batch_size)
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
                    f"[Enhance] ✅ multi-batch done | batches={len(batches)} | "
                    f"enhanced={len(enhanced_memories)} | failed_batches={failed_batches} | "
                    f"success={all_success}"
                )

        except Exception as e:
            logger.error(f"[Enhance] ❌ fatal error: {e}", exc_info=True)
            all_success = False
            enhanced_memories = memories

        if len(enhanced_memories) == 0:
            enhanced_memories = []
            logger.error("[Enhance] ❌ fatal error: enhanced_memories is empty", exc_info=True)
            
        return enhanced_memories, all_success

    def _process_enhancement_batch(
        self,
        batch_index: int,
        query_history: list[str],
        memories: list[TextualMemoryItem],
        retries: int,
    ) -> tuple[list[TextualMemoryItem], bool]:
        """
        Process a single batch of memories for enhancement.
        
        This method handles retry logic and strategy-specific enhancement
        (REWRITE vs RECREATE).
        """
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
                    enhanced_memories = self._create_enhanced_memories(
                        processed_text_memories=processed_text_memories,
                        original_memories=memories,
                    )
                    
                    logger.info(
                        f"[enhance_memories_with_query] ✅ done | Strategy={FINE_STRATEGY} | "
                        f"batch={batch_index}"
                    )
                    return enhanced_memories, True
                else:
                    raise ValueError(
                        f"Fail to run memory enhancement; retry {attempt}/{max(1, retries) + 1}; "
                        f"processed_text_memories: {processed_text_memories}"
                    )
                    
            except Exception as e:
                attempt += 1
                time.sleep(1)
                logger.debug(
                    f"[enhance_memories_with_query][batch={batch_index}] "
                    f"🔁 retry {attempt}/{max(1, retries) + 1} failed: {e}"
                )
                
        logger.error(
            f"Fail to run memory enhancement; prompt: {prompt};\n llm_response: {llm_response}",
            exc_info=True,
        )
        return memories, False

    def _build_enhancement_prompt(
        self, query_history: list[str], batch_texts: list[str]
    ) -> str:
        """Build the LLM prompt for memory enhancement."""
        if len(query_history) == 1:
            query_history_formatted = query_history[0]
        else:
            query_history_formatted = (
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
            query_history=query_history_formatted,
            memories=text_memories,
        )

    def _create_enhanced_memories(
        self,
        processed_text_memories: list[str],
        original_memories: list[TextualMemoryItem],
    ) -> list[TextualMemoryItem]:
        """
        Create enhanced memory items based on the processing strategy.
        
        Supports two strategies:
        - RECREATE: Create new memory items with enhanced text
        - REWRITE: Rewrite existing memories while preserving metadata
        """
        enhanced_memories = []
        user_id = original_memories[0].metadata.user_id

        if FINE_STRATEGY == FineStrategy.RECREATE:
            for new_mem in processed_text_memories:
                enhanced_memories.append(
                    TextualMemoryItem(
                        memory=new_mem,
                        metadata=TextualMemoryMetadata(
                            user_id=user_id, memory_type="LongTermMemory"
                        ),
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

            idx_to_original = dict(enumerate(original_memories))
            for j, item in enumerate(processed_text_memories):
                idx, new_text = _parse_index_and_text(item)
                if idx is not None and idx in idx_to_original:
                    orig = idx_to_original[idx]
                else:
                    # Fallback: align by order if index missing/invalid
                    orig = original_memories[j] if j < len(original_memories) else None
                    
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

        return enhanced_memories

    @staticmethod
    def _split_batches(
        memories: list[TextualMemoryItem], batch_size: int
    ) -> list[tuple[int, int, list[TextualMemoryItem]]]:
        """Split memories into batches for parallel processing."""
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
        """
        Analyze memories and generate hint for additional recall.
        
        This method uses LLM to determine if the current memories are sufficient
        or if additional recall is needed, along with a hint for the recall query.
        
        Args:
            query: Original user query
            memories: List of currently retrieved memory texts
            
        Returns:
            Tuple of (hint, trigger_recall)
            - hint: Suggested query for additional recall
            - trigger_recall: Whether to trigger additional recall
        """
        text_memories = "\n".join([f"- {mem}" for i, mem in enumerate(memories)])

        prompt = self.build_prompt(
            template_name="enlarge_recall",
            query=query,
            memories_inline=text_memories,
        )
        llm_response = self.process_llm.generate([{"role": "user", "content": prompt}])

        json_result: dict = extract_json_obj(llm_response)

        logger.info(
            f"[recall_for_missing_memories] ✅ done | prompt={prompt} | "
            f"llm_response={llm_response}"
        )

        hint = json_result.get("hint", "")
        if len(hint) == 0:
            return hint, False
        return hint, json_result.get("trigger_recall", False)
