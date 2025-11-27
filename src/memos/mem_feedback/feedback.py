import concurrent.futures
import difflib
import json

from datetime import datetime

from tenacity import retry, stop_after_attempt, wait_exponential

from memos import log
from memos.configs.memory import MemFeedbackConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder
from memos.graph_dbs.factory import GraphStoreFactory, PolarDBGraphDB
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.mem_feedback.base import BaseMemFeedback
from memos.mem_reader.factory import MemReaderFactory
from memos.mem_reader.simple_struct import detect_lang
from memos.memories.textual.item import TextualMemoryItem, TreeNodeTextualMemoryMetadata
from memos.memories.textual.tree_text_memory.organize.manager import MemoryManager
from memos.templates.mem_feedback_prompts import (
    FEEDBACK_ANSWER_PROMPT,
    FEEDBACK_ANSWER_PROMPT_ZH,
    FEEDBACK_JUDGEMENT_PROMPT,
    FEEDBACK_JUDGEMENT_PROMPT_ZH,
    UPDATE_FORMER_MEMORIES,
    UPDATE_FORMER_MEMORIES_ZH,
)
from memos.types import MessageDict


FEEDBACK_PROMPT_DICT = {
    "judge": {"en": FEEDBACK_JUDGEMENT_PROMPT, "zh": FEEDBACK_JUDGEMENT_PROMPT_ZH},
    "compare": {"en": UPDATE_FORMER_MEMORIES, "zh": UPDATE_FORMER_MEMORIES_ZH},
    "generation": {"en": FEEDBACK_ANSWER_PROMPT, "zh": FEEDBACK_ANSWER_PROMPT_ZH},
}

logger = log.get_logger(__name__)


