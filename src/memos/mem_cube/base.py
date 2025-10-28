from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from memos.configs.mem_cube import BaseMemCubeConfig


if TYPE_CHECKING:
    from memos.memories.activation.base import BaseActMemory
    from memos.memories.parametric.base import BaseParaMemory
    from memos.memories.textual.base import BaseTextMemory


class BaseMemCube(ABC):
    """Base class for all MemCube implementations."""

    @abstractmethod
    def __init__(self, config: BaseMemCubeConfig):
        """Initialize the MemCube with the given configuration."""
        self.text_mem: BaseTextMemory
        self.act_mem: BaseActMemory
        self.para_mem: BaseParaMemory
        self.pref_mem: BaseTextMemory

    @abstractmethod
    def load(self, dir: str) -> None:
        """Load memories from a directory."""

    @abstractmethod
    def dump(self, dir: str) -> None:
        """Dump memories to a directory."""
