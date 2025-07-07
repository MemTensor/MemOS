import json
import re

from string import Template

from memos.memories.textual.item import TextualMemoryItem
from memos.memories.textual.tree_text_memory.retrieve.retrieval_mid_structs import ParsedTaskGoal
from memos.memories.textual.tree_text_memory.retrieve.utils import REASON_PROMPT


class MemoryReasoner:
    """
    Memory reasoner that performs reasoning and knowledge synthesis
    over retrieved memory items using a language model.
    """

    def __init__(self, llm):
        self.llm = llm

    def reason(
        self, query: str, ranked_memories: list, parsed_goal: ParsedTaskGoal
    ) -> list[TextualMemoryItem]:
        """
        Reason across multiple retrieved memory items and synthesize
        a response or knowledge structure based on query objective.

        Args:
            query (str): Original user query description.
            ranked_memories (list): List of relevant memory items.
            parsed_goal (dict): Structured topic/concept/fact from TaskGoalParser.

        Returns:
            List of TextualMemoryItem: Refined memory items.
        """
        prompt_template = Template(REASON_PROMPT)
        memory_detailed_str = "\n".join(
            [f"[{m.id}] {m.metadata.key}: {m.memory}" for m in ranked_memories]
        )
        prompt = prompt_template.substitute(task=query, detailed_memory_list=memory_detailed_str)

        response = self.llm.generate([{"role": "user", "content": prompt}])
        content = response.content if hasattr(response, "content") else response

        # Step 1: Extract selected IDs
        selected_ids = self._parse_selected_ids(content)
        id_set = set(selected_ids)

        return [m for m in ranked_memories if m.id in id_set]

    def _parse_selected_ids(self, response_text: str) -> list[str]:
        """
        Extracts memory IDs from model response. Supports both simple text list and JSON.
        """
        try:
            parsed = json.loads(response_text)
            if isinstance(parsed, dict) and "selected_ids" in parsed:
                return parsed["selected_ids"]
        except json.JSONDecodeError:
            pass

        return re.findall(r"[a-f0-9\-]{36}", response_text)  # UUID pattern fallback