class MemFeedback(BaseMemFeedback):
    def __init__(self, config: MemFeedbackConfig):
        """
        Initialize the MemFeedback with configuration.

        Args:
            config: Configuration object for the MemFeedback
        """
        self.config = config
        self.llm: OpenAILLM | OllamaLLM | AzureLLM = LLMFactory.from_config(config.extractor_llm)
        self.embedder: OllamaEmbedder = EmbedderFactory.from_config(config.embedder)
        self.graph_store: PolarDBGraphDB = GraphStoreFactory.from_config(config.graph_db)
        self.mem_reader = MemReaderFactory.from_config(config.mem_reader)

        self.is_reorganize = config.reorganize
        self.memory_manager: MemoryManager = MemoryManager(
            self.graph_store,
            self.embedder,
            self.llm,
            memory_size=config.memory_size
            or {
                "WorkingMemory": 20,
                "LongTermMemory": 1500,
                "UserMemory": 480,
            },
            is_reorganize=self.is_reorganize,
        )

    def _pure_add(self, user_name: str, feedback_content: str, feedback_time: str, info: dict):
        """
        Directly add new memory
        """
        scene_data = [[{"role": "user", "content": feedback_content, "chat_time": feedback_time}]]
        memories = self.mem_reader.get_memory(scene_data, type="chat", info=info)
        to_add_memories = [item for scene in memories for item in scene]
        added_ids = self._retry_db_operation(
            lambda: self.memory_manager.add(to_add_memories, user_name=user_name)
        )
        logger.info(
            f"[Feedback Core: _pure_add] Added {len(added_ids)} memories for user {user_name}."
        )
        return {
            "record": {
                "add": [
                    {"id": _id, "text": added_mem.memory}
                    for _id, added_mem in zip(added_ids, to_add_memories, strict=False)
                ],
                "update": [],
            }
        }

    def _feedback_judgement(
        self, chat_history: list[MessageDict], feedback_content: str, feedback_time: str = ""
    ) -> dict | None:
        """
        Generate a judgement for a given feedback.
        """
        lang = detect_lang(feedback_content)
        template = FEEDBACK_PROMPT_DICT["judge"][lang]
        chat_history_lis = [f"""{msg["role"]}: {msg["content"]}""" for msg in chat_history[-4:]]
        chat_history_str = "\n".join(chat_history_lis)
        prompt = template.format(
            chat_history=chat_history_str,
            user_feedback=feedback_content,
            feedback_time=feedback_time,
        )

        judge_res = self._get_llm_response(prompt)
        if judge_res:
            return judge_res
        else:
            logger.warning(
                "[Feedback Core: _feedback_judgement] feedback judgement failed, return []"
            )
            return []

    def _feedback_memory(
        self, user_name: str, feedback_memories: list[TextualMemoryItem], **kwargs
    ) -> dict:
        sync_mode = kwargs.get("sync_mode")
        retrieved_memory_ids = kwargs.get("retrieved_memory_ids") or []
        chat_history = kwargs.get("chat_history", [])
        feedback_content = kwargs.get("feedback_content", "")

        chat_history_lis = [f"""{msg["role"]}: {msg["content"]}""" for msg in chat_history[-4:]]
        fact_history = "\n".join(chat_history_lis) + f"\nuser feedback: \n{feedback_content}"

        retrieved_memories = [self.graph_store.get_node(_id) for _id in retrieved_memory_ids]
        filterd_ids = [
            item["id"] for item in retrieved_memories if "mode:fast" in item["metadata"]["tags"]
        ]
        if filterd_ids:
            logger.warning(
                f"[Feedback Core: _feedback_memory] Since the tags mode is fast, no modifications are made to the following memory {filterd_ids}."
            )

        current_memories = [
            {"id": item["id"], "text": item["memory"]}
            for item in retrieved_memories
            if "mode:fast" not in item["metadata"]["tags"]
        ]

        def _single_add_operation(
            memory_item: TextualMemoryItem, user_name: str, sync_mode: str
        ) -> dict:
            """
            Individual addition operations
            """
            added_ids = self._retry_db_operation(
                lambda: self.memory_manager.add([memory_item], user_name=user_name, mode=sync_mode)
            )
            logger.info(f"[Memory Feedback ADD] {added_ids[0]}")

            return {"id": added_ids[0], "text": memory_item.memory}

        def _single_update_operation(
            op: dict, memory_item: TextualMemoryItem, user_name: str, sync_mode: str
        ) -> dict:
            """
            Individual update operations
            """
            update_id = op.get("id")
            updated_ids = self._retry_db_operation(
                lambda: self.memory_manager.update(
                    [update_id], [memory_item], user_name=user_name, mode=sync_mode
                )
            )
            log_update_info = op.get("old_memory", "") + " >> " + op.get("text", "")
            logger.info(f"[Memory Feedback UPDATE] {updated_ids[0]}, info: {log_update_info}")

            return {
                "id": update_id,
                "origin_memory": op.get("old_memory", ""),
                "text": op.get("text", ""),
            }

        def _add_or_update(
            memory_item: TextualMemoryItem, current_memories: list, fact_history: str
        ):
            if current_memories == []:
                current_memories = self._vec_query(
                    memory_item.metadata.embedding, user_name=user_name
                )

            if current_memories:
                lang = detect_lang("".join(memory_item.memory))
                template = FEEDBACK_PROMPT_DICT["compare"][lang]
                prompt = template.format(
                    current_memories=str(current_memories),
                    new_facts=memory_item.memory,
                    chat_history=fact_history,
                )

                operations = self._get_llm_response(prompt).get("operation", [])
                operations = self._id_dehallucination(operations, current_memories)
            else:
                operations = [{"event": "ADD"}]

            logger.info(f"[Feedback memory operations]: {operations!s}")

            if not operations:
                return {"record": {"add": [], "update": []}}

            add_results = []
            update_results = []

            with ContextThreadPoolExecutor(max_workers=10) as executor:
                future_to_op = {}
                for op in operations:
                    event_type = op.get("event", "").lower()

                    if event_type == "add":
                        future = executor.submit(
                            _single_add_operation, memory_item, user_name, sync_mode
                        )
                        future_to_op[future] = ("add", op)
                    elif event_type == "update":
                        future = executor.submit(
                            _single_update_operation, op, memory_item, user_name, sync_mode
                        )
                        future_to_op[future] = ("update", op)

                for future in concurrent.futures.as_completed(future_to_op):
                    result_type, original_op = future_to_op[future]
                    try:
                        result = future.result()
                        if result_type == "add":
                            add_results.append(result)
                        elif result_type == "update":
                            update_results.append(result)
                    except Exception as e:
                        logger.error(
                            f"[Feedback Core: _add_or_update] Operation failed for {original_op}: {e}",
                            exc_info=True,
                        )

            return {"record": {"add": add_results, "update": update_results}}

        with ContextThreadPoolExecutor(max_workers=3) as ex:
            futures = {
                ex.submit(_add_or_update, mem, current_memories, fact_history): i
                for i, mem in enumerate(feedback_memories)
            }
            results = [None] * len(futures)
            for fut in concurrent.futures.as_completed(futures):
                i = futures[fut]
                try:
                    node = fut.result()
                    if node:
                        results[i] = node
                except Exception as e:
                    logger.error(
                        f"[Feedback Core: _feedback_memory] Error processing memory index {i}: {e}",
                        exc_info=True,
                    )
            mem_res = [r for r in results if r]

        return {
            "record": {
                "add": [element for item in mem_res for element in item["record"]["add"]],
                "update": [element for item in mem_res for element in item["record"]["update"]],
            }
        }

    def _vec_query(self, new_memories_embedding: list[float], user_name=None):
        retrieved_ids = self.graph_store.search_by_embedding(
            new_memories_embedding, user_name=user_name, top_k=10, threshold=0.75
        )
        current_memories = [self.graph_store.get_node(item["id"]) for item in retrieved_ids]
        if not retrieved_ids:
            logger.info(
                f"[Feedback Core: _vec_query] No similar memories found for embedding query for user {user_name}."
            )

        filterd_ids = [
            item["id"] for item in current_memories if "mode:fast" in item["metadata"]["tags"]
        ]
        if filterd_ids:
            logger.warning(
                f"[Feedback Core: _vec_query] Since the tags mode is fast, no modifications are made to the following memory {filterd_ids}."
            )
        return [
            {
                "id": item["id"],
                "text": item["memory"],
            }
            for item in current_memories
            if "mode:fast" not in item["metadata"]["tags"]
        ]

    def _get_llm_response(self, prompt: str, dsl: bool = True) -> dict:
        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages, temperature=0.3)
            if dsl:
                response_text = response_text.replace("```", "").replace("json", "")
                response_json = json.loads(response_text)
            else:
                return response_text
        except Exception as e:
            logger.error(f"[Feedback Core LLM] Exception during chat generation: {e}")
            response_json = None
        return response_json

    def _id_dehallucination(self, operations, current_memories):
        right_ids = [item["id"] for item in current_memories]
        right_lower_map = {x.lower(): x for x in right_ids}

        def correct_item(data):
            if data.get("event", "").lower() != "update":
                return data

            original_id = data["id"]
            if original_id in right_ids:
                return data

            lower_id = original_id.lower()
            if lower_id in right_lower_map:
                data["id"] = right_lower_map[lower_id]
                return data

            matches = difflib.get_close_matches(original_id, right_ids, n=1, cutoff=0.8)
            if matches:
                data["id"] = matches[0]
                return data

            return None

        dehallu_res = [correct_item(item) for item in operations]
        return [item for item in dehallu_res if item]

    def _generate_answer(
        self, chat_history: list[MessageDict], feedback_content: str, corrected_answer: bool
    ) -> str:
        """
        Answer generation to facilitate concurrent submission.
        """
        if not corrected_answer or feedback_content.strip() == "":
            return ""
        lang = detect_lang(feedback_content)
        template = FEEDBACK_PROMPT_DICT["generation"][lang]
        chat_history_str = "\n".join(
            [f"{item['role']}: {item['content']}" for item in chat_history]
        )
        chat_history_str = chat_history_str if chat_history_str else "none"
        prompt = template.format(chat_history=chat_history_str, question=feedback_content)

        return self._get_llm_response(prompt, dsl=False)

    def process_feedback_core(
        self,
        user_name: str,
        chat_history: list[MessageDict],
        feedback_content: str,
        **kwargs,
    ) -> dict:
        """
        Core feedback processing: judgment, memory extraction, addition/update. Return record.
        """

        def check_validity(item):
            return (
                "validity" in item
                and item["validity"].lower() == "true"
                and "corrected_info" in item
                and item["corrected_info"].strip()
                and "key" in item
                and "tags" in item
            )

        try:
            feedback_time = kwargs.get("feedback_time") or datetime.now().isoformat()
            session_id = kwargs.get("session_id")
            allow_knowledgebase_write = bool(kwargs.get("allow_knowledgebase_write"))
            if feedback_content.strip() == "" or not allow_knowledgebase_write:
                return {"record": {"add": [], "update": []}}

            info = {"user_id": user_name, "session_id": session_id}
            logger.info(
                f"[Feedback Core: process_feedback_core] Starting memory feedback process for user {user_name}"
            )
            if not chat_history:
                return self._pure_add(user_name, feedback_content, feedback_time, info)

            else:
                raw_judge = self._feedback_judgement(
                    chat_history, feedback_content, feedback_time=feedback_time
                )
                valid_feedback = (
                    [item for item in raw_judge if check_validity(item)] if raw_judge else []
                )
                if (
                    raw_judge
                    and raw_judge[0]["validity"].lower() == "false"
                    and raw_judge[0]["user_attitude"].lower() == "irrelevant"
                ):
                    return self._pure_add(user_name, feedback_content, feedback_time, info)

                if not valid_feedback:
                    logger.warning(
                        f"[Feedback Core: process_feedback_core] No valid judgements for user {user_name}: {raw_judge}."
                    )
                    return {"record": {"add": [], "update": []}}

                feedback_memories = []

                corrected_infos = [item["corrected_info"] for item in valid_feedback]
                embed_bs = 5
                feedback_memories_embeddings = []
                for i in range(0, len(corrected_infos), embed_bs):
                    batch = corrected_infos[i : i + embed_bs]
                    try:
                        feedback_memories_embeddings.extend(self.embedder.embed(batch))
                    except Exception as e:
                        logger.error(
                            f"[Feedback Core: process_feedback_core] Embedding batch failed: {e}",
                            exc_info=True,
                        )

                for item, embedding in zip(
                    valid_feedback, feedback_memories_embeddings, strict=False
                ):
                    value = item["corrected_info"]
                    key = item["key"]
                    tags = item["tags"]
                    feedback_memories.append(
                        TextualMemoryItem(
                            memory=value,
                            metadata=TreeNodeTextualMemoryMetadata(
                                user_id=info.get("user_id", ""),
                                session_id=info.get("session_id", ""),
                                memory_type="LongTermMemory",
                                status="activated",
                                tags=tags,
                                key=key,
                                embedding=embedding,
                                usage=[],
                                sources=[{"type": "chat"}],
                                background="",
                                confidence=0.99,
                                type="fine",
                            ),
                        )
                    )

                mem_record = self._feedback_memory(
                    user_name,
                    feedback_memories,
                    chat_history=chat_history,
                    feedback_content=feedback_content,
                    **kwargs,
                )
                logger.info(
                    f"[Feedback Core: process_feedback_core] Processed {len(feedback_memories)} feedback memories for user {user_name}."
                )
                return mem_record

        except Exception as e:
            logger.error(f"[Feedback Core: process_feedback_core] Error for user {user_name}: {e}")
            return {"record": {"add": [], "update": []}}

    def process_feedback(
        self,
        user_name: str,
        chat_history: list[MessageDict],
        feedback_content: str,
        **kwargs,
    ):
        """
        Process feedback with different modes.

        Args:
            user_name: User identifier
            chat_history: List of chat messages
            feedback_content: Feedback content from user
            **kwargs: Additional arguments including sync_mode

        Returns:
            Dict with answer and/or memory operation records
        """
        sync_mode = kwargs.get("sync_mode")
        corrected_answer = kwargs.get("corrected_answer")

        if sync_mode == "sync":
            with ContextThreadPoolExecutor(max_workers=2) as ex:
                answer_future = ex.submit(
                    self._generate_answer,
                    chat_history,
                    feedback_content,
                    corrected_answer=corrected_answer,
                )
                core_future = ex.submit(
                    self.process_feedback_core,
                    user_name,
                    chat_history,
                    feedback_content,
                    **kwargs,
                )
                done, pending = concurrent.futures.wait([answer_future, core_future], timeout=30)
                for fut in pending:
                    fut.cancel()
                try:
                    answer = answer_future.result()
                    record = core_future.result()
                    logger.info(
                        f"[MemFeedback sync] Completed concurrently for user {user_name} with full results."
                    )
                    return {"answer": answer, "record": record["record"]}
                except concurrent.futures.TimeoutError:
                    logger.error(
                        f"[MemFeedback sync] Timeout in sync mode for {user_name}", exc_info=True
                    )
                    return {"answer": "", "record": {"add": [], "update": []}}
                except Exception as e:
                    logger.error(
                        f"[MemFeedback sync] Error in concurrent tasks for {user_name}: {e}",
                        exc_info=True,
                    )
                    return {"answer": "", "record": {"add": [], "update": []}}
        else:
            answer = self._generate_answer(
                chat_history, feedback_content, corrected_answer=corrected_answer
            )

            ex = ContextThreadPoolExecutor(max_workers=1)
            future = ex.submit(
                self.process_feedback_core,
                user_name,
                chat_history,
                feedback_content,
                **kwargs,
            )
            ex.shutdown(wait=False)

            def log_completion(f):
                try:
                    result = f.result(timeout=600)
                    logger.info(f"[MemFeedback async] Completed for {user_name}: {result}")
                except concurrent.futures.TimeoutError:
                    logger.error(
                        f"[MemFeedback async] Background task timeout for {user_name}",
                        exc_info=True,
                    )
                    f.cancel()
                except Exception as e:
                    logger.error(
                        f"[MemFeedback async] Background Feedback Error for {user_name}: {e}",
                        exc_info=True,
                    )

            future.add_done_callback(log_completion)

            logger.info(
                f"[MemFeedback async] Returned answer, background task started for {user_name}."
            )
            return {"answer": answer, "record": {"add": [], "update": []}}

    #  Helper for DB operations with retry
    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=4, max=10))
    def _retry_db_operation(self, operation):
        try:
            return operation()
        except Exception as e:
            logger.error(
                f"[MemFeedback: _retry_db_operation] DB operation failed: {e}", exc_info=True
            )
            raise
