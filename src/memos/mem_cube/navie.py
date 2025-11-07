import os

from typing import Literal

from memos.configs.utils import get_json_file_model_schema
from memos.exceptions import ConfigurationError, MemCubeError
from memos.log import get_logger
from memos.mem_cube.base import BaseMemCube
from memos.memories.activation.base import BaseActMemory
from memos.memories.parametric.base import BaseParaMemory
from memos.memories.textual.base import BaseTextMemory


logger = get_logger(__name__)


class NaiveMemCube(BaseMemCube):
    """MemCube is a box for loading and dumping three types of memories."""

    def __init__(
        self,
        text_mem: BaseTextMemory | None = None,
        pref_mem: BaseTextMemory | None = None,
        act_mem: BaseActMemory | None = None,
        para_mem: BaseParaMemory | None = None,
    ):
        """Initialize the MemCube with memory instances."""
        self._text_mem: BaseTextMemory = text_mem
        self._act_mem: BaseActMemory | None = act_mem
        self._para_mem: BaseParaMemory | None = para_mem
        self._pref_mem: BaseTextMemory | None = pref_mem

    def load(
        self,
        dir: str,
        memory_types: list[Literal["text_mem", "act_mem", "para_mem", "pref_mem"]] | None = None,
    ) -> None:
        """Load memories.
        Args:
            dir (str): The directory containing the memory files.
            memory_types (list[str], optional): List of memory types to load.
                If None, loads all available memory types.
                Options: ["text_mem", "act_mem", "para_mem", "pref_mem"]
        """
        loaded_schema = get_json_file_model_schema(os.path.join(dir, self.config.config_filename))
        if loaded_schema != self.config.model_schema:
            raise ConfigurationError(
                f"Configuration schema mismatch. Expected {self.config.model_schema}, "
                f"but found {loaded_schema}."
            )

        # If no specific memory types specified, load all
        if memory_types is None:
            memory_types = ["text_mem", "act_mem", "para_mem", "pref_mem"]

        # Load specified memory types
        if "text_mem" in memory_types and self.text_mem:
            self.text_mem.load(dir)
            logger.debug(f"Loaded text_mem from {dir}")

        if "act_mem" in memory_types and self.act_mem:
            self.act_mem.load(dir)
            logger.info(f"Loaded act_mem from {dir}")

        if "para_mem" in memory_types and self.para_mem:
            self.para_mem.load(dir)
            logger.info(f"Loaded para_mem from {dir}")

        if "pref_mem" in memory_types and self.pref_mem:
            self.pref_mem.load(dir)
            logger.info(f"Loaded pref_mem from {dir}")

        logger.info(f"MemCube loaded successfully from {dir} (types: {memory_types})")

    def dump(
        self,
        dir: str,
        memory_types: list[Literal["text_mem", "act_mem", "para_mem", "pref_mem"]] | None = None,
    ) -> None:
        """Dump memories.
        Args:
            dir (str): The directory where the memory files will be saved.
            memory_types (list[str], optional): List of memory types to dump.
                If None, dumps all available memory types.
                Options: ["text_mem", "act_mem", "para_mem", "pref_mem"]
        """
        if os.path.exists(dir) and os.listdir(dir):
            raise MemCubeError(
                f"Directory {dir} is not empty. Please provide an empty directory for dumping."
            )

        # Always dump config
        self.config.to_json_file(os.path.join(dir, self.config.config_filename))

        # If no specific memory types specified, dump all
        if memory_types is None:
            memory_types = ["text_mem", "act_mem", "para_mem", "pref_mem"]

        # Dump specified memory types
        if "text_mem" in memory_types and self.text_mem:
            self.text_mem.dump(dir)
            logger.info(f"Dumped text_mem to {dir}")

        if "act_mem" in memory_types and self.act_mem:
            self.act_mem.dump(dir)
            logger.info(f"Dumped act_mem to {dir}")

        if "para_mem" in memory_types and self.para_mem:
            self.para_mem.dump(dir)
            logger.info(f"Dumped para_mem to {dir}")

        if "pref_mem" in memory_types and self.pref_mem:
            self.pref_mem.dump(dir)
            logger.info(f"Dumped pref_mem to {dir}")

        logger.info(f"MemCube dumped successfully to {dir} (types: {memory_types})")

    @property
    def text_mem(self) -> "BaseTextMemory | None":
        """Get the textual memory."""
        if self._text_mem is None:
            logger.warning("Textual memory is not initialized. Returning None.")
        return self._text_mem

    @text_mem.setter
    def text_mem(self, value: BaseTextMemory) -> None:
        """Set the textual memory."""
        if not isinstance(value, BaseTextMemory):
            raise TypeError(f"Expected BaseTextMemory, got {type(value).__name__}")
        self._text_mem = value

    @property
    def act_mem(self) -> "BaseActMemory | None":
        """Get the activation memory."""
        if self._act_mem is None:
            logger.warning("Activation memory is not initialized. Returning None.")
        return self._act_mem

    @act_mem.setter
    def act_mem(self, value: BaseActMemory) -> None:
        """Set the activation memory."""
        if not isinstance(value, BaseActMemory):
            raise TypeError(f"Expected BaseActMemory, got {type(value).__name__}")
        self._act_mem = value

    @property
    def para_mem(self) -> "BaseParaMemory | None":
        """Get the parametric memory."""
        if self._para_mem is None:
            logger.warning("Parametric memory is not initialized. Returning None.")
        return self._para_mem

    @para_mem.setter
    def para_mem(self, value: BaseParaMemory) -> None:
        """Set the parametric memory."""
        if not isinstance(value, BaseParaMemory):
            raise TypeError(f"Expected BaseParaMemory, got {type(value).__name__}")
        self._para_mem = value

    @property
    def pref_mem(self) -> "BaseTextMemory | None":
        """Get the preference memory."""
        if self._pref_mem is None:
            logger.warning("Preference memory is not initialized. Returning None.")
        return self._pref_mem

    @pref_mem.setter
    def pref_mem(self, value: BaseTextMemory) -> None:
        """Set the preference memory."""
        if not isinstance(value, BaseTextMemory):
            raise TypeError(f"Expected BaseTextMemory, got {type(value).__name__}")
        self._pref_mem = value
