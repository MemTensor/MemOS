from abc import ABC, abstractmethod

from memos.configs.memory import MemFeedbackConfig


class BaseMemFeedback(ABC):
    """MemFeedback interface class for reading information."""

    @abstractmethod
    def __init__(self, config: MemFeedbackConfig):
        """Initialize the MemFeedback with the given configuration."""

    @abstractmethod
    def process_feedback(self, data: dict) -> None:
        """Process user's feedback"""
