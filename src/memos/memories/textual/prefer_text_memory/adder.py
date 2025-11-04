import json
import os

from abc import ABC, abstractmethod
from concurrent.futures import as_completed
from datetime import datetime
from typing import Any

from memos.context.context import ContextThreadPoolExecutor
from memos.log import get_logger
from memos.memories.textual.item import TextualMemoryItem
from memos.templates.prefer_complete_prompt import (
    NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT,
    NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_FINE,
    NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE,
)
from memos.vec_dbs.item import MilvusVecDBItem


logger = get_logger(__name__)


class BaseAdder(ABC):
    """Abstract base class for adders."""

    @abstractmethod
    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the adder."""

    @abstractmethod
    def add(self, memories: list[TextualMemoryItem | dict[str, Any]], *args, **kwargs) -> list[str]:
        """Add the instruct preference memories.
        Args:
            memories (list[TextualMemoryItem | dict[str, Any]]): The memories to add.
            **kwargs: Additional keyword arguments.
        Returns:
            list[str]: List of added memory IDs.
        """


class NaiveAdder(BaseAdder):
    """Naive adder."""

    def __init__(self, llm_provider=None, embedder=None, vector_db=None):
        """Initialize the naive adder."""
        super().__init__(llm_provider, embedder, vector_db)
        self.llm_provider = llm_provider
        self.embedder = embedder
        self.vector_db = vector_db

    def _judge_update_or_add_fast(self, old_msg: str, new_msg: str) -> bool:
        """Judge if the new message expresses the same core content as the old message."""
        # Use the template prompt with placeholders
        prompt = NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT.replace("{old_information}", old_msg).replace(
            "{new_information}", new_msg
        )

        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            response = result.get("is_same", False)
            return response if isinstance(response, bool) else response.lower() == "true"
        except Exception as e:
            logger.error(f"Error in judge_update_or_add: {e}")
            # Fallback to simple string comparison
            return old_msg == new_msg

    def _judge_update_or_add_fine(self, new_mem: str, retrieved_mems: str) -> dict[str, Any] | None:
        if not retrieved_mems:
            return None
        prompt = NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_FINE.replace("{new_memory}", new_mem).replace(
            "{retrieved_memories}", retrieved_mems
        )
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            return result
        except Exception as e:
            logger.error(f"Error in judge_update_or_add_fine: {e}")
            return None

    def _judge_update_or_add_trace_op(
        self, new_mems: str, retrieved_mems: str
    ) -> dict[str, Any] | None:
        if not retrieved_mems:
            return None
        prompt = NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE.replace(
            "{new_memories}", new_mems
        ).replace("{retrieved_memories}", retrieved_mems)
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            return result
        except Exception as e:
            logger.error(f"Error in judge_update_or_add_trace_op: {e}")
            return None

    def _update_memory_op_trace(
        self,
        new_memories: list[TextualMemoryItem],
        retrieved_memories: list[MilvusVecDBItem],
        collection_name: str,
        preference_type: str,
    ) -> list[str] | str:
        # create new vec db items
        new_vec_db_items: list[MilvusVecDBItem] = []
        for new_memory in new_memories:
            payload = new_memory.to_dict()["metadata"]
            fields_to_remove = {"dialog_id", "original_text", "embedding"}
            payload = {k: v for k, v in payload.items() if k not in fields_to_remove}
            new_vec_db_item = MilvusVecDBItem(
                id=new_memory.id,
                memory=new_memory.memory,
                original_text=new_memory.metadata.original_text,
                vector=new_memory.metadata.embedding,
                payload=payload,
            )
            new_vec_db_items.append(new_vec_db_item)

        new_mem_inputs = [
            {
                "id": new_memory.id,
                "context_summary": new_memory.memory,
                "preference": new_memory.payload[preference_type],
            }
            for new_memory in new_vec_db_items
        ]
        retrieved_mem_inputs = [
            {
                "id": mem.id,
                "context_summary": mem.memory,
                "preference": mem.payload[preference_type],
            }
            for mem in retrieved_memories
        ]

        rsp = self._judge_update_or_add_trace_op(
            new_mems=json.dumps(new_mem_inputs),
            retrieved_mems=json.dumps(retrieved_mem_inputs) if retrieved_mem_inputs else "",
        )
        if not rsp:
            with ContextThreadPoolExecutor(max_workers=min(len(new_vec_db_items), 5)) as executor:
                futures = {
                    executor.submit(self.vector_db.add, collection_name, [db_item]): db_item
                    for db_item in new_vec_db_items
                }
                for future in as_completed(futures):
                    result = future.result()
            return [db_item.id for db_item in new_vec_db_items]

        new_mem_db_item_map = {db_item.id: db_item for db_item in new_vec_db_items}
        retrieved_mem_db_item_map = {db_item.id: db_item for db_item in retrieved_memories}

        def execute_op(
            op,
            new_mem_db_item_map: dict[str, MilvusVecDBItem],
            retrieved_mem_db_item_map: dict[str, MilvusVecDBItem],
        ) -> str | None:
            op_type = op["type"].lower()
            if op_type == "add":
                if op["target_id"] in new_mem_db_item_map:
                    self.vector_db.add(collection_name, [new_mem_db_item_map[op["target_id"]]])
                    return new_mem_db_item_map[op["target_id"]].id
                return None
            elif op_type == "update":
                if op["target_id"] in retrieved_mem_db_item_map:
                    update_mem_db_item = retrieved_mem_db_item_map[op["target_id"]]
                    update_mem_db_item.payload[preference_type] = op["new_preference"]
                    update_mem_db_item.payload["updated_at"] = datetime.now().isoformat()
                    update_mem_db_item.memory = op["new_context_summary"]
                    update_mem_db_item.original_text = op["new_context_summary"]
                    update_mem_db_item.vector = self.embedder.embed([op["new_context_summary"]])[0]
                    self.vector_db.update(collection_name, op["target_id"], update_mem_db_item)
                    return op["target_id"]
                return None
            elif op_type == "delete":
                self.vector_db.delete(collection_name, [op["target_id"]])
                return None

        with ContextThreadPoolExecutor(max_workers=min(len(rsp["trace"]), 5)) as executor:
            future_to_op = {
                executor.submit(execute_op, op, new_mem_db_item_map, retrieved_mem_db_item_map): op
                for op in rsp["trace"]
            }
            added_ids = []
            for future in as_completed(future_to_op):
                result = future.result()
                if result is not None:
                    added_ids.append(result)

        return added_ids

    def _update_memory_fine(
        self,
        new_memory: TextualMemoryItem,
        retrieved_memories: list[MilvusVecDBItem],
        collection_name: str,
        preference_type: str,
    ) -> str:
        payload = new_memory.to_dict()["metadata"]
        fields_to_remove = {"dialog_id", "original_text", "embedding"}
        payload = {k: v for k, v in payload.items() if k not in fields_to_remove}
        vec_db_item = MilvusVecDBItem(
            id=new_memory.id,
            memory=new_memory.memory,
            original_text=new_memory.metadata.original_text,
            vector=new_memory.metadata.embedding,
            payload=payload,
        )

        new_mem_input = {
            "memory": new_memory.memory,
            "preference": new_memory.metadata.explicit_preference
            if preference_type == "explicit_preference"
            else new_memory.metadata.implicit_preference,
        }
        retrieved_mem_inputs = [
            {
                "id": mem.id,
                "memory": mem.memory,
                "preference": mem.payload[preference_type],
            }
            for mem in retrieved_memories
        ]
        rsp = self._judge_update_or_add_fine(
            new_mem=json.dumps(new_mem_input),
            retrieved_mems=json.dumps(retrieved_mem_inputs) if retrieved_mem_inputs else "",
        )
        need_update = rsp.get("need_update", False) if rsp else False
        need_update = (
            need_update if isinstance(need_update, bool) else need_update.lower() == "true"
        )
        update_item = (
            [mem for mem in retrieved_memories if mem.id == rsp["id"]]
            if rsp and "id" in rsp
            else []
        )
        if need_update and update_item and rsp:
            update_vec_db_item = update_item[0]
            update_vec_db_item.payload[preference_type] = rsp["new_preference"]
            update_vec_db_item.payload["updated_at"] = vec_db_item.payload["updated_at"]
            update_vec_db_item.memory = rsp["new_memory"]
            update_vec_db_item.original_text = vec_db_item.original_text
            update_vec_db_item.vector = self.embedder.embed([rsp["new_memory"]])[0]

            self.vector_db.update(collection_name, rsp["id"], update_vec_db_item)
            return rsp["id"]
        else:
            self.vector_db.add(collection_name, [vec_db_item])
            return vec_db_item.id

    def _update_memory_fast(
        self,
        new_memory: TextualMemoryItem,
        retrieved_memories: list[MilvusVecDBItem],
        collection_name: str,
    ) -> str:
        payload = new_memory.to_dict()["metadata"]
        fields_to_remove = {"dialog_id", "original_text", "embedding"}
        payload = {k: v for k, v in payload.items() if k not in fields_to_remove}
        vec_db_item = MilvusVecDBItem(
            id=new_memory.id,
            memory=new_memory.memory,
            original_text=new_memory.metadata.original_text,
            vector=new_memory.metadata.embedding,
            payload=payload,
        )
        recall = retrieved_memories[0] if retrieved_memories else None
        if not recall or (recall.score is not None and recall.score < 0.5):
            self.vector_db.add(collection_name, [vec_db_item])
            return new_memory.id

        old_msg_str = recall.memory
        new_msg_str = new_memory.memory
        is_same = self._judge_update_or_add_fast(old_msg=old_msg_str, new_msg=new_msg_str)
        if is_same:
            vec_db_item.id = recall.id
            self.vector_db.update(collection_name, recall.id, vec_db_item)
        self.vector_db.add(collection_name, [vec_db_item])
        return new_memory.id

    def _update_memory(
        self,
        new_memory: TextualMemoryItem,
        retrieved_memories: list[MilvusVecDBItem],
        collection_name: str,
        preference_type: str,
        update_mode: str = "fast",
    ) -> list[str] | str | None:
        """Update the memory.
        Args:
            new_memory: TextualMemoryItem
            retrieved_memories: list[MilvusVecDBItem]
            collection_name: str
            preference_type: str
            update_mode: str, "fast" or "fine"
        """
        if update_mode == "fast":
            return self._update_memory_fast(new_memory, retrieved_memories, collection_name)
        elif update_mode == "fine":
            return self._update_memory_fine(
                new_memory, retrieved_memories, collection_name, preference_type
            )
        else:
            raise ValueError(f"Invalid update mode: {update_mode}")

    def _process_single_memory(self, memory: TextualMemoryItem) -> list[str] | str | None:
        """Process a single memory and return its ID if added successfully."""
        try:
            pref_type_collection_map = {
                "explicit_preference": "explicit_preference",
                "implicit_preference": "implicit_preference",
            }
            preference_type = memory.metadata.preference_type
            collection_name = pref_type_collection_map[preference_type]

            search_results = self.vector_db.search(
                query_vector=memory.metadata.embedding,
                query=memory.memory,
                collection_name=collection_name,
                top_k=5,
                filter={"user_id": memory.metadata.user_id},
            )
            search_results.sort(key=lambda x: x.score, reverse=True)

            return self._update_memory(
                memory,
                search_results,
                collection_name,
                preference_type,
                update_mode=os.getenv("PREFERENCE_ADDER_MODE", "fast"),
            )

        except Exception as e:
            logger.error(f"Error processing memory {memory.id}: {e}")
            return None

    def process_memory_batch(self, memories: list[TextualMemoryItem], *args, **kwargs) -> list[str]:
        pref_type_collection_map = {
            "explicit_preference": "explicit_preference",
            "implicit_preference": "implicit_preference",
        }

        explicit_new_mems = []
        implicit_new_mems = []
        explicit_recalls = []
        implicit_recalls = []

        for memory in memories:
            preference_type = memory.metadata.preference_type
            collection_name = pref_type_collection_map[preference_type]
            search_results = self.vector_db.search(
                query_vector=memory.metadata.embedding,
                query=memory.memory,
                collection_name=collection_name,
                top_k=5,
                filter={"user_id": memory.metadata.user_id},
            )
            if preference_type == "explicit_preference":
                explicit_recalls.extend(search_results)
                explicit_new_mems.append(memory)
            elif preference_type == "implicit_preference":
                implicit_recalls.extend(search_results)
                implicit_new_mems.append(memory)

        explicit_recalls = list({recall.id: recall for recall in explicit_recalls}.values())
        implicit_recalls = list({recall.id: recall for recall in implicit_recalls}.values())

        explicit_added_ids = self._update_memory_op_trace(
            explicit_new_mems,
            explicit_recalls,
            pref_type_collection_map["explicit_preference"],
            "explicit_preference",
        )
        implicit_added_ids = self._update_memory_op_trace(
            implicit_new_mems,
            implicit_recalls,
            pref_type_collection_map["implicit_preference"],
            "implicit_preference",
        )
        return explicit_added_ids + implicit_added_ids

    def process_memory_single(
        self, memories: list[TextualMemoryItem], max_workers: int = 8, *args, **kwargs
    ) -> list[str]:
        added_ids: list[str] = []
        with ContextThreadPoolExecutor(max_workers=min(max_workers, len(memories))) as executor:
            future_to_memory = {
                executor.submit(self._process_single_memory, memory): memory for memory in memories
            }

            for future in as_completed(future_to_memory):
                try:
                    memory_id = future.result()
                    if memory_id:
                        if isinstance(memory_id, list):
                            added_ids.extend(memory_id)
                        else:
                            added_ids.append(memory_id)
                except Exception as e:
                    memory = future_to_memory[future]
                    logger.error(f"Error processing memory {memory.id}: {e}")
                    continue
        return added_ids

    def add(
        self,
        memories: list[TextualMemoryItem | dict[str, Any]],
        max_workers: int = 8,
        *args,
        **kwargs,
    ) -> list[str]:
        """Add the instruct preference memories using thread pool for acceleration."""
        if not memories:
            return []

        process_map = {
            "single": self.process_memory_single,
            "batch": self.process_memory_batch,
        }

        process_func = process_map["single"]
        return process_func(memories, max_workers)
