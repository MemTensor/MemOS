import concurrent.futures
import difflib
import json
import re

from datetime import datetime
from typing import TYPE_CHECKING, Any

from tenacity import retry, stop_after_attempt, wait_random_exponential

from memos.configs.memory import MemFeedbackConfig
from memos.context.context import ContextThreadPoolExecutor
from memos.dependency import require_python_package
from memos.embedders.factory import EmbedderFactory, OllamaEmbedder
from memos.graph_dbs.factory import GraphStoreFactory, PolarDBGraphDB
from memos.llms.factory import AzureLLM, LLMFactory, OllamaLLM, OpenAILLM
from memos.log import get_logger
from memos.mem_feedback.base import BaseMemFeedback
from memos.mem_feedback.utils import (
    general_split_into_chunks,
    make_mem_item,
    should_keep_update,
    split_into_chunks,
)
from memos.mem_reader.factory import MemReaderFactory
from memos.mem_reader.read_multi_modal import detect_lang
from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.organize.manager import (
    MemoryManager,
    extract_working_binding_ids,
)
from memos.memories.textual.tree_text_memory.retrieve.retrieve_utils import StopwordManager


if TYPE_CHECKING:
    from memos.memories.textual.tree_text_memory.retrieve.searcher import Searcher
from memos.templates.mem_feedback_prompts import (
    FEEDBACK_ANSWER_PROMPT,
    FEEDBACK_ANSWER_PROMPT_ZH,
    FEEDBACK_JUDGEMENT_PROMPT,
    FEEDBACK_JUDGEMENT_PROMPT_ZH,
    KEYWORDS_REPLACE,
    KEYWORDS_REPLACE_ZH,
    OPERATION_UPDATE_JUDGEMENT,
    OPERATION_UPDATE_JUDGEMENT_ZH,
    UPDATE_FORMER_MEMORIES,
    UPDATE_FORMER_MEMORIES_ZH,
)
from memos.types import MessageDict


FEEDBACK_PROMPT_DICT = {
    "if_kw_replace": {"en": KEYWORDS_REPLACE, "zh": KEYWORDS_REPLACE_ZH},
    "judge": {"en": FEEDBACK_JUDGEMENT_PROMPT, "zh": FEEDBACK_JUDGEMENT_PROMPT_ZH},
    "compare": {"en": UPDATE_FORMER_MEMORIES, "zh": UPDATE_FORMER_MEMORIES_ZH},
    "compare_judge": {"en": OPERATION_UPDATE_JUDGEMENT, "zh": OPERATION_UPDATE_JUDGEMENT_ZH},
    "generation": {"en": FEEDBACK_ANSWER_PROMPT, "zh": FEEDBACK_ANSWER_PROMPT_ZH},
}

