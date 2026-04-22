from pathlib import Path

from memos.llms.base import BaseLLM
from memos.log import get_logger
from memos.mem_cube.general import GeneralMemCube
from memos.mem_scheduler.schemas.general_schemas import BASE_DIR
from memos.templates.mem_scheduler_prompts import PROMPT_MAPPING


logger = get_logger(__name__)


class BaseSchedulerModule:
    def __init__(self):
        """Initialize the scheduler with the given configuration."""
        self.base_dir = Path(BASE_DIR)

        self._chat_llm = None
        self._process_llm = None

    def load_template(self, template_name: str) -> str:
        if template_name not in PROMPT_MAPPING:
            logger.error("Prompt template is not found!")
        prompt = PROMPT_MAPPING[template_name]
        return prompt

    def build_prompt(self, template_name: str, **kwargs) -> str:
        template = self.load_template(template_name)
        if not template:
            raise FileNotFoundError(f"Prompt template `{template_name}` not found.")
        return template.format(**kwargs)

    def _build_system_prompt(self, memories: list | None = None) -> str:
        """Build system prompt with optional memories context."""
        base_prompt = (
            "You are a knowledgeable and helpful AI assistant. "
            "You have access to conversation memories that help you provide more personalized responses. "
            "Use the memories to understand the user's context, preferences, and past interactions. "
            "If memories are provided, reference them naturally when relevant, but don't explicitly mention having memories."
        )

        if memories:
            memory_context = "\n\n## Conversation Context:\n"
            for i, memory in enumerate(memories, 1):
                memory_context += f"{i}. {memory.memory}\n"
            return base_prompt + memory_context

        return base_prompt

    def get_mem_cube(self, mem_cube_id: str) -> GeneralMemCube:
        logger.error(f"mem_cube {mem_cube_id} does not exists.")
        return self.current_mem_cube

    @property
    def chat_llm(self) -> BaseLLM:
        """The memory cube associated with this MemChat."""
        return self._chat_llm

    @chat_llm.setter
    def chat_llm(self, value: BaseLLM) -> None:
        """The memory cube associated with this MemChat."""
        self._chat_llm = value

    @property
    def process_llm(self) -> BaseLLM:
        return self._process_llm

    @process_llm.setter
    def process_llm(self, value: BaseLLM) -> None:
        self._process_llm = value

    @property
    def mem_cube(self) -> GeneralMemCube:
        """The memory cube associated with this MemChat."""
        return self.current_mem_cube

    @mem_cube.setter
    def mem_cube(self, value: GeneralMemCube) -> None:
        """The memory cube associated with this MemChat."""
        self.current_mem_cube = value
