from typing import Any, ClassVar

from memos.configs.memory import MemoryConfigFactory
from memos.memories.activation.base import BaseActMemory
from memos.memories.activation.kv import KVCacheMemory
from memos.memories.activation.vllmkv import VLLMKVCacheMemory
from memos.memories.base import BaseMemory
from memos.memories.parametric.base import BaseParaMemory
from memos.memories.parametric.lora import LoRAMemory
from memos.memories.textual.base import BaseTextMemory
from memos.memories.textual.general import GeneralTextMemory
from memos.memories.textual.naive import NaiveTextMemory
from memos.memories.textual.preference import PreferenceTextMemory
from memos.memories.textual.simple_preference import SimplePreferenceTextMemory
from memos.memories.textual.simple_tree import SimpleTreeTextMemory
from memos.memories.textual.tree import TreeTextMemory


class MemoryFactory(BaseMemory):
    """Factory class for creating memory instances."""

    backend_to_class: ClassVar[dict[str, Any]] = {
        "naive_text": NaiveTextMemory,
        "general_text": GeneralTextMemory,
        "tree_text": TreeTextMemory,
        "simple_tree_text": SimpleTreeTextMemory,
        "pref_text": PreferenceTextMemory,
        "simple_pref_text": SimplePreferenceTextMemory,
        "kv_cache": KVCacheMemory,
        "vllm_kv_cache": VLLMKVCacheMemory,
        "lora": LoRAMemory,
    }

    @classmethod
    def from_config(
        cls, config_factory: MemoryConfigFactory
    ) -> BaseTextMemory | BaseActMemory | BaseParaMemory:
        backend = config_factory.backend
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        memory_class = cls.backend_to_class[backend]
        return memory_class(config_factory.config)