logger = get_logger(__name__)


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
        self.stopword_manager = StopwordManager
        self.searcher: Searcher = None
        self.reranker = None
        self.DB_IDX_READY = False

    @require_python_package(
        import_name="jieba",
        install_command="pip install jieba",
        install_link="https://github.com/fxsjy/jieba",
    )
    def _tokenize_chinese(self, text):
        """split zh jieba"""
        import jieba

        tokens = jieba.lcut(text)
        tokens = [token.strip() for token in tokens if token.strip()]
        return self.stopword_manager.filter_words(tokens)

    @retry(stop=stop_after_attempt(4), wait=wait_random_exponential(multiplier=1, max=10))
    def _embed_once(self, texts):
        return self.embedder.embed(texts)

    @retry(stop=stop_after_attempt(3), wait=wait_random_exponential(multiplier=1, min=4, max=10))
    def _retry_db_operation(self, operation):
        try:
            return operation()
        except Exception as e:
            logger.error(
                f"[1223 Feedback Core: _retry_db_operation] DB operation failed: {e}", exc_info=True
            )
            raise

    def _batch_embed(self, texts: list[str], embed_bs: int = 5):
        results = []
        dim = self.embedder.config.embedding_dims

        for i in range(0, len(texts), embed_bs):
            batch = texts[i : i + embed_bs]
            try:
                results.extend(self._embed_once(batch))
            except Exception as e:
                logger.error(
                    f"[1223 Feedback Core: process_feedback_core] Embedding batch failed, Cover with all zeros: {len(batch)} entries: {e}"
                )
                results.extend([[0.0] * dim for _ in range(len(batch))])
        return results

    def _pure_add(self, user_name: str, feedback_content: str, feedback_time: str, info: dict):
        """
        Directly add new memory
        """
        scene_data = [[{"role": "user", "content": feedback_content, "chat_time": feedback_time}]]
        memories = self.mem_reader.get_memory(scene_data, type="chat", info=info)
        to_add_memories = [item for scene in memories for item in scene]
        added_ids = self._retry_db_operation(
            lambda: self.memory_manager.add(to_add_memories, user_name=user_name, use_batch=False)
        )
        logger.info(
            f"[1223 Feedback Core: _pure_add] Pure added {len(added_ids)} memories for user {user_name}."
        )
        return {
            "record": {
                "add": [
                    {
                        "id": _id,
                        "text": added_mem.memory,
                        "source_doc_id": (
                            added_mem.metadata.file_ids[0]
                            if hasattr(added_mem.metadata, "file_ids")
                            and isinstance(added_mem.metadata.file_ids, list)
                            and added_mem.metadata.file_ids
                            else None
                        ),
                    }
                    for _id, added_mem in zip(added_ids, to_add_memories, strict=False)
                ],
                "update": [],
            }
        }

    def _keyword_replace_judgement(self, feedback_content: str) -> dict | None:
        """
        Determine whether it is keyword replacement
        """
        lang = detect_lang(feedback_content)
        template = FEEDBACK_PROMPT_DICT["if_kw_replace"][lang]
        prompt = template.format(
            user_feedback=feedback_content,
        )

        judge_res = self._get_llm_response(prompt)
        if judge_res:
            return judge_res
        else:
            logger.warning(
                "[1223 Feedback Core: _feedback_judgement] feedback judgement failed, return []"
            )
            return {}

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
                "[1223 Feedback Core: _feedback_judgement] feedback judgement failed, return []"
            )
            return []

    def _single_add_operation(
        self,
        old_memory_item: TextualMemoryItem | None,
        new_memory_item: TextualMemoryItem,
        user_id: str,
        user_name: str,
        async_mode: str = "sync",
    ) -> dict:
        """
        Individual addition operations
        """
        if old_memory_item:
            to_add_memory = old_memory_item.model_copy(deep=True)
            to_add_memory.metadata.key = new_memory_item.metadata.key
            to_add_memory.metadata.tags = new_memory_item.metadata.tags
            to_add_memory.memory = new_memory_item.memory
            to_add_memory.metadata.embedding = new_memory_item.metadata.embedding

            to_add_memory.metadata.user_id = new_memory_item.metadata.user_id
            to_add_memory.metadata.created_at = to_add_memory.metadata.updated_at = (
                datetime.now().isoformat()
            )
            to_add_memory.metadata.background = new_memory_item.metadata.background
        else:
            to_add_memory = new_memory_item.model_copy(deep=True)
            to_add_memory.metadata.created_at = to_add_memory.metadata.updated_at = (
                datetime.now().isoformat()
            )
            to_add_memory.metadata.background = new_memory_item.metadata.background

        to_add_memory.id = ""
        added_ids = self._retry_db_operation(
            lambda: self.memory_manager.add([to_add_memory], user_name=user_name, use_batch=False)
        )

        logger.info(f"[Memory Feedback ADD] memory id: {added_ids!s}")
        return {
            "id": added_ids[0],
            "text": to_add_memory.memory,
            "source_doc_id": (
                to_add_memory.metadata.file_ids[0]
                if hasattr(to_add_memory.metadata, "file_ids")
                and isinstance(to_add_memory.metadata.file_ids, list)
                and to_add_memory.metadata.file_ids
                else None
            ),
        }

    def _single_update_operation(
        self,
        old_memory_item: TextualMemoryItem,
        new_memory_item: TextualMemoryItem,
        user_id: str,
        user_name: str,
        async_mode: str = "sync",
        operation: dict | None = None,
    ) -> dict:
        """
        Individual update operations
        """
        memory_type = old_memory_item.metadata.memory_type
        source_doc_id = (
            old_memory_item.metadata.file_ids[0]
            if hasattr(old_memory_item.metadata, "file_ids")
            and isinstance(old_memory_item.metadata.file_ids, list)
            and old_memory_item.metadata.file_ids
            else None
        )
        if operation and "text" in operation and operation["text"]:
            new_memory_item.memory = operation["text"]

        if memory_type == "WorkingMemory":
            fields = {
                "memory": new_memory_item.memory,
                "key": new_memory_item.metadata.key,
                "tags": new_memory_item.metadata.tags,
                "embedding": new_memory_item.metadata.embedding,
                "background": new_memory_item.metadata.background,
                "covered_history": old_memory_item.id,
            }
            self.graph_store.update_node(old_memory_item.id, fields=fields, user_name=user_name)
            item_id = old_memory_item.id
        else:
            done = self._single_add_operation(
                old_memory_item, new_memory_item, user_id, user_name, async_mode
            )
            item_id = done.get("id")
            self.graph_store.update_node(
                item_id, {"covered_history": old_memory_item.id}, user_name=user_name
            )
            self.graph_store.update_node(
                old_memory_item.id, {"status": "archived"}, user_name=user_name
            )

        logger.info(
            f"[Memory Feedback UPDATE] New Add:{item_id} | Set archived:{old_memory_item.id} | memory_type: {memory_type}"
        )

        return {
            "id": item_id,
            "text": new_memory_item.memory,
            "source_doc_id": source_doc_id,
            "archived_id": old_memory_item.id,
            "origin_memory": old_memory_item.memory,
        }

    def _del_working_binding(self, user_name, mem_items: list[TextualMemoryItem]) -> set[str]:
        """Delete working memory bindings"""
        bindings_to_delete = extract_working_binding_ids(mem_items)

        logger.info(
            f"[Memory Feedback UPDATE] Extracted {len(bindings_to_delete)} working_binding ids to cleanup: {list(bindings_to_delete)}"
        )

        delete_ids = []
        if bindings_to_delete:
            delete_ids = list({bindings_to_delete})

        for mid in delete_ids:
            try:
                self.graph_store.delete_node(mid, user_name=user_name)

                logger.info(
                    f"[1223 Feedback Core:_del_working_binding] Delete raw/working mem_ids: {delete_ids} for user_name: {user_name}"
                )
            except Exception as e:
                logger.warning(
                    f"[1223 Feedback Core:_del_working_binding] TreeTextMemory.delete_hard: failed to delete {mid}: {e}"
                )

    def semantics_feedback(
        self,
        user_id: str,
        user_name: str,
        memory_item: TextualMemoryItem,
        current_memories: list[TextualMemoryItem],
        history_str: str,
        chat_history_list: list,
        info: dict,
    ):
        """Modify memory at the semantic level"""
        lang = detect_lang("".join(memory_item.memory))
        template = FEEDBACK_PROMPT_DICT["compare"][lang]
        if current_memories == []:
            # retrieve feedback
            feedback_retrieved = self._retrieve(memory_item.memory, info=info, user_name=user_name)

            # retrieve question
            last_user_index = max(i for i, d in enumerate(chat_history_list) if d["role"] == "user")
            last_qa = " ".join([item["content"] for item in chat_history_list[last_user_index:]])
            supplementary_retrieved = self._retrieve(last_qa, info=info, user_name=user_name)
            ids = []
            for item in feedback_retrieved + supplementary_retrieved:
                if item.id not in ids:
                    ids.append(item.id)
                    current_memories.append(item)
            include_keys = ["agent_id", "app_id"]
            current_memories = [
                item for item in current_memories if self._info_comparison(item, info, include_keys)
            ]
        operations = []
        if not current_memories:
            operations = [{"operation": "ADD"}]
            logger.warning(
                "[Feedback Core]: There was no recall of the relevant memory, so it was added directly."
            )
        else:
            memory_chunks = split_into_chunks(current_memories, max_tokens_per_chunk=500)

            all_operations = []
            now_time = datetime.now().isoformat()
            with ContextThreadPoolExecutor(max_workers=10) as executor:
                future_to_chunk_idx = {}
                for chunk in memory_chunks:
                    current_memories_str = "\n".join(
                        [f"{item.id}: {item.memory}" for item in chunk]
                    )
                    prompt = template.format(
                        now_time=now_time,
                        current_memories=current_memories_str,
                        new_facts=memory_item.memory,
                        chat_history=history_str,
                    )

                    future = executor.submit(self._get_llm_response, prompt)
                    future_to_chunk_idx[future] = chunk
                for future in concurrent.futures.as_completed(future_to_chunk_idx):
                    try:
                        chunk_operations = future.result()
                        if (
                            chunk_operations
                            and "operations" in chunk_operations
                            and isinstance(chunk_operations["operations"], list)
                        ):
                            all_operations.extend(chunk_operations["operations"])
                    except Exception as e:
                        logger.error(
                            f"[1223 Feedback Core: semantics_feedback] Operation failed: {e}"
                        )

            standard_operations = self.standard_operations(all_operations, current_memories)
            operations = self.filter_fault_update(standard_operations)

        logger.info(f"[Feedback Core Operations]: {operations!s}")

        if not operations:
            return {"record": {"add": [], "update": []}}

        add_results = []
        update_results = []
        id_to_item = {item.id: item for item in current_memories}

        with ContextThreadPoolExecutor(max_workers=10) as executor:
            future_to_op = {}
            for op in operations:
                event_type = op.get("operation", "").lower()

                if event_type == "add":
                    future = executor.submit(
                        self._single_add_operation,
                        None,
                        memory_item,
                        user_id,
                        user_name,
                    )
                    future_to_op[future] = ("add", op)
                elif event_type == "update":
                    future = executor.submit(
                        self._single_update_operation,
                        id_to_item[op["id"]],
                        memory_item,
                        user_id,
                        user_name,
                        operation=op,
                    )
                    future_to_op[future] = ("update", op)

            for future in concurrent.futures.as_completed(future_to_op):
                result_type, original_op = future_to_op[future]
                try:
                    result = future.result()
                    if result_type == "add" and result:
                        add_results.append(result)
                    elif result_type == "update" and result:
                        update_results.append(result)
                except Exception as e:
                    logger.error(
                        f"[1223 Feedback Core: semantics_feedback] Operation failed for {original_op}: {e}",
                        exc_info=True,
                    )
        if update_results:
            updated_ids = [item["archived_id"] for item in update_results]
            self._del_working_binding(updated_ids, user_name)

        return {"record": {"add": add_results, "update": update_results}}

    def _feedback_memory(
        self, user_id: str, user_name: str, feedback_memories: list[TextualMemoryItem], **kwargs
    ) -> dict:
        retrieved_memory_ids = kwargs.get("retrieved_memory_ids") or []
        chat_history = kwargs.get("chat_history", [])
        feedback_content = kwargs.get("feedback_content", "")
        info = kwargs.get("info", {})

        chat_history_lis = [f"""{msg["role"]}: {msg["content"]}""" for msg in chat_history[-4:]]
        history_str = "\n".join(chat_history_lis) + f"\nuser feedback: \n{feedback_content}"

        retrieved_memories = [
            self.graph_store.get_node(_id, user_name=user_name) for _id in retrieved_memory_ids
        ]
        filterd_ids = [
            item["id"] for item in retrieved_memories if "mode:fast" in item["metadata"]["tags"]
        ]
        if filterd_ids:
            logger.warning(
                f"[1223 Feedback Core: _feedback_memory] Since the tags mode is fast, no modifications are made to the following memory {filterd_ids}."
            )

        current_memories = [
            TextualMemoryItem(**item)
            for item in retrieved_memories
            if "mode:fast" not in item["metadata"]["tags"]
        ]

        with ContextThreadPoolExecutor(max_workers=3) as ex:
            futures = {
                ex.submit(
                    self.semantics_feedback,
                    user_id,
                    user_name,
                    mem,
                    current_memories,
                    history_str,
                    chat_history,
                    info,
                ): i
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
                        f"[1223 Feedback Core: _feedback_memory] Error processing memory index {i}: {e}",
                        exc_info=True,
                    )
            mem_res = [r for r in results if r]

        return {
            "record": {
                "add": [element for item in mem_res for element in item["record"]["add"]],
                "update": [element for item in mem_res for element in item["record"]["update"]],
            }
        }

    def _info_comparison(self, memory: TextualMemoryItem, _info: dict, include_keys: list) -> bool:
        """Filter the relevant memory items based on info"""
        if not _info and not memory.metadata.info:
            return True

        record = []
        for key in include_keys:
            info_v = _info.get(key)
            mem_v = memory.metadata.info.get(key, None) if memory.metadata.info else None
            record.append(info_v == mem_v)
        return all(record)

    def _retrieve(self, query: str, info=None, top_k=100, user_name=None):
        """Retrieve memory items"""
        retrieved_mems = self.searcher.search(
            query, info=info, user_name=user_name, top_k=top_k, full_recall=True
        )
        retrieved_mems = [item[0] for item in retrieved_mems if float(item[1]) > 0.01]
        return retrieved_mems

    def _vec_query(self, new_memories_embedding: list[float], user_name=None):
        """Vector retrieval query"""
        retrieved_ids = []
        retrieved_ids.extend(
            self.graph_store.search_by_embedding(
                new_memories_embedding,
                scope="UserMemory",
                user_name=user_name,
                top_k=10,
                threshold=0.2,
            )
        )
        retrieved_ids.extend(
            self.graph_store.search_by_embedding(
                new_memories_embedding,
                scope="LongTermMemory",
                user_name=user_name,
                top_k=10,
                threshold=0.2,
            )
        )
        current_memories = [
            self.graph_store.get_node(item["id"], user_name=user_name) for item in retrieved_ids
        ]

        if not retrieved_ids:
            logger.info(
                f"[1223 Feedback Core: _vec_query] No similar memories found for embedding query for user {user_name}."
            )

        filterd_ids = [
            item["id"] for item in current_memories if "mode:fast" in item["metadata"]["tags"]
        ]
        if filterd_ids:
            logger.warning(
                f"[1223 Feedback Core: _vec_query] Since the tags mode is fast, no modifications are made to the following memory {filterd_ids}."
            )
        return [
            TextualMemoryItem(**item)
            for item in current_memories
            if "mode:fast" not in item["metadata"]["tags"]
        ]

    def _get_llm_response(self, prompt: str, dsl: bool = True) -> dict:
        messages = [{"role": "user", "content": prompt}]
        try:
            response_text = self.llm.generate(messages, temperature=0.3, timeout=60)
            if dsl:
                response_text = response_text.replace("```", "").replace("json", "")
                cleaned_text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "", response_text)
                response_json = json.loads(cleaned_text)
            else:
                return response_text
        except Exception as e:
            logger.error(
                f"[Feedback Core LLM Error] Exception during chat generation: {e} | response_text： {response_text}"
            )
            response_json = None
        return response_json

    def filter_fault_update(self, operations: list[dict]):
        """To address the randomness of large model outputs, it is necessary to conduct validity evaluation on the texts used for memory override operations."""
        updated_operations = [item for item in operations if item["operation"] == "UPDATE"]
        if len(updated_operations) < 5:
            return operations

        lang = detect_lang("".join(updated_operations[0]["text"]))
        template = FEEDBACK_PROMPT_DICT["compare_judge"][lang]

        all_judge = []
        operations_chunks = general_split_into_chunks(updated_operations)
        with ContextThreadPoolExecutor(max_workers=10) as executor:
            future_to_chunk_idx = {}
            for chunk in operations_chunks:
                raw_operations_str = {"operations": chunk}
                prompt = template.format(raw_operations=str(raw_operations_str))

                future = executor.submit(self._get_llm_response, prompt)
                future_to_chunk_idx[future] = chunk
            for future in concurrent.futures.as_completed(future_to_chunk_idx):
                try:
                    judge_res = future.result()
                    if (
                        judge_res
                        and "operations_judgement" in judge_res
                        and isinstance(judge_res["operations_judgement"], list)
                    ):
                        all_judge.extend(judge_res["operations_judgement"])
                except Exception as e:
                    logger.error(f"[1223 Feedback Core: filter_fault_update] Judgement failed: {e}")

        logger.info(f"[1223 Feedback Core: filter_fault_update] LLM judgement: {all_judge}")
        id2op = {item["id"]: item for item in updated_operations}
        valid_updates = []
        for judge in all_judge:
            valid_update = None
            if judge["judgement"] == "UPDATE_APPROVED":
                valid_update = id2op.get(judge["id"], None)
            if valid_update:
                valid_updates.append(valid_update)

        logger.info(
            f"[1223 Feedback Core: filter_fault_update] {len(updated_operations)} -> {len(valid_updates)}"
        )
        return valid_updates + [item for item in operations if item["operation"] != "UPDATE"]

    def standard_operations(self, operations, current_memories):
        """
        Regularize the operation design
            1. Map the id to the correct original memory id
            2. If there is an update, skip the memory object of add
            3. If the modified text is too long, skip the update
        """
        right_ids = [item.id for item in current_memories]
        right_lower_map = {x.lower(): x for x in right_ids}

        def correct_item(data):
            try:
                assert "operation" in data
                if data.get("operation", "").lower() == "add":
                    return data

                if data.get("operation", "").lower() == "none":
                    return None

                assert (
                    "id" in data
                    and "text" in data
                    and "old_memory" in data
                    and data["operation"].lower() == "update"
                )

                if not should_keep_update(data["text"], data["old_memory"]):
                    logger.warning(
                        f"[1223 Feedback Core: semantics_feedback] Due to the excessive proportion of changes, skip update: {data}"
                    )
                    return None

                # id dehallucination
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
            except Exception:
                logger.error(
                    f"[1223 Feedback Core: standard_operations] Error processing operation item: {data}",
                    exc_info=True,
                )
            return None

        dehallu_res = [correct_item(item) for item in operations]
        dehalluded_operations = [item for item in dehallu_res if item]
        logger.info(f"[1223 Feedback Core: dehalluded_operations] {dehalluded_operations}")

        # c add objects
        add_texts = []
        llm_operations = []
        for item in dehalluded_operations:
            if item["operation"].lower() == "add" and "text" in item and item["text"]:
                if item["text"] in add_texts:
                    continue
                llm_operations.append(item)
                add_texts.append(item["text"])
            elif item["operation"].lower() == "update":
                llm_operations.append(item)
        logger.info(
            f"[1223 Feedback Core: deduplicate add] {len(dehalluded_operations)} ->  {len(llm_operations)} memories"
        )

        # Update takes precedence over add
        has_update = any(item.get("operation").lower() == "update" for item in llm_operations)
        if has_update:
            filtered_items = [
                item for item in llm_operations if item.get("operation").lower() == "add"
            ]
            update_items = [
                item for item in llm_operations if item.get("operation").lower() != "add"
            ]
            if filtered_items:
                logger.info(
                    f"[1223 Feedback Core: semantics_feedback] Due to have update objects, skip add: {filtered_items}"
                )
            return update_items
        else:
            return llm_operations

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

    def _doc_filter(self, doc_scope: str, memories: list[TextualMemoryItem]):
        """
        Filter the memory based on filename
        """
        filename2_memid = {}
        filename_mems = []

        for item in memories:
            for file_info in item.metadata.sources:
                if file_info.type == "file":
                    file_dict = file_info.original_part
                    filename = file_dict["file"]["filename"]
                    if filename not in filename2_memid:
                        filename2_memid[filename] = []
                        filename_mems.append(make_mem_item(filename))
                    filename2_memid[filename].append(item.id)

        rerank_res = self.reranker.rerank(doc_scope, filename_mems, top_k=100)
        inscope_docs = [item[0].memory for item in rerank_res if item[1] > 0.95]

        inscope_ids = [
            memid for inscope_file in inscope_docs for memid in filename2_memid[inscope_file]
        ]
        logger.info(
            f"[1223 Feedback Core: process_keyword_replace] These docs are in scope : {inscope_docs}, relared memids: {inscope_ids}"
        )
        filter_memories = [mem for mem in memories if mem.id in inscope_ids]
        return filter_memories

    def process_keyword_replace(
        self, user_id: str, user_name: str, kwp_judge: dict | None = None, info: dict | None = None
    ):
        """
        Memory keyword replace process
        """
        info = info or {}
        doc_scope = kwp_judge.get("doc_scope", "NONE")
        original_word = kwp_judge.get("original")
        target_word = kwp_judge.get("target")
        include_keys = ["agent_id", "app_id"]

        mem_info = {key: info[key] for key in info if key in include_keys}
        filter_dict = {f"info.{key}": info[key] for key in mem_info}

        if self.DB_IDX_READY:
            # retrieve
            lang = detect_lang(original_word)
            queries = (
                self._tokenize_chinese(original_word) if lang == "zh" else original_word.split()
            )

            must_part = f"{' & '.join(queries)}" if len(queries) > 1 else queries[0]
            retrieved_ids = self.graph_store.seach_by_keywords_tfidf(
                [must_part], user_name=user_name, filter=filter_dict
            )
            if len(retrieved_ids) < 1:
                retrieved_ids = self.graph_store.search_by_fulltext(
                    queries, top_k=100, user_name=user_name, filter=filter_dict
                )
        else:
            retrieved_ids = self.graph_store.seach_by_keywords_like(
                f"%{original_word}%", user_name=user_name, filter=filter_dict
            )

        mem_data = [
            self.graph_store.get_node(item["id"], user_name=user_name) for item in retrieved_ids
        ]
        retrieved_memories = [TextualMemoryItem(**item) for item in mem_data]
        retrieved_memories = [
            item
            for item in retrieved_memories
            if self._info_comparison(item, mem_info, include_keys)
        ]

        if doc_scope != "NONE":
            retrieved_memories = self._doc_filter(doc_scope, retrieved_memories)

        logger.info(
            f"[1223 Feedback Core: process_keyword_replace] Keywords recalled memory for user {user_name}: {len(retrieved_ids)} memories | After filtering: {len(retrieved_memories)} memories."
        )

        if not retrieved_memories:
            return {"record": {"add": [], "update": []}}

        # replace keywords
        pick_index = []
        update_memories = []
        for i, old_mem in enumerate(retrieved_memories):
            if original_word in old_mem.memory:
                mem = old_mem.model_copy(deep=True)
                mem.memory = mem.memory.replace(original_word, target_word)
                if original_word in mem.metadata.tags:
                    mem.metadata.tags.remove(original_word)
                if target_word not in mem.metadata.tags:
                    mem.metadata.tags.append(target_word)
                pick_index.append(i)
                update_memories.append(mem)
        update_memories_embed = self._batch_embed([mem.memory for mem in update_memories])

        for _i, embed in zip(range(len(update_memories)), update_memories_embed, strict=False):
            update_memories[_i].metadata.embedding = embed

        update_results = []
        with ContextThreadPoolExecutor(max_workers=10) as executor:
            future_to_info = {}
            for new_mem, old_idx in zip(update_memories, pick_index, strict=False):
                old_mem = retrieved_memories[old_idx]

                future = executor.submit(
                    self._single_update_operation,
                    old_mem,
                    new_mem,
                    user_id,
                    user_name,
                )
                future_to_info[future] = old_mem.id

            for future in future_to_info:
                try:
                    result = future.result()
                    update_results.append(result)
                except Exception as e:
                    mem_id = future_to_info[future][0]
                    logger.error(
                        f"[Feedback Core DB] Exception during update operation for memory {mem_id}: {e}"
                    )

        return {"record": {"add": [], "update": update_results}}

    def process_feedback_core(
        self,
        user_id: str,
        user_name: str,
        chat_history: list[MessageDict],
        feedback_content: str,
        info: dict | None = None,
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

        if feedback_content.strip() == "":
            return {"record": {"add": [], "update": []}}
        try:
            feedback_time = kwargs.get("feedback_time") or datetime.now().isoformat()
            session_id = kwargs.get("session_id")
            if not info:
                info = {"user_id": user_id, "user_name": user_name, "session_id": session_id}
            else:
                info.update({"user_id": user_id, "user_name": user_name, "session_id": session_id})

            logger.info(
                f"[1223 Feedback Core: process_feedback_core] Starting memory feedback process for user {user_name}"
            )
            # feedback keywords update
            kwp_judge = self._keyword_replace_judgement(feedback_content)
            if (
                kwp_judge
                and kwp_judge["if_keyword_replace"].lower() == "true"
                and kwp_judge.get("original", "NONE") != "NONE"
                and kwp_judge.get("target", "NONE") != "NONE"
            ):
                return self.process_keyword_replace(
                    user_id, user_name, kwp_judge=kwp_judge, info=info
                )

            # llm update memory
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
                        f"[1223 Feedback Core: process_feedback_core] No valid judgements for user {user_name}: {raw_judge}."
                    )
                    return {"record": {"add": [], "update": []}}

                feedback_memories = []

                corrected_infos = [item["corrected_info"] for item in valid_feedback]
                feedback_memories_embeddings = self._batch_embed(corrected_infos)

                for item, embedding in zip(
                    valid_feedback, feedback_memories_embeddings, strict=False
                ):
                    value = item["corrected_info"]
                    key = item["key"]
                    tags = item["tags"]
                    background = (
                        "[Feedback update background]: "
                        + str(chat_history)
                        + "\nUser feedback: "
                        + str(feedback_content)
                    )
                    mem_item = make_mem_item(
                        value,
                        user_id=user_id,
                        user_name=user_name,
                        session_id=session_id,
                        tags=tags,
                        key=key,
                        embedding=embedding,
                        sources=[{"type": "chat"}],
                        background=background,
                        type="fine",
                        info=info,
                    )
                    feedback_memories.append(mem_item)

                mem_record = self._feedback_memory(
                    user_id,
                    user_name,
                    feedback_memories,
                    chat_history=chat_history,
                    feedback_content=feedback_content,
                    info=info,
                    **kwargs,
                )
                add_memories = mem_record["record"]["add"]
                update_memories = mem_record["record"]["update"]
                logger.info(
                    f"[1223 Feedback Core: process_feedback_core] Processed {len(feedback_memories)} feedback | add {len(add_memories)} memories | update {len(update_memories)} memories for user {user_name}."
                )
                return mem_record

        except Exception as e:
            logger.error(
                f"[1223 Feedback Core: process_feedback_core] Error for user {user_name}: {e}"
            )
            return {"record": {"add": [], "update": []}}

    def process_feedback(
        self,
        user_id: str,
        user_name: str,
        chat_history: list[MessageDict],
        feedback_content: str,
        info: dict[str, Any] | None = None,
        **kwargs,
    ):
        """
        Process feedback with different modes.

        Args:
            user_name: cube_ids
            chat_history: List of chat messages
            feedback_content: Feedback content from user
            **kwargs: Additional arguments including async_mode

        Returns:
            Dict with answer and/or memory operation records
        """
        corrected_answer = kwargs.get("corrected_answer", False)

        with ContextThreadPoolExecutor(max_workers=2) as ex:
            answer_future = ex.submit(
                self._generate_answer,
                chat_history,
                feedback_content,
                corrected_answer=corrected_answer,
            )
            core_future = ex.submit(
                self.process_feedback_core,
                user_id,
                user_name,
                chat_history,
                feedback_content,
                info,
                **kwargs,
            )
            done, pending = concurrent.futures.wait([answer_future, core_future], timeout=30)
            for fut in pending:
                fut.cancel()
            try:
                answer = answer_future.result()
                record = core_future.result()
                task_id = kwargs.get("task_id", "default")

                logger.info(
                    f"[Feedback Core MemFeedback process] Feedback Completed : user {user_name} | task_id {task_id} | record {record}."
                )

                return {"answer": answer, "record": record["record"]}
            except concurrent.futures.TimeoutError:
                logger.error(
                    f"[Feedback Core MemFeedback process] Timeout in sync mode for {user_name}",
                    exc_info=True,
                )
                return {"answer": "", "record": {"add": [], "update": []}}
            except Exception as e:
                logger.error(
                    f"[Feedback Core MemFeedback process] Error in concurrent tasks for {user_name}: {e}",
                    exc_info=True,
                )
                return {"answer": "", "record": {"add": [], "update": []}}
