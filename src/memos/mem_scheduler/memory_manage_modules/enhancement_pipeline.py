from __future__ import annotations

import time

from typing import TYPE_CHECKING

from memos.log import get_logger
from memos.mem_scheduler.schemas.general_schemas import (
    DEFAULT_SCHEDULER_RETRIEVER_BATCH_SIZE,
    DEFAULT_SCHEDULER_RETRIEVER_RETRIES,
)
from memos.mem_scheduler.utils.misc_utils import extract_json_obj, extract_list_items_in_answer
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.types.general_types import FINE_STRATEGY, FineStrategy


logger = get_logger(__name__)

if TYPE_CHECKING:
    from collections.abc import Callable


class EnhancementPipeline:
    def __init__(self, process_llm, config, build_prompt: Callable[..., str]):
        self.process_llm = process_llm
        self.config = config
        self.build_prompt = build_prompt
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
        prompt = self.build_prompt(
            template_name="memory_answer_ability_evaluation",
            query=query,
            memory_list="\n".join([f"- {memory}" for memory in limited_memories])
            if limited_memories
            else "No memories available",
        )

        response = self.process_llm.generate([{"role": "user", "content": prompt}])

        try:
            result = extract_json_obj(response)

            if "result" in result:
                logger.info(
                    "Answerability: result=%s; reason=%s; evaluated=%s",
                    result["result"],
                    result.get("reason", "n/a"),
                    len(limited_memories),
                )
                return result["result"]
            logger.warning("Answerability: invalid LLM JSON structure; payload=%s", result)
            return False

        except Exception as e:
            logger.error("Answerability: parse failed; err=%s; raw=%s...", e, str(response)[:200])
            return False

    def _build_enhancement_prompt(self, query_history: list[str], batch_texts: list[str]) -> str:
        if len(query_history) == 1:
            query_history = query_history[0]
        else:
            query_history = (
                [f"[{i}] {query}" for i, query in enumerate(query_history)]
                if len(query_history) > 1
                else query_history[0]
            )
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
                    enhanced_memories = []
                    user_id = memories[0].metadata.user_id
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

                        def _parse_index_and_text(s: str) -> tuple[int | None, str]:
                            import re

                            s = (s or "").strip()
                            m = re.match(r"^\s*\[(\d+)\]\s*(.+)$", s)
                            if m:
                                return int(m.group(1)), m.group(2).strip()
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
                        logger.error("Fine search strategy %s not exists", FINE_STRATEGY)

                    logger.info(
                        "[enhance_memories_with_query] done | Strategy=%s | prompt=%s | llm_response=%s",
                        FINE_STRATEGY,
                        prompt,
                        llm_response,
                    )
                    return enhanced_memories, True
                raise ValueError(
                    "Fail to run memory enhancement; retry "
                    f"{attempt}/{max(1, retries) + 1}; "
                    f"processed_text_memories: {processed_text_memories}"
                )
            except Exception as e:
                attempt += 1
                time.sleep(1)
                logger.debug(
                    "[enhance_memories_with_query][batch=%s] retry %s/%s failed: %s",
                    batch_index,
                    attempt,
                    max(1, retries) + 1,
                    e,
                )
        logger.error(
            "Fail to run memory enhancement; prompt: %s;\n llm_response: %s",
            prompt,
            llm_response,
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

    def recall_for_missing_memories(self, query: str, memories: list[str]) -> tuple[str, bool]:
        text_memories = "\n".join([f"- {mem}" for i, mem in enumerate(memories)])

        prompt = self.build_prompt(
            template_name="enlarge_recall",
            query=query,
            memories_inline=text_memories,
        )
        llm_response = self.process_llm.generate([{"role": "user", "content": prompt}])

        json_result: dict = extract_json_obj(llm_response)

        logger.info(
            "[recall_for_missing_memories] done | prompt=%s | llm_response=%s",
            prompt,
            llm_response,
        )

        hint = json_result.get("hint", "")
        if len(hint) == 0:
            return hint, False
        return hint, json_result.get("trigger_recall", False)

    def enhance_memories_with_query(
        self,
        query_history: list[str],
        memories: list[TextualMemoryItem],
    ) -> tuple[list[TextualMemoryItem], bool]:
        if not memories:
            logger.warning("[Enhance] skipped (no memories to process)")
            return memories, True

        batch_size = self.batch_size
        retries = self.retries
        num_of_memories = len(memories)
        try:
            if batch_size is None or num_of_memories <= batch_size:
                enhanced_memories, success_flag = self._process_enhancement_batch(
                    batch_index=0,
                    query_history=query_history,
                    memories=memories,
                    retries=retries,
                )

                all_success = success_flag
            else:
                batches = self._split_batches(memories=memories, batch_size=batch_size)

                all_success = True
                failed_batches = 0
                from concurrent.futures import as_completed

                from memos.context.context import ContextThreadPoolExecutor

                with ContextThreadPoolExecutor(max_workers=len(batches)) as executor:
                    future_map = {
                        executor.submit(
                            self._process_enhancement_batch, bi, query_history, texts, retries
                        ): (bi, s, e)
                        for bi, (s, e, texts) in enumerate(batches)
                    }
                    enhanced_memories = []
                    for fut in as_completed(future_map):
                        _bi, _s, _e = future_map[fut]

                        batch_memories, ok = fut.result()
                        enhanced_memories.extend(batch_memories)
                        if not ok:
                            all_success = False
                            failed_batches += 1
                logger.info(
                    "[Enhance] multi-batch done | batches=%s | enhanced=%s | failed_batches=%s | success=%s",
                    len(batches),
                    len(enhanced_memories),
                    failed_batches,
                    all_success,
                )

        except Exception as e:
            logger.error("[Enhance] fatal error: %s", e, exc_info=True)
            all_success = False
            enhanced_memories = memories

        if len(enhanced_memories) == 0:
            enhanced_memories = []
            logger.error("[Enhance] fatal error: enhanced_memories is empty", exc_info=True)
        return enhanced_memories, all_success
