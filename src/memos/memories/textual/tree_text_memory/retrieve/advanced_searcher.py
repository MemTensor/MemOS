import copy
import time

from typing import Any

from memos.embedders.factory import OllamaEmbedder
from memos.graph_dbs.factory import Neo4jGraphDB
from memos.llms.factory import AzureLLM, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.memories.textual.tree_text_memory.retrieve.bm25_util import EnhancedBM25
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import (
    FastTokenizer,
    parse_structured_output,
)
from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.reranker.base import BaseReranker
from memos.templates.advanced_search_prompts import PROMPT_MAPPING
from memos.types.general_types import SearchMode


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
