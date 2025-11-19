import concurrent.futures
import json

from datetime import datetime

from memos import log
from memos.configs.memory import MemFeedbackConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder
from memos.graph_dbs.factory import GraphStoreFactory, PolarDBGraphDB
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.mem_feedback.base import BaseMemFeedback
from memos.mem_reader.simple_struct import SimpleStructMemReader, detect_lang
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

    def _feedback_judgement(
        self, chat_history: list[MessageDict], feedback_content: str, feedback_time: str = ""
    ) -> dict | None:
        """
        Generate a judgement for a given feedback.
        """
        lang = detect_lang(feedback_content)
        template = FEEDBACK_PROMPT_DICT["judge"][lang]
        chat_history_str = str(chat_history[-4:])
        prompt = (
            template.replace("{chat_history}", chat_history_str)
            .replace("{user_feedback}", feedback_content)
            .replace("{feedback_time}", feedback_time)
        )
        judge_res = self._get_llm_response(prompt)
        return judge_res if judge_res else []

    def _feedback_memory(
        self, user_name: str, feedback_memories: list[TextualMemoryItem], **kwargs
    ) -> dict:
        sync_mode = kwargs.get("sync_mode")

        def _add_or_update(memory_item: TextualMemoryItem):
            current_memories = self._vec_query(memory_item.metadata.embedding, user_name=user_name)
            if current_memories:
                lang = detect_lang("".join(memory_item.memory))
                template = FEEDBACK_PROMPT_DICT["compare"][lang]
                prompt = template.replace("{current_memories}", str(current_memories)).replace(
                    "{new_facts}", memory_item.memory
                )
                operations = self._get_llm_response(prompt).get("operation", {})
            else:
                operations = {"event": "ADD"}
            logger.info(f"[Feedback memory operations]: {operations!s}")

            if operations and operations["event"].lower() == "add":
                added_ids = self.memory_manager.add(
                    [memory_item], user_name=user_name, mode=sync_mode
                )
                logger.info(f"[Memory Feedback ADD] {added_ids!s}")

                return {
                    "record": {
                        "add": [{"id": added_ids[0], "text": memory_item.memory}],
                        "update": [],
                    }
                }
            elif operations and operations["event"].lower() == "update":
                to_update_id = operations["id"]
                updated_ids = self.memory_manager.update(
                    [to_update_id], [memory_item], user_name=user_name, mode=sync_mode
                )
                log_update_info = operations["old_memory"] + " >> " + operations["text"]
                logger.info(f"[Memory Feedback UPDATE] {updated_ids}, info: {log_update_info}")

                return {
                    "record": {
                        "add": [],
                        "update": [
                            {
                                "id": to_update_id,
                                "origin_memory": operations["old_memory"],
                                "text": operations["text"],
                            }
                        ],
                    }
                }
            else:
                return {"record": {"add": [], "update": []}}

        search_filter = {"user_name": user_name}
        with ContextThreadPoolExecutor(max_workers=8) as ex:
            futures = {
                ex.submit(_add_or_update, mem, search_filter): i
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
                    logger.error(f"[FeedBack] error: {e}")
            mem_res = [r for r in results if r]

        return {
            "record": {
                "add": [element for item in mem_res for element in item["record"]["add"]],
                "update": [element for item in mem_res for element in item["record"]["update"]],
            }
        }

    def _vec_query(self, new_memories_embedding: list[float], user_name=None):
        retrieved_ids = self.graph_store.search_by_embedding(
            new_memories_embedding, user_name=user_name
        )
        current_memories = [self.graph_store.get_node(item["id"]) for item in retrieved_ids]

        return [
            {
                "id": item["id"],
                "text": item["memory"],
            }
            for item in current_memories
        ]

    def _get_llm_response(self, prompt: str, dsl: bool = True) -> dict:
        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages)
            if dsl:
                response_json = json.loads(response_text)
            else:
                return response_text
        except Exception as e:
            logger.error(f"[LLM] Exception during chat generation: {e}")
            response_json = None
        return response_json

    def _generate_answer(
        self, chat_history: list[MessageDict], feedback_content: str, corrected_answer: bool
    ) -> str:
        """
        Answer generation to facilitate concurrent submission.
        """
        if not corrected_answer:
            return ""
        lang = detect_lang(feedback_content)
        template = FEEDBACK_PROMPT_DICT["generation"][lang]
        chat_history_str = "\n".join(
            [f"{item['role']}: {item['content']}" for item in chat_history]
        )
        chat_history_str = chat_history_str if chat_history_str else "none"
        prompt = template.replace("{chat_history}", chat_history_str).replace(
            "{question}", feedback_content
        )
        return self._get_llm_response(prompt, dsl=False)

    def process_feedback_core(
        self,
        user_name: str,
        chat_history: list[MessageDict],
        feedback_content: str,
        mem_reader: SimpleStructMemReader | None = None,
        **kwargs,
    ) -> dict:
        """
        Core feedback processing: judgment, memory extraction, addition/update. Return record.
        """
        try:
            feedback_time = kwargs.get("feedback_time") or datetime.now().isoformat()
            session_id = kwargs.get("session_id")
            allow_knowledgebase_write = bool(kwargs.get("allow_knowledgebase_write"))
            if not allow_knowledgebase_write:
                return {"record": {"add": [], "update": []}}

            info = {"user_id": user_name, "session_id": session_id}
            logger.info(f"[Feedback Core] Starting memory feedback process for user {user_name}")

            if mem_reader and not chat_history:
                scene_data = [
                    [{"role": "user", "content": feedback_content, "chat_time": feedback_time}]
                ]
                memories = mem_reader.get_memory(scene_data, type="chat", info=info)
                to_add_memories = [item for scene in memories for item in scene]
                added_ids = self.memory_manager.add(to_add_memories, user_name=user_name)
                logger.info(
                    f"[Feedback Core] Added {len(added_ids)} memories for user {user_name}."
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

            elif chat_history:
                raw_judge = self._feedback_judgement(
                    chat_history, feedback_content, feedback_time=feedback_time
                )
                judge_res = (
                    [
                        item
                        for item in raw_judge
                        if item["validity"].lower() == "true" and item["corrected_info"].strip()
                    ]
                    if raw_judge
                    else []
                )
                if not judge_res:
                    logger.warning(
                        f"[Feedback Core] No valid judgements for user {user_name}: {raw_judge}."
                    )
                    return {"record": {"add": [], "update": []}}

                feedback_memories = []
                feedback_memories_embeddings = self.embedder.embed(
                    [item["corrected_info"] for item in judge_res]
                )
                for item, embedding in zip(judge_res, feedback_memories_embeddings, strict=False):
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
                mem_record = self._feedback_memory(user_name, feedback_memories, **kwargs)
                logger.info(
                    f"[Feedback Core] Processed {len(feedback_memories)} feedback memories for user {user_name}."
                )
                return mem_record

            else:
                logger.info("[Feedback Core] Empty chat_history and no mem_reader, skipping.")
                return {"record": {"add": [], "update": []}}

        except Exception as e:
            logger.error(f"[Feedback Core] Error for user {user_name}: {e}")
            return {"record": {"add": [], "update": []}}

    def process_feedback(
        self,
        user_name: str,
        chat_history: list[MessageDict],
        feedback_content: str,
        mem_reader: SimpleStructMemReader | None = None,
        **kwargs,
    ):
        """
        Process feedback with different modes.

        Args:
            user_name: User identifier
            chat_history: List of chat messages
            feedback_content: Feedback content from user
            mem_reader: Memory reader instance
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
                    mem_reader,
                    **kwargs,
                )
                concurrent.futures.wait([answer_future, core_future])
                try:
                    answer = answer_future.result()
                    record = core_future.result()
                    logger.info(
                        f"[process_feedback sync] Completed concurrently for user {user_name} with full results."
                    )
                    return {"answer": answer, "record": record["record"]}
                except Exception as e:
                    logger.error(
                        f"[process_feedback sync] Error in concurrent tasks for {user_name}: {e}"
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
                mem_reader,
                **kwargs,
            )
            ex.shutdown(wait=False)

            def log_completion(f):
                try:
                    result = f.result()
                    logger.info(f"[Background Feedback] Completed for {user_name}: {result}")
                except Exception as e:
                    logger.error(f"[Background Feedback] Error for {user_name}: {e}")

            future.add_done_callback(log_completion)

            logger.info(
                f"[process_feedback async] Returned answer, background task started for {user_name}."
            )
            return {"answer": answer, "record": {"add": [], "update": []}}
