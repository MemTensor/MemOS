import json

from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from memos.memories.textual.item import TextualMemoryItem
from memos.templates.prefer_complete_prompt import NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT, NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE
from memos.vec_dbs.item import MilvusVecDBItem


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
            return response if isinstance(response, bool) else response == "true"
        except Exception as e:
            print(f"Error in judge_update_or_add: {e}")
            # Fallback to simple string comparison
            return old_msg == new_msg

    def _judge_update_or_add_trace_op(self, new_mem: str, retrieved_mems: str) -> dict[str, Any] | None:
        prompt = NAIVE_JUDGE_UPDATE_OR_ADD_PROMPT_OP_TRACE.replace("{new_memory}", new_mem).replace("{retrieved_memories}", retrieved_mems)
        try:
            response = self.llm_provider.generate([{"role": "user", "content": prompt}])
            response = response.strip().replace("```json", "").replace("```", "").strip()
            result = json.loads(response)
            return result
        except Exception as e:
            print(f"Error in judge_update_or_add_trace_op: {e}")
            return None

    def _update_memory_op_trace(self,
            new_memory: TextualMemoryItem,
            retrieved_memories: list[MilvusVecDBItem],
            collection_name: str,
            preference_type: str
        ) -> list[str] | str:

        if not retrieved_memories:
            payload = new_memory.to_dict()["metadata"]
            fields_to_remove = {"dialog_id", "dialog_str", "embedding"}
            payload = {k: v for k, v in payload.items() if k not in fields_to_remove}
            vec_db_item = MilvusVecDBItem(
                id=new_memory.id, memory=new_memory.memory, vector=new_memory.metadata.embedding, payload=payload
            )
            self.vector_db.add(collection_name, [vec_db_item])
            return new_memory.id

        new_mem_input = {
            "context_summary": new_memory.memory,
            "preference": new_memory.metadata.explicit_preference if preference_type == "explicit_preference" else new_memory.metadata.implicit_preference,
        }
        retrieved_mem_inputs = [{"id": mem.id, "context_summary": mem.memory, "preference": mem.payload[preference_type]} for mem in retrieved_memories]

        rsp = self._judge_update_or_add_trace_op(new_mem=json.dumps(new_mem_input), retrieved_mems=json.dumps(retrieved_mem_inputs))
        if not rsp:
            payload = new_memory.to_dict()["metadata"]
            fields_to_remove = {"dialog_id", "dialog_str", "embedding"}
            payload = {k: v for k, v in payload.items() if k not in fields_to_remove}
            vec_db_item = MilvusVecDBItem(
                id=new_memory.id, memory=new_memory.memory, vector=new_memory.metadata.embedding, payload=payload
            )
            self.vector_db.add(collection_name, [vec_db_item])
            return new_memory.id
        
        def execute_op(op):
            op_type = op["type"].lower()
            if op_type == "add":
                payload = new_memory.to_dict()["metadata"]
                payload = {k: v for k, v in payload.items() if k not in {"dialog_id", "dialog_str", "embedding"}}
                vec_db_item = MilvusVecDBItem(
                    id=new_memory.id, memory=new_memory.memory, 
                    vector=new_memory.metadata.embedding, payload=payload
                )
                self.vector_db.add(collection_name, [vec_db_item])
                return new_memory.id
            elif op_type == "update":
                payload = {"preference_type": preference_type, preference_type: op["new_preference"]}
                vec_db_item = MilvusVecDBItem(
                    id=op["target_id"], memory=op["new_context_summary"], 
                    vector=self.embedder.embed([op["new_context_summary"]])[0], payload=payload
                )
                self.vector_db.update(collection_name, op["target_id"], vec_db_item)
                return op["target_id"]
            elif op_type == "delete":
                self.vector_db.delete(collection_name, [op["target_id"]])
                return None
        
        with ThreadPoolExecutor(max_workers=min(len(rsp["trace"]), 5)) as executor:
            future_to_op = {executor.submit(execute_op, op): op for op in rsp["trace"]}
            added_ids = []
            for future in as_completed(future_to_op):
                result = future.result()
                if result is not None:
                    added_ids.append(result)

        return added_ids

    def _update_memory_fast(self,
            new_memory: TextualMemoryItem,
            retrieved_memories: list[MilvusVecDBItem],
            collection_name: str,
        ) -> str:
        payload = new_memory.to_dict()["metadata"]
        fields_to_remove = {"dialog_id", "dialog_str", "embedding"}
        payload = {k: v for k, v in payload.items() if k not in fields_to_remove}
        vec_db_item = MilvusVecDBItem(
            id=new_memory.id, memory=new_memory.memory, vector=new_memory.metadata.embedding, payload=payload
        )
        recall = retrieved_memories[0] if retrieved_memories else None
        if not recall or (recall.score is not None and recall.score < 0.5):
            self.vector_db.add(collection_name, [vec_db_item])
            return new_memory.id

        old_msg_str = recall.memory
        new_msg_str = new_memory.memory
        is_same = self._judge_update_or_add_fast(old_msg=old_msg_str, new_msg=new_msg_str)
        if is_same:
            self.vector_db.delete(collection_name, [recall.id])
        self.vector_db.update(collection_name, new_memory.id, vec_db_item)
        return new_memory.id

    def _update_memory(self,
            new_memory: TextualMemoryItem,
            retrieved_memories: list[MilvusVecDBItem],
            collection_name: str,
            preference_type: str,
            update_mode: str = "op_trace",
        ) -> list[str] | str | None:
        """Update the memory.
        Args:
            new_memory: TextualMemoryItem
            retrieved_memories: list[MilvusVecDBItem]
            collection_name: str
            preference_type: str
            update_mode: str, "op_trace" or "fast"
        """
        if update_mode == "op_trace":
            return self._update_memory_op_trace(new_memory, retrieved_memories, collection_name, preference_type)
        elif update_mode == "fast":
            return self._update_memory_fast(new_memory, retrieved_memories, collection_name)
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
                memory.metadata.embedding, collection_name, top_k=5, filter={"user_id": memory.metadata.user_id}
            )
            search_results.sort(key=lambda x: x.score, reverse=True)
            
            return self._update_memory(memory, search_results, collection_name, preference_type, update_mode="fast")

        except Exception as e:
            print(f"Error processing memory {memory.id}: {e}")
            return None

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

        added_ids = []
        with ThreadPoolExecutor(max_workers=min(max_workers, len(memories))) as executor:
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
                    print(f"Error processing memory {memory.id}: {e}")
                    continue

        return added_ids
