import json
from typing import Any, List

from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.modules.base import BaseSchedulerModule
from memos.mem_scheduler.utils import extract_json_dict
from memos.memories.textual.tree import TreeTextMemory


logger = get_logger(__name__)


class SchedulerMonitor(BaseSchedulerModule):
    def __init__(self, chat_llm, activation_mem_size=5):
        super().__init__()
        self.statistics = {}
        self.intent_history: list[str] = []
        self.activation_mem_size = activation_mem_size
        self.activation_memory_freq_list = [
            {"memory": None, "count": 0} for _ in range(self.activation_mem_size)
        ]

        self._chat_llm = chat_llm

    def update_stats(self, mem_cube):
        self.statistics["activation_mem_size"] = self.activation_mem_size
        mem_cube_info = self.get_mem_cube_info(mem_cube)
        self.statistics.update(mem_cube_info)

    def get_mem_cube_info(self, mem_cube: GeneralMemCube):
        mem_cube_info = {}

        text_mem = mem_cube.text_mem
        if isinstance(text_mem, TreeTextMemory):
            memory_size_dict = text_mem.memory_manager.memory_size
            mem_cube_info["text_mem"] = memory_size_dict
        else:
            logger.error("Not Implemented")

        return mem_cube_info


    def detect_intent(
        self,
        q_list: list[str],
        text_working_memory: list[str],
        prompt_name="intent_recognizing",
    ) -> dict[str, Any]:
        """
        Detect the intent of the user input.
        """
        prompt = self.build_prompt(
            template_name=prompt_name,
            q_list=q_list,
            working_memory_list=text_working_memory,
        )
        response = self._chat_llm.generate([{"role": "user", "content": prompt}])
        response = extract_json_dict(response)
        return response

    def update_freq(
        self,
        answer: str,
        text_working_memory: list[str],
        activation_memory_freq_list: list[dict],
        prompt_name="freq_detecting",
    ) -> list[dict]:
        """
        Use LLM to detect which memories in activation_memory_freq_list appear in the answer,
        increment their count by 1, and return the updated list.
        """
        prompt = self.build_prompt(
            template_name=prompt_name,
            answer=answer,
            working_memory_list=text_working_memory,
            activation_memory_freq_list=activation_memory_freq_list,
        )
        response = self._chat_llm.generate([{"role": "user", "content": prompt}])
        try:
            result = json.loads(response)
        except Exception:
            result = activation_memory_freq_list
        return result
