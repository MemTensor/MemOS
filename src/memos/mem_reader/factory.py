from typing import Any, ClassVar

from memos.configs.mem_reader import MemReaderConfigFactory
from memos.mem_reader.base import BaseMemReader
from memos.mem_reader.simple_struct import SimpleStructMemReader
from memos.memos_tools.singleton import singleton_factory


class MemReaderFactory(BaseMemReader):
    """Factory class for creating MemReader instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "simple_struct": SimpleStructMemReader,
    }

    @classmethod
    @singleton_factory()
    def from_config(cls, config_factory: MemReaderConfigFactory) -> BaseMemReader:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        reader_class = cls.backend_to_class[backend]
        return reader_class(config_factory.config)
