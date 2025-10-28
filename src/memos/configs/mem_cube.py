import uuid

from pydantic import Field, field_validator

from memos.configs.base import BaseConfig
from memos.configs.memory import (
    MemoryConfigFactory,
)
from memos.exceptions import ConfigurationError
from memos.log import get_logger


logger = get_logger(__name__)


class BaseMemCubeConfig(BaseConfig):
    """Base configuration class for MemCube."""

    model_schema: str = Field(
        "NOT_SET",
        description="Schema for configuration. This value will be automatically set.",
        exclude=False,
    )

    config_filename: str = Field(
        "config.json",
        description="Filename for storing MemCube configuration",
    )


class GeneralMemCubeConfig(BaseMemCubeConfig):
    """General MemCube memory configuration class."""

    user_id: str = Field(
        "default_user",
        description="User ID for the MemCube. This is used to distinguish between different users' memories.",
    )
    cube_id: str = Field(
        str(uuid.uuid4()),
        description="Cube ID for the MemCube. This is used to distinguish between different MemCubes.",
    )
    text_mem: MemoryConfigFactory = Field(
        ...,
        default_factory=MemoryConfigFactory,
        description="Configuration for the textual memory",
    )
    act_mem: MemoryConfigFactory = Field(
        ...,
        default_factory=MemoryConfigFactory,
        description="Configuration for the activation memory",
    )
    para_mem: MemoryConfigFactory = Field(
        ...,
        default_factory=MemoryConfigFactory,
        description="Configuration for the parametric memory",
    )
    pref_mem: MemoryConfigFactory = Field(
        ...,
        default_factory=MemoryConfigFactory,
        description="Configuration for the preference memory",
    )

    @field_validator("text_mem")
    @classmethod
    def validate_text_mem(cls, text_mem: MemoryConfigFactory) -> MemoryConfigFactory:
        """Validate the text_mem field."""
        allowed_backends = ["naive_text", "general_text", "tree_text", "uninitialized"]
        if text_mem.backend not in allowed_backends:
            raise ConfigurationError(
                f"GeneralMemCubeConfig requires text_mem backend to be one of {allowed_backends}, got '{text_mem.backend}'"
            )
        return text_mem

    @field_validator("act_mem")
    @classmethod
    def validate_act_mem(cls, act_mem: MemoryConfigFactory) -> MemoryConfigFactory:
        """Validate the act_mem field."""
        allowed_backends = ["kv_cache", "vllm_kv_cache", "uninitialized"]
        if act_mem.backend not in allowed_backends:
            raise ConfigurationError(
                f"GeneralMemCubeConfig requires act_mem backend to be one of {allowed_backends}, got '{act_mem.backend}'"
            )
        return act_mem

    @field_validator("para_mem")
    @classmethod
    def validate_para_mem(cls, para_mem: MemoryConfigFactory) -> MemoryConfigFactory:
        """Validate the para_mem field."""
        allowed_backends = ["lora", "uninitialized"]
        if para_mem.backend not in allowed_backends:
            raise ConfigurationError(
                f"GeneralMemCubeConfig requires para_mem backend to be one of {allowed_backends}, got '{para_mem.backend}'"
            )
        return para_mem

    @field_validator("pref_mem")
    @classmethod
    def validate_pref_mem(cls, pref_mem: MemoryConfigFactory) -> MemoryConfigFactory:
        """Validate the pref_mem field."""
        allowed_backends = ["pref_text", "uninitialized"]
        if pref_mem.backend not in allowed_backends:
            raise ConfigurationError(
                f"GeneralMemCubeConfig requires pref_mem backend to be one of {allowed_backends}, got '{pref_mem.backend}'"
            )
        return pref_mem
