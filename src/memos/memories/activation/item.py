import uuid

from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from transformers import DynamicCache

from memos.mem_scheduler.utils.db_utils import get_utc_now


class ActivationMemoryItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    memory: Any
    metadata: dict = {}


class KVCacheRecords(BaseModel):
    text_memories: list[str] = Field(
        default=[],
        description="The list of text memories transformed to the activation memory.",
    )
    composed_text_memory: str = Field(
        default="",
        description="Single string combining all text_memories using assembly template",
    )
    timestamp: datetime = Field(
        default_factory=get_utc_now, description="submit time for schedule_messages"
    )


class KVCacheItem(ActivationMemoryItem):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    memory: DynamicCache = Field(
        default_factory=DynamicCache,
        description="Dynamic cache for storing key-value pairs in the memory.",
    )
    metadata: dict = Field(
        default_factory=dict, description="Metadata associated with the KV cache item."
    )

    model_config = ConfigDict(arbitrary_types_allowed=True)  # To allow DynamicCache as a field type
    records: KVCacheRecords = KVCacheRecords()


class VLLMKVCacheItem(KVCacheItem):
    """
    VLLM KV Cache Item that stores prompt strings instead of DynamicCache objects.
    This is because vLLM handles KV cache on the server side via preloading.
    """

    # Override memory field to store prompt string instead of DynamicCache
    memory: str = Field(
        default="",
        description="Prompt string used to preload KV cache in vLLM server",
    )
