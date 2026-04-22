from typing import Any, ClassVar

from pydantic import Field, field_validator, model_validator

from memos.configs.base import BaseConfig


class BaseAgentConfig(BaseConfig):
    """Base configuration class for agents."""

    agent_name: str = Field(..., description="Name of the agent")
    description: str | None = Field(default=None, description="Description of the agent")


class SimpleAgentConfig(BaseAgentConfig):
    """Simple agent configuration class."""

    max_iterations: int = Field(
        default=10, description="Maximum number of iterations for the agent"
    )
    timeout: int = Field(default=30, description="Timeout in seconds for agent execution")


class DeepSearchAgentConfig(BaseAgentConfig):
    """Deep search agent configuration class."""

    max_iterations: int = Field(default=3, description="Maximum number of iterations for the agent")
    timeout: int = Field(default=30, description="Timeout in seconds for agent execution")


class MemAgentConfigFactory(BaseConfig):
    """Factory class for creating agent configurations."""

    backend: str = Field(..., description="Backend for agent")
    config: dict[str, Any] = Field(..., description="Configuration for the agent backend")

    backend_to_class: ClassVar[dict[str, Any]] = {
        "simple": SimpleAgentConfig,
        "deep_search": DeepSearchAgentConfig,
    }

    @field_validator("backend")
    @classmethod
    def validate_backend(cls, backend: str) -> str:
        """Validate the backend field."""
        if backend not in cls.backend_to_class:
            raise ValueError(f"Invalid backend: {backend}")
        return backend

    @model_validator(mode="after")
    def create_config(self) -> "MemAgentConfigFactory":
        config_class = self.backend_to_class[self.backend]
        self.config = config_class(**self.config)
        return self
