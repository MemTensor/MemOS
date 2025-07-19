from abc import ABC, abstractmethod
from collections.abc import Generator

from memos.configs.llm import BaseLLMConfig
from memos.types import MessageList


class BaseLLM(ABC):
    """Base class for all LLMs."""

    @abstractmethod
    def __init__(self, config: BaseLLMConfig):
        """Initialize the LLM with the given configuration."""

    @abstractmethod
    def generate(self, messages: MessageList, **kwargs) -> str:
        """Generate a response from the LLM."""

    @abstractmethod
    def generate_stream(self, messages: MessageList, **kwargs) -> Generator[str, None, None]:
        """
        (Optional) Generate a streaming response from the LLM.
        Subclasses should override this if they support streaming.
        By default, this raises NotImplementedError.
        """
