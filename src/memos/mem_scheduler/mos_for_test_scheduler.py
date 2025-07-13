import os
from datetime import datetime
from pathlib import Path
from threading import Lock
from typing import Any, Literal

from flatbuffers.compat import memoryview_type
from memos.configs.mem_os import MOSConfig
from memos.mem_os.main import MOS
from memos.configs.mem_os import MOSConfig
from memos.llms.factory import LLMFactory
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_reader.factory import MemReaderFactory
from memos.mem_scheduler.general_scheduler import GeneralScheduler
from memos.mem_scheduler.modules.schemas import ANSWER_LABEL, QUERY_LABEL, ScheduleMessageItem
from memos.mem_scheduler.scheduler_factory import SchedulerFactory
from memos.mem_user.user_manager import UserManager, UserRole
from memos.memories.activation.item import ActivationMemoryItem
from memos.memories.parametric.item import ParametricMemoryItem
from memos.memories.textual.item import TextualMemoryItem, TextualMemoryMetadata
from memos.types import ChatHistory, MessageList, MOSSearchResult
from memos.mem_scheduler.modules.schemas import (
    MONITOR_WORKING_MEMORY_TYPE,
    MONITOR_ACTIVATION_MEMORY_TYPE,
)
logger = get_logger(__name__)

class MOSForTestScheduler(MOS):
    """This class is only to test abilities of mem scheduler"""

    def __init__(self, config: MOSConfig):
        super().__init__(config)

    def _str_memories(
        self, memories: list[str]
    ) -> str:
        """Format memories for display."""
        if not memories:
            return "No memories."
        return "\n".join(f"{i + 1}. {memory}" for i, memory in enumerate(memories))


    def chat(self, query: str, user_id: str | None = None) -> str:
        """
        Chat with the MOS.

        Args:
            query (str): The user's query.

        Returns:
            str: The response from the MOS.
        """
        target_user_id = user_id if user_id is not None else self.user_id
        accessible_cubes = self.user_manager.get_user_cubes(target_user_id)
        user_cube_ids = [cube.cube_id for cube in accessible_cubes]
        if target_user_id not in self.chat_history_manager:
            self._register_chat_history(target_user_id)

        chat_history = self.chat_history_manager[target_user_id]

        topk_for_scheduler = 2

        if self.config.enable_textual_memory and self.mem_cubes:
            memories_all = []
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if not mem_cube.text_mem:
                    continue

                # submit message to scheduler
                if self.enable_mem_scheduler and self.mem_scheduler is not None:
                    message_item = ScheduleMessageItem(
                        user_id=target_user_id,
                        mem_cube_id=mem_cube_id,
                        mem_cube=mem_cube,
                        label=QUERY_LABEL,
                        content=query,
                        timestamp=datetime.now(),
                    )
                    self.mem_scheduler.submit_messages(messages=[message_item])
                    self.mem_scheduler.monitor.update_mem_cube_info(user_id=user_id,
                                                                    mem_cube_id=mem_cube_id,
                                                                    mem_cube=mem_cube)

                # from scheduler
                scheduler_memories = self.mem_scheduler.monitor.get_monitor_memories(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    memory_type=MONITOR_WORKING_MEMORY_TYPE,
                    top_k=topk_for_scheduler
                )
                memories_all.extend(scheduler_memories)

                # from mem_cube
                memories = mem_cube.text_mem.search(query, top_k=self.config.top_k-topk_for_scheduler)
                text_memories = [m.memory for m in memories]
                memories_all.extend(text_memories)

                memories_all = list(set(memories_all))

            logger.info(f"🧠 [Memory] Searched memories:\n{self._str_memories(memories_all)}\n")
            system_prompt = self._build_system_prompt(memories_all)
        else:
            system_prompt = self._build_system_prompt()
        current_messages = [
            {"role": "system", "content": system_prompt},
            *chat_history.chat_history,
            {"role": "user", "content": query},
        ]
        past_key_values = None

        if self.config.enable_activation_memory:
            assert self.config.chat_model.backend == "huggingface", (
                "Activation memory only used for huggingface backend."
            )
            # TODO this only one cubes
            for mem_cube_id, mem_cube in self.mem_cubes.items():
                if mem_cube_id not in user_cube_ids:
                    continue
                if mem_cube.act_mem:
                    kv_cache = next(iter(mem_cube.act_mem.get_all()), None)
                    past_key_values = (
                        kv_cache.memory if (kv_cache and hasattr(kv_cache, "memory")) else None
                    )
                    break
            # Generate response
            response = self.chat_llm.generate(current_messages, past_key_values=past_key_values)
        else:
            response = self.chat_llm.generate(current_messages)
        logger.info(f"🤖 [Assistant] {response}\n")
        chat_history.chat_history.append({"role": "user", "content": query})
        chat_history.chat_history.append({"role": "assistant", "content": response})
        self.chat_history_manager[user_id] = chat_history

        # submit message to scheduler
        for accessible_mem_cube in accessible_cubes:
            mem_cube_id = accessible_mem_cube.cube_id
            mem_cube = self.mem_cubes[mem_cube_id]
            if self.enable_mem_scheduler and self.mem_scheduler is not None:
                message_item = ScheduleMessageItem(
                    user_id=target_user_id,
                    mem_cube_id=mem_cube_id,
                    mem_cube=mem_cube,
                    label=ANSWER_LABEL,
                    content=response,
                    timestamp=datetime.now(),
                )
                self.mem_scheduler.submit_messages(messages=[message_item])

        return response
