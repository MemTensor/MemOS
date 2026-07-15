import uuid

from typing import Any

from pydantic import Field, model_validator

from memos.configs.base import BaseConfig
from memos.configs.llm import LLMConfigFactory
from memos.configs.mem_reader import MemReaderConfigFactory
from memos.configs.mem_scheduler import SchedulerConfigFactory
from memos.configs.mem_user import UserManagerConfigFactory


class MOSConfig(BaseConfig):
    user_id: str = Field(
        default="root",
        description="User ID for the MOS. This is used to distinguish between different users' memories.",
    )
    session_id: str = Field(
        default=str(uuid.uuid4()),
        description="Session ID for the MOS. This is used to distinguish between different dialogue",
    )
    chat_model: LLMConfigFactory = Field(
        ...,
        default_factory=LLMConfigFactory,
        description="LLM configuration for the chat model in the MOS",
    )
    mem_reader: MemReaderConfigFactory = Field(
        ...,
        default_factory=MemReaderConfigFactory,
        description="MemReader configuration for the MOS",
    )
    mem_scheduler: SchedulerConfigFactory | None = Field(
        default=None,
        description="Memory scheduler configuration for managing memory operations",
    )
    user_manager: UserManagerConfigFactory = Field(
        default_factory=lambda: UserManagerConfigFactory(backend="sqlite", config={}),
        description="User manager configuration for database operations",
    )
    max_turns_window: int = Field(
        default=15,
        description="Maximum number of turns to keep in the conversation history",
    )
    top_k: int = Field(
        default=5,
        description="Maximum number of memories to retrieve for each query",
    )
    enable_textual_memory: bool = Field(
        default=True,
        description="Enable textual memory for the MemChat",
    )
    enable_activation_memory: bool = Field(
        default=False,
        description="Enable activation memory for the MemChat",
    )
    enable_parametric_memory: bool = Field(
        default=False,
        description="Enable parametric memory for the MemChat",
    )
    enable_preference_memory: bool = Field(
        default=False,
        description="Enable preference memory for the MemChat",
    )
    enable_mem_scheduler: bool = Field(
        default=False,
        description="Enable memory scheduler for automated memory management",
    )
    PRO_MODE: bool = Field(
        default=False,
        description="Enable PRO mode for complex query decomposition",
    )


class MemOSConfigFactory(BaseConfig):
    """Factory class for creating Memos configurations."""

    config: dict[str, Any] = Field(..., description="Configuration for the MemOS backend")

    @model_validator(mode="after")
    def create_config(self) -> "MemOSConfigFactory":
        self.config = MOSConfig(**self.config)
        return self
