import json

from string import Template

from memos.llms.base import BaseLLM
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal
from memos.memories.textual.tree_text_memory.retrieve.utils import TASK_PARSE_PROMPT


class TaskGoalParser:
    """
    Unified TaskGoalParser:
    - mode == 'fast': directly use origin task_description
    - mode == 'fine': use LLM to parse structured topic/keys/tags
    """

    def __init__(self, llm=BaseLLM, mode: str = "fast"):
        self.llm = llm
        self.mode = mode

    def parse(self, task_description: str, context: str = "") -> ParsedTaskGoal:
        """
        Parse user input into structured semantic layers.
        Returns:
            ParsedTaskGoal: object containing topic/concept/fact levels and optional metadata
        - mode == 'fast': use jieba to split words only
        - mode == 'fine': use LLM to parse structured topic/keys/tags
        """
        if self.mode == "fast":
            return self._parse_fast(task_description)
        elif self.mode == "fine":
            if not self.llm:
                raise ValueError("LLM not provided for slow mode.")
            return self._parse_fine(task_description, context)
        else:
            raise ValueError(f"Unknown mode: {self.mode}")

    def _parse_fast(self, task_description: str, limit_num: int = 5) -> ParsedTaskGoal:
        """
        Fast mode: simple jieba word split.
        """
        return ParsedTaskGoal(
            memories=[task_description], keys=[task_description], tags=[], goal_type="default"
        )

    def _parse_fine(self, query: str, context: str = "") -> ParsedTaskGoal:
        """
        Slow mode: LLM structured parse.
        """
        prompt = Template(TASK_PARSE_PROMPT).substitute(task=query.strip(), context=context)
        response = self.llm.generate(messages=[{"role": "user", "content": prompt}])
        return self._parse_response(response)

    def _parse_response(self, response: str) -> ParsedTaskGoal:
        """
        Parse LLM JSON output safely.
        """
        try:
            response = response.replace("```", "").replace("json", "")
            response_json = json.loads(response.strip())
            return ParsedTaskGoal(
                memories=response_json.get("memories", []),
                keys=response_json.get("keys", []),
                tags=response_json.get("tags", []),
                goal_type=response_json.get("goal_type", "default"),
            )
        except Exception as e:
            raise ValueError(f"Failed to parse LLM output: {e}\nRaw response:\n{response}") from e
